import { afterEach, beforeEach, describe, expect, test as unitTest } from "bun:test";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const deployService = (env: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const namespace = yield* Scaleway.Namespace("Ns", {});
    const registry = yield* Scaleway.RegistryNamespace("Registry", { name: "demo-registry" });
    return yield* Scaleway.Service(
      "Api",
      { namespace, registry, main, env, minScale: 1, maxScale: 1, privacy: "public" },
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
      const builds = () => imageCommands.filter((command) => command.args[0] === "build").length;
      expect(builds()).toBe(1);

      const second = yield* stack.deploy(deployService());
      expect(second.codeHash).toBe(first.codeHash);
      expect(second.containerId).toBe(first.containerId);
      expect(builds()).toBe(1);

      yield* stack.deploy(deployService({ PLAIN: "changed" }));
      const patches = mock.calls.filter((call) => call.method === "PATCH" && call.url.includes("/containers/"));
      expect(JSON.parse(patches.at(-1)?.body ?? "{}").environment_variables.PLAIN).toBe("changed");
    }),
  );
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
});
