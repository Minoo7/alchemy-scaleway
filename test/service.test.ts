import { afterEach, beforeEach, describe, expect, test as unitTest } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Output from "alchemy/Output";
import { packEnvValue } from "alchemy/RuntimeContext";
import * as Test from "alchemy/Test/Bun";
import * as Scaleway from "../src/index.ts";
import { installScalewayMock, type ScalewayMock } from "./support/scaleway-mock.ts";
import { testProviders } from "./support/test-providers.ts";

const { test } = Test.make({ providers: testProviders() });
const main = join(import.meta.dir, "fixtures", "service", "main.ts");

let mock: ScalewayMock;
let imageCommands: Scaleway.ContainerImageCommand[];

beforeEach(() => {
  mock = installScalewayMock();
  imageCommands = [];
  process.env.SERVICE_FIXTURE_TOKEN = "fixture-secret";
  process.env.SERVICE_FIXTURE_REGION = "fr-par";
  Scaleway.setContainerImageCommandRunner((command) =>
    Effect.sync(() => {
      imageCommands.push(command);
    }),
  );
});

afterEach(() => {
  Scaleway.resetContainerImageCommandRunner();
  delete process.env.SERVICE_FIXTURE_TOKEN;
  delete process.env.SERVICE_FIXTURE_REGION;
  mock.restore();
});

const containerCreates = () =>
  mock.calls.filter((call) => call.method === "POST" && new URL(call.url).pathname.endsWith("/containers"));

const builds = () => imageCommands.filter((command) => command.args[0] === "build");
const containerPatches = () =>
  mock.calls.filter((call) => call.method === "PATCH" && call.url.includes("/containers/"));

const deployService = (env: Record<string, unknown> = {}, extra: Partial<Scaleway.ServiceProps> = {}) =>
  Effect.gen(function* () {
    const namespace = yield* Scaleway.Namespace("Ns", {});
    const registry = yield* Scaleway.RegistryNamespace("Registry", { name: "demo-registry" });
    return yield* Scaleway.Service(
      "Api",
      { namespace, registry, main, env, minScale: 1, maxScale: 1, privacy: "public", ...extra },
      Effect.gen(function* () {
        yield* Config.Redacted("SERVICE_FIXTURE_TOKEN");
        yield* Config.String("SERVICE_FIXTURE_REGION");
        return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
      }),
    );
  });

