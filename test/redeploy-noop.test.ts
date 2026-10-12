import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Test from "alchemy/Test/Bun";
import * as Scaleway from "../src/index.ts";
import type { Providers } from "../src/Providers.ts";
import { installScalewayMock, type ScalewayMock } from "./support/scaleway-mock.ts";
import { testProviders } from "./support/test-providers.ts";

const { test } = Test.make({ providers: testProviders() });

let mock: ScalewayMock;
let scratch: string;

beforeEach(() => {
  mock = installScalewayMock();
  scratch = mkdtempSync(join(tmpdir(), "alchemy-scaleway-noop-"));
});
afterEach(() => {
  mock.restore();
  rmSync(scratch, { recursive: true, force: true });
});

const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const functionZip = () => {
  const zipPath = join(scratch, "function.zip");
  writeFileSync(zipPath, "zip-bytes");
  return zipPath;
};
const password = () => Redacted.make("S3cure-db-password!");

const cases: Record<string, () => Effect.Effect<unknown, never, Providers>> = {
  Project: () => Scaleway.Project("AppProject", { organizationId: "org-test" }),
  Namespace: () => Scaleway.Namespace("Ns", {}),
  Container: () =>
    Effect.gen(function* () {
      const namespace = yield* Scaleway.Namespace("Ns", {});
      return yield* Scaleway.Container("Api", { namespace, image: "rg.fr-par.scw.cloud/demo/api:latest" });
    }),
  Trigger: () =>
    Effect.gen(function* () {
      const namespace = yield* Scaleway.Namespace("Ns", {});
      const container = yield* Scaleway.Container("Api", { namespace, image: "rg.fr-par.scw.cloud/demo/api:latest" });
      return yield* Scaleway.Trigger("Hourly", { container, source: { type: "cron", schedule: "0 * * * *" } });
    }),
  Domain: () =>
    Effect.gen(function* () {
      const namespace = yield* Scaleway.Namespace("Ns", {});
      const container = yield* Scaleway.Container("Api", { namespace, image: "rg.fr-par.scw.cloud/demo/api:latest" });
      return yield* Scaleway.Domain("Domain", { container, hostname: "api.example.com" });
    }),
  FunctionNamespace: () => Scaleway.FunctionNamespace("FnNs", {}),
  Function: () =>
    Effect.gen(function* () {
      const namespace = yield* Scaleway.FunctionNamespace("FnNs", {});
      return yield* Scaleway.Function("Fn", { namespace, runtime: "node20", handler: "handler.handle", source: { zipPath: functionZip() } });
    }),
  FunctionCron: () =>
    Effect.gen(function* () {
      const namespace = yield* Scaleway.FunctionNamespace("FnNs", {});
      const fn = yield* Scaleway.Function("Fn", { namespace, runtime: "node20", handler: "handler.handle", source: { zipPath: functionZip() } });
      return yield* Scaleway.FunctionCron("Cron", { function: fn, schedule: "0 * * * *" });
    }),
  FunctionDomain: () =>
    Effect.gen(function* () {
      const namespace = yield* Scaleway.FunctionNamespace("FnNs", {});
      const fn = yield* Scaleway.Function("Fn", { namespace, runtime: "node20", handler: "handler.handle", source: { zipPath: functionZip() } });
      return yield* Scaleway.FunctionDomain("Domain", { function: fn, hostname: "fn.example.com" });
    }),
  DnsZone: () => Scaleway.DnsZone("Zone", { domain: "example.test", subdomain: "app" }),
  DnsRecord: () =>
    Effect.gen(function* () {
      const zone = yield* Scaleway.DnsZone("Zone", { domain: "example.test", subdomain: "app" });
      return yield* Scaleway.DnsRecord("Www", { zone, name: "www", type: "A", records: ["192.0.2.10"] });
    }),
  RegistryNamespace: () => Scaleway.RegistryNamespace("Registry", {}),
  Secret: () => Scaleway.Secret("ApiSecret", { value: Redacted.make("super-secret") }),
  DatabaseInstance: () =>
    Scaleway.DatabaseInstance("Database", { engine: "PostgreSQL-16", nodeType: "db-dev-s", userName: "app", password: password() }),
  DatabaseEndpoint: () =>
    Effect.gen(function* () {
      const privateNetwork = yield* Scaleway.PrivateNetwork("Lan", {});
      const instance = yield* Scaleway.DatabaseInstance("Database", {
        engine: "PostgreSQL-16",
        nodeType: "db-dev-s",
        userName: "app",
        password: password(),
        publicEndpoint: false,
      });
      return yield* Scaleway.DatabaseEndpoint("DatabaseLan", { instance, privateNetwork });
    }),
  Bucket: () => Scaleway.Bucket("Bucket", {}),
  Vpc: () => Scaleway.Vpc("Network", {}),
  PrivateNetwork: () => Scaleway.PrivateNetwork("Lan", {}),
  VpcAcl: () =>
    Effect.gen(function* () {
      const vpc = yield* Scaleway.Vpc("Network", {});
      return yield* Scaleway.VpcAcl("Acl", { vpc, defaultPolicy: "drop" });
    }),
  VpcRoute: () =>
    Effect.gen(function* () {
      const vpc = yield* Scaleway.Vpc("Network", { routing: true });
      const privateNetwork = yield* Scaleway.PrivateNetwork("Lan", { vpc });
      return yield* Scaleway.VpcRoute("Route", { vpc, destination: "10.90.0.0/24", nextHop: { type: "privateNetwork", privateNetwork } });
    }),
  VpcConnector: () =>
    Effect.gen(function* () {
      const vpc = yield* Scaleway.Vpc("Network", {});
      const target = yield* Scaleway.Vpc("Target", {});
      return yield* Scaleway.VpcConnector("Connector", { vpc, targetVpc: target });
    }),
  Instance: () => Scaleway.Instance("App", { commercialType: "DEV1-S", image: "ubuntu_jammy" }),
  SecurityGroup: () => Scaleway.SecurityGroup("Firewall", {}),
  FlexibleIp: () => Scaleway.FlexibleIp("PublicIp", {}),
  PrivateNic: () =>
    Effect.gen(function* () {
      const server = yield* Scaleway.Instance("App", { commercialType: "DEV1-S", image: "ubuntu_jammy" });
      const privateNetwork = yield* Scaleway.PrivateNetwork("Lan", {});
      return yield* Scaleway.PrivateNic("Nic", { serverId: server.serverId, privateNetwork });
    }),
};

