import { afterEach, beforeEach, describe, expect, test as unitTest } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as Output from "alchemy/Output";
import { packEnvValue } from "alchemy/RuntimeContext";
import * as Test from "alchemy/Test/Bun";
import * as Scaleway from "../src/index.ts";
import { installScalewayMock, type ScalewayMock } from "./support/scaleway-mock.ts";
import { testProviders } from "./support/test-providers.ts";

const { test } = Test.make({ providers: testProviders() });
const main = join(import.meta.dir, "fixtures", "service", "main.ts");

let mock: ScalewayMock;
let pushes: Scaleway.LayeredImageRequest[];
let installs: string[];

const fakeImageEngine: Scaleway.ServiceImageEngine = {
  install: (directory) =>
    Effect.sync(() => {
      installs.push(directory);
      mkdirSync(join(directory, "node_modules", "effect"), { recursive: true });
      writeFileSync(join(directory, "node_modules", "effect", "index.js"), "installed");
    }),
  push: (request) =>
    Effect.sync(() => {
      pushes.push(request);
      return { digest: `sha256:${request.layer.digest.slice(7, 19)}${"0".repeat(52)}` };
    }),
};

beforeEach(() => {
  mock = installScalewayMock();
  pushes = [];
  installs = [];
  process.env.SERVICE_FIXTURE_TOKEN = "fixture-secret";
  process.env.SERVICE_FIXTURE_REGION = "fr-par";
  Scaleway.setServiceImageEngine(fakeImageEngine);
});

afterEach(() => {
  Scaleway.resetServiceImageEngine();
  delete process.env.SERVICE_FIXTURE_TOKEN;
  delete process.env.SERVICE_FIXTURE_REGION;
  mock.restore();
});

const containerCreates = () =>
  mock.calls.filter((call) => call.method === "POST" && new URL(call.url).pathname.endsWith("/containers"));

const builds = () => pushes;

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/\0[\s\S]*$/, "");

/** Path → content of every entry in a gzipped tar layer, following PAX `path` records. */
const layerFiles = (data: Uint8Array) => {
  const tar = gunzipSync(data);
  const files = new Map<string, string>();
  let paxPath: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || "0", 8);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (String.fromCharCode(header[156]!) === "x") {
      paxPath = /\d+ path=(.*)\n/.exec(new TextDecoder().decode(body))?.[1];
    } else {
      files.set(paxPath ?? text(header.subarray(0, 100)), new TextDecoder().decode(body));
      paxPath = undefined;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
};
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

      expect(pushes).toHaveLength(1);
      const push = pushes[0]!;
      expect(push.base).toBe("node:24-slim");
      expect(push.destination).toBe("rg.fr-par.scw.cloud/demo-registry/api");
      expect(push.destTags).toEqual([service.imageRef.split(":").at(-1)!, "service"]);
      expect(push.destAuth).toEqual({ username: "nologin", password: "test-secret" });
      expect(push.platform).toEqual({ os: "linux", architecture: "amd64" });
      expect(push.config).toEqual(Scaleway.serviceImageConfig(8080));
      expect(service.imageDigest).toBe(`sha256:${push.layer.digest.slice(7, 19)}${"0".repeat(52)}`);
      const files = layerFiles(push.layer.data);
      expect(files.get("app/index.mjs")).toContain("Hetzner service");
      expect(files.has("app/Dockerfile")).toBe(false);
      expect(installs).toHaveLength(0);

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

  test.provider("installs build.install packages into the image layer", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(deployService({}, { build: { install: ["effect"] } }));

      expect(installs).toHaveLength(1);
      const files = layerFiles(pushes[0]!.layer.data);
      expect(JSON.parse(files.get("app/package.json")!).dependencies.effect).toMatch(/^\d/);
      expect(files.get("app/node_modules/effect/index.js")).toBe("installed");
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

  test.provider("a failed image push fails the deploy before any container exists", (stack) =>
    Effect.gen(function* () {
      Scaleway.setServiceImageEngine({
        ...fakeImageEngine,
        push: () => Effect.fail(new Error("registry push failed")),
      });

      const exit = yield* Effect.exit(stack.deploy(deployService()));

      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("registry push failed");
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

describe("serviceImageConfig", () => {
  unitTest("runs the bundled entry from /app on the service port", () => {
    expect(Scaleway.serviceImageConfig(3000)).toEqual({
      env: { PORT: "3000", HOST: "0.0.0.0", NODE_ENV: "production" },
      workingDir: "/app",
      entrypoint: ["node", "/app/index.mjs"],
      cmd: null,
      exposedPorts: ["3000/tcp"],
    });
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