describe("Service", () => {
  test.provider("bundles the program into a registry image and deploys it as a container", (stack) =>
    Effect.gen(function* () {
      const service = yield* stack.deploy(deployService({ PLAIN: "visible", TOKEN: Redacted.make("hidden") }));

      expect(service.imageRef).toMatch(/^rg\.fr-par\.scw\.cloud\/demo-registry\/api:service-[a-f0-9]{12}$/);
      expect(service.codeHash).toMatch(/^[a-f0-9]{16}$/);
      expect(service.url).toContain(".functions.fnc.fr-par.scw.cloud");

      const build = imageCommands.find((command) => command.args[0] === "build");
      const context = build?.args.at(-1) ?? "";
      const dockerfile = readFileSync(join(context, "Dockerfile"), "utf8");
      expect(dockerfile).toContain("FROM node:24-slim");
      expect(dockerfile).toContain('ENTRYPOINT ["node", "/app/index.mjs"]');
      expect(build?.args).toContain("linux/amd64");
      const entry = readFileSync(join(context, "index.mjs"), "utf8");
      expect(entry).toContain("Hetzner service");
      expect(imageCommands.filter((command) => command.args[0] === "push")).toHaveLength(2);

      const body = JSON.parse(containerCreates().at(0)?.body ?? "{}");
      expect(body.image).toBe(service.imageRef);
      expect(body.port).toBe(8080);
      expect(body.min_scale).toBe(1);
      expect(body.max_scale).toBe(1);
      expect(body.environment_variables).toMatchObject({
        ALCHEMY_PHASE: "runtime",
        PLAIN: "visible",
        PORT: "8080",
      });
      expect(body.environment_variables.ALCHEMY_STACK_NAME).toBeString();
      expect(body.environment_variables).not.toHaveProperty("TOKEN");
      expect(body.environment_variables).not.toHaveProperty("SERVICE_FIXTURE_TOKEN");
      expect(body.secret_environment_variables.TOKEN).toBe("hidden");
      expect(JSON.parse(body.secret_environment_variables.SERVICE_FIXTURE_TOKEN)).toEqual({
        _tag: "Redacted",
        value: "fixture-secret",
      });
      expect(JSON.parse(body.secret_environment_variables.SERVICE_FIXTURE_REGION)).toEqual({
        _tag: "Redacted",
        value: "fr-par",
      });
    }),
  );

  test.provider("redeploys only when the program or its props change", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(deployService());
      expect(builds()).toHaveLength(1);

      const second = yield* stack.deploy(deployService());
      expect(second.codeHash).toBe(first.codeHash);
      expect(second.containerId).toBe(first.containerId);
      expect(builds()).toHaveLength(1);

      yield* stack.deploy(deployService({ PLAIN: "changed" }));
      expect(JSON.parse(containerPatches().at(-1)?.body ?? "{}").environment_variables.PLAIN).toBe("changed");
    }),
  );

  test.provider("rebuilds and redeploys when only bundled file contents change", (stack) =>
    Effect.gen(function* () {
      const assets = mkdtempSync(join(tmpdir(), "service-assets-"));
      writeFileSync(join(assets, "page.html"), "first");
      const extraFiles = [{ source: assets, dest: "public" }];

      const first = yield* stack.deploy(deployService({}, { extraFiles }));
      writeFileSync(join(assets, "page.html"), "second");
      const second = yield* stack.deploy(deployService({}, { extraFiles }));

      expect(second.codeHash).not.toBe(first.codeHash);
      expect(second.imageRef).not.toBe(first.imageRef);
      expect(second.containerId).toBe(first.containerId);
      expect(builds()).toHaveLength(2);
      expect(JSON.parse(containerPatches().at(-1)?.body ?? "{}").image).toBe(second.imageRef);
    }),
  );

  test.provider("rotating a secret value redeploys without rebuilding", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(deployService({ TOKEN: Redacted.make("first") }));
      yield* stack.deploy(deployService({ TOKEN: Redacted.make("second") }));

      expect(builds()).toHaveLength(1);
      expect(JSON.parse(containerPatches().at(-1)?.body ?? "{}").secret_environment_variables.TOKEN).toBe("second");
    }),
  );

  test.provider("a failed image build fails the deploy before any container exists", (stack) =>
    Effect.gen(function* () {
      Scaleway.setContainerImageCommandRunner((command) =>
        command.args[0] === "build" ? Effect.fail(new Error("docker build failed")) : Effect.void,
      );

      const exit = yield* Effect.exit(stack.deploy(deployService()));

      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("docker build failed");
      expect(containerCreates()).toHaveLength(0);
    }),
  );

  test.provider("destroy deletes the container and retains the pushed image", (stack) =>
    Effect.gen(function* () {
      const service = yield* stack.deploy(deployService());
      yield* stack.destroy();

      const deletes = mock.calls.filter((call) => call.method === "DELETE").map((call) => new URL(call.url).pathname);
      expect(deletes).toContain(`/containers/v1/regions/fr-par/containers/${service.containerId}`);
      expect(deletes.filter((path) => /\/registry\/v1\/regions\/[^/]+\/(images|tags)\//.test(path))).toEqual([]);
    }),
  );

  test.provider("read returns the deployed service and ignores a removed container", (stack) =>
    Effect.gen(function* () {
      const service = yield* stack.deploy(deployService());
      const provider = yield* Scaleway.Service.Provider.pipe(Effect.provide(Scaleway.ServiceProvider().pipe(Layer.provide(Scaleway.ScalewayClientsLive))));
      const olds: Scaleway.ServiceProps = {
        namespace: service.namespaceId,
        registry: "rg.fr-par.scw.cloud/demo-registry",
        main,
        minScale: 1,
        maxScale: 1,
        privacy: "public",
      };

      const read = yield* provider.read!({ id: "Api", fqn: "Api", instanceId: "test", olds, output: service });
      expect(read?.containerId).toBe(service.containerId);
      expect(read?.imageRef).toBe(service.imageRef);
      expect(read?.codeHash).toBe(service.codeHash);

      mock.removeContainer(service.containerId);
      const missing = yield* provider.read!({ id: "Api", fqn: "Api", instanceId: "test", olds, output: service });
      expect(missing).toBeUndefined();
    }),
  );
});