const knownRedeployWrites: Record<string, string> = {
  Secret: "diff returns update when nothing changed (8638b20, reason unrecorded); remove this entry when Secret noops",
};

const notCovered: Record<string, string> = {
  ContainerImage: "builds through the injected Docker command runner",
  ContainerImageMirror: "copies through the injected registry copy engine",
  InstanceKnownHosts: "scans SSH host keys through the injected scanner",
};

const exportedResources = Object.entries(Scaleway)
  .filter(([, value]) => typeof value === "function" && "Provider" in value && "Type" in value)
  .map(([name]) => name)
  .sort();

describe("unchanged redeploy coverage", () => {
  it("every exported resource has a redeploy case or a reason it has none", () => {
    expect(exportedResources.filter((name) => !(name in cases) && !(name in notCovered))).toEqual([]);
    expect(Object.keys(notCovered).filter((name) => name in cases)).toEqual([]);
  });
});

describe("unchanged redeploy", () => {
  for (const [resource, program] of Object.entries(cases)) {
    const known = knownRedeployWrites[resource];
    const title = known
      ? `${resource} still writes on an unchanged redeploy (known: ${known})`
      : `${resource} with minimal props writes nothing on an unchanged redeploy`;
    test.provider(title, (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(program());
        const firstDeployCalls = mock.calls.length;

        yield* stack.deploy(program());

        const writes = mock.calls
          .slice(firstDeployCalls)
          .filter((call) => writeMethods.has(call.method))
          .map((call) => `${call.method} ${new URL(call.url).pathname}`);
        if (known) expect(writes).not.toEqual([]);
        else expect(writes).toEqual([]);
      }),
    );
  }
});