const ModuleNamespace = Scaleway.Namespace("ModuleNs", {});
const ModuleRegistry = Scaleway.RegistryNamespace("ModuleRegistry", { name: "module-registry" });

class ModuleApi extends Scaleway.Service<ModuleApi>()(
  "ModuleApi",
  {
    namespace: ModuleNamespace,
    registry: ModuleRegistry,
    main,
    env: {
      REGISTRY_ID: Effect.map(ModuleRegistry, (registry) =>
        Output.interpolate`registry:${registry.registryNamespaceId}`.pipe(Output.map(Redacted.make)),
      ),
    },
  },
  Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("ok")) }),
) {}

describe("Service with module-scope resources", () => {
  test.provider("resolves Effect-valued namespace, registry and env at plan time", (stack) =>
    Effect.gen(function* () {
      const service = yield* stack.deploy(ModuleApi);
      expect(service.imageRef).toMatch(/^rg\.fr-par\.scw\.cloud\/module-registry\/moduleapi:service-/);
      const body = JSON.parse(containerCreates().at(0)?.body ?? "{}");
      expect(body.secret_environment_variables.REGISTRY_ID).toMatch(/^registry:/);
      expect(body.environment_variables).not.toHaveProperty("REGISTRY_ID");
    }),
  );
});

describe("generateServiceDockerfile", () => {
  unitTest("installs, copies chunks and deduplicates extra files only when needed", () => {
    const minimal = Scaleway.generateServiceDockerfile({}, false, false);
    expect(minimal).not.toContain("npm install");
    expect(minimal).not.toContain("COPY *.js");
    expect(minimal).toContain("ENV PORT=8080");

    const full = Scaleway.generateServiceDockerfile(
      {
        image: "node:24-alpine",
        port: 3000,
        extraFiles: [
          { source: "a", dest: "public" },
          { source: "b", dest: "public" },
          { source: "c", dest: "." },
        ],
      },
      true,
      true,
    );
    expect(full.split("\n").slice(0, 4)).toEqual([
      "FROM node:24-alpine",
      "WORKDIR /app",
      "COPY package.json /app/package.json",
      "RUN npm install --omit=dev --no-fund --no-audit",
    ]);
    expect(full).toContain("COPY *.js /app/");
    expect(full.match(/COPY public /g)).toHaveLength(1);
    expect(full).not.toContain("COPY . ");
    expect(full).toContain("EXPOSE 3000");
  });
});

describe("splitServiceEnvironment", () => {
  unitTest("keeps plain values plain and routes Redacted and packed secrets to secrets", () => {
    const split = Scaleway.splitServiceEnvironment({
      A: "plain",
      B: Redacted.make("secret"),
      C: JSON.stringify({ _tag: "Redacted", value: "bound" }),
      D: 3,
      E: undefined,
    });
    expect(split.environmentVariables).toEqual({ A: "plain", D: "3" });
    expect(Object.keys(split.secretEnvironmentVariables).sort()).toEqual(["B", "C"]);
    expect(Redacted.value(split.secretEnvironmentVariables.B!)).toBe("secret");
  });

  unitTest("treats only packEnvValue's Redacted marker as a secret", () => {
    const split = Scaleway.splitServiceEnvironment({
      PACKED: packEnvValue(Redacted.make("bound")),
      PACKED_PLAIN: packEnvValue("123"),
      LOOKALIKE: '{"_tag":"Redactedish","value":"x"}',
      FLAG: true,
      OBJECT: { a: 1 },
      NOTHING: null,
    });
    expect(split.environmentVariables).toEqual({
      PACKED_PLAIN: '"123"',
      LOOKALIKE: '{"_tag":"Redactedish","value":"x"}',
      FLAG: "true",
      OBJECT: '{"a":1}',
    });
    expect(Object.keys(split.secretEnvironmentVariables)).toEqual(["PACKED"]);
  });
});
