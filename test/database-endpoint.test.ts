import { afterEach, beforeEach, describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Test from "alchemy/Test/Bun";
import * as Scaleway from "../src/index.ts";
import { installScalewayMock, type ScalewayMock } from "./support/scaleway-mock.ts";
import { testProviders } from "./support/test-providers.ts";

const { test } = Test.make({ providers: testProviders() });

const endpointLayer = Scaleway.DatabaseEndpointProvider().pipe(
  Layer.provide(Scaleway.ScalewayClientsLive),
  Layer.provideMerge(
    Layer.succeed(
      Scaleway.ScalewayCredentials,
      Scaleway.ScalewayCredentials.of(Effect.succeed({
        secretKey: Redacted.make("test-secret"),
        accessKey: "test-access",
        region: "fr-par",
        apiUrl: "https://api.scaleway.com",
        projectId: "proj-test",
      })),
    ),
  ),
  Layer.orDie,
);

let mock: ScalewayMock;

beforeEach(() => {
  mock = installScalewayMock();
});
afterEach(() => {
  mock.restore();
});

const requests = (method: string, pattern: RegExp) =>
  mock.calls.filter((call) => call.method === method && pattern.test(new URL(call.url).pathname));
const endpointCreates = () => requests("POST", /^\/rdb\/v1\/regions\/fr-par\/instances\/[^/]+\/endpoints$/);
const endpointDeletes = () => requests("DELETE", /^\/rdb\/v1\/regions\/fr-par\/endpoints\/[^/]+$/);
const instanceDeletes = () => requests("DELETE", /^\/rdb\/v1\/regions\/fr-par\/instances\/[^/]+$/);
const bodyOf = (call: { body: string } | undefined) => JSON.parse(call?.body ?? "{}");

const database = (publicEndpoint?: boolean, nodeType = "db-dev-s") =>
  Scaleway.DatabaseInstance("Database", {
    engine: "PostgreSQL-16",
    nodeType,
    userName: "app",
    password: Redacted.make("S3cure-db-password!"),
    ...(publicEndpoint === undefined ? {} : { publicEndpoint }),
  });

const privateDatabase = (options: { publicEndpoint?: boolean; network?: "Lan" | "Other"; serviceIp?: string } = {}) =>
  Effect.gen(function* () {
    const lan = yield* Scaleway.PrivateNetwork("Lan", {});
    const other = yield* Scaleway.PrivateNetwork("Other", {});
    const db = yield* database(options.publicEndpoint);
    const endpoint = yield* Scaleway.DatabaseEndpoint("DatabaseLan", {
      instance: db,
      privateNetwork: options.network === "Other" ? other : lan,
      ...(options.serviceIp === undefined ? {} : { serviceIp: options.serviceIp }),
    });
    return { lan, other, db, endpoint };
  });

describe("DatabaseEndpoint", () => {
  test.provider("attaches an IPAM endpoint and keeps it on an unchanged redeploy", (stack) =>
    Effect.gen(function* () {
      const out = yield* stack.deploy(privateDatabase());

      expect(out.endpoint.endpointId).toMatch(/^rdbep-/);
      expect(out.endpoint.databaseInstanceId).toBe(out.db.databaseInstanceId);
      expect(out.endpoint.privateNetworkId).toBe(out.lan.privateNetworkId);
      expect(out.endpoint.provisioningMode).toBe("ipam");
      expect(out.endpoint.ip).toMatch(/^172\.16\./);
      expect(out.endpoint.port).toBe(5432);
      expect(endpointCreates()).toHaveLength(1);
      expect(bodyOf(endpointCreates()[0]).endpoint_spec).toEqual({
        private_network: { private_network_id: out.lan.privateNetworkId, ipam_config: {} },
      });

      const again = yield* stack.deploy(privateDatabase());

      expect(again.endpoint.endpointId).toBe(out.endpoint.endpointId);
      expect(endpointCreates()).toHaveLength(1);
      expect(endpointDeletes()).toHaveLength(0);
    }),
  );

  test.provider("replaces delete-first when the Private Network or static address changes", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(privateDatabase());
      const moved = yield* stack.deploy(privateDatabase({ network: "Other", serviceIp: "172.16.8.10/22" }));

      expect(moved.endpoint.endpointId).not.toBe(first.endpoint.endpointId);
      expect(moved.endpoint.privateNetworkId).toBe(moved.other.privateNetworkId);
      expect(moved.endpoint.ip).toBe("172.16.8.10");
      expect(moved.endpoint.provisioningMode).toBe("static");
      expect(bodyOf(endpointCreates()[1]).endpoint_spec).toEqual({
        private_network: { private_network_id: moved.other.privateNetworkId, service_ip: "172.16.8.10/22" },
      });
      const deleteIndex = mock.calls.indexOf(endpointDeletes()[0]!);
      const createIndex = mock.calls.indexOf(endpointCreates()[1]!);
      expect(deleteIndex).toBeGreaterThan(-1);
      expect(deleteIndex).toBeLessThan(createIndex);
      expect(instanceDeletes()).toHaveLength(0);
    }),
  );

  test.provider("follows a database instance replaced in the same deploy", (stack) =>
    Effect.gen(function* () {
      const program = (nodeType: string) =>
        Effect.gen(function* () {
          const lan = yield* Scaleway.PrivateNetwork("Lan", {});
          const db = yield* database(undefined, nodeType);
          const endpoint = yield* Scaleway.DatabaseEndpoint("DatabaseLan", { instance: db, privateNetwork: lan });
          return { db, endpoint };
        });
      const first = yield* stack.deploy(program("db-dev-s"));
      const second = yield* stack.deploy(program("db-dev-m"));

      expect(second.db.databaseInstanceId).not.toBe(first.db.databaseInstanceId);
      expect(second.endpoint.databaseInstanceId).toBe(second.db.databaseInstanceId);
      expect(second.endpoint.endpointId).not.toBe(first.endpoint.endpointId);
      expect(endpointCreates().map((call) => new URL(call.url).pathname).at(-1)).toBe(
        `/rdb/v1/regions/fr-par/instances/${second.db.databaseInstanceId}/endpoints`,
      );
      const third = yield* stack.deploy(program("db-dev-m"));
      expect(third.endpoint.endpointId).toBe(second.endpoint.endpointId);
    }),
  );

  test.provider("moves to a Private Network created in the same deploy", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const lan = yield* Scaleway.PrivateNetwork("Lan", {});
          const db = yield* database();
          return yield* Scaleway.DatabaseEndpoint("DatabaseLan", { instance: db, privateNetwork: lan });
        }),
      );
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const fresh = yield* Scaleway.PrivateNetwork("Fresh", {});
          const db = yield* database();
          const endpoint = yield* Scaleway.DatabaseEndpoint("DatabaseLan", { instance: db, privateNetwork: fresh });
          return { fresh, endpoint };
        }),
      );

      expect(second.endpoint.privateNetworkId).toBe(second.fresh.privateNetworkId);
      expect(second.endpoint.endpointId).not.toBe(first.endpointId);
      expect(endpointDeletes().map((call) => new URL(call.url).pathname)).toEqual([
        `/rdb/v1/regions/fr-par/endpoints/${first.endpointId}`,
      ]);
    }),
  );

  test.provider("destroying the endpoint keeps the retained database", (stack) =>
    Effect.gen(function* () {
      const out = yield* stack.deploy(privateDatabase());
      yield* stack.destroy();

      expect(endpointDeletes().map((call) => new URL(call.url).pathname)).toEqual([
        `/rdb/v1/regions/fr-par/endpoints/${out.endpoint.endpointId}`,
      ]);
      expect(instanceDeletes()).toHaveLength(0);
    }),
  );

  test.provider("waits out a busy instance and retries a transient-state refusal", (stack) =>
    Effect.gen(function* () {
      const db = yield* stack.deploy(database());
      mock.setDatabaseStatus(db.databaseInstanceId, "backuping", 2);
      mock.failNext(`/instances/${db.databaseInstanceId}/endpoints`, 409, "resource is in a transient state");

      const out = yield* stack.deploy(privateDatabase());

      expect(out.endpoint.privateNetworkId).toBe(out.lan.privateNetworkId);
      expect(endpointCreates()).toHaveLength(2);
      const firstCreate = mock.calls.indexOf(endpointCreates()[0]!);
      const instanceReads = requests("GET", new RegExp(`^/rdb/v1/regions/fr-par/instances/${db.databaseInstanceId}$`));
      expect(instanceReads.filter((call) => mock.calls.indexOf(call) < firstCreate).length).toBeGreaterThanOrEqual(3);
    }),
    { timeout: 20_000 },
  );

  test.provider("fails with the instance status when the database enters an error state", (stack) =>
    Effect.gen(function* () {
      const db = yield* stack.deploy(database());
      mock.setDatabaseStatus(db.databaseInstanceId, "error", 5);

      const result = yield* Effect.exit(stack.deploy(privateDatabase()));

      expect(result._tag).toBe("Failure");
      if (Exit.isFailure(result)) expect(String(result.cause)).toContain("DatabaseInstanceFailed");
      expect(endpointCreates()).toHaveLength(0);
    }),
  );

  test.provider("refuses an instance whose Private Network endpoint it does not own", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(privateDatabase());

      const result = yield* Effect.exit(stack.deploy(
        Effect.gen(function* () {
          const out = yield* privateDatabase();
          const second = yield* Scaleway.DatabaseEndpoint("DatabaseOther", { instance: out.db, privateNetwork: out.other });
          return { ...out, second };
        }),
      ));

      expect(result._tag).toBe("Failure");
      if (Exit.isFailure(result)) {
        expect(String(result.cause)).toContain("one Private Network endpoint per instance");
      }
      expect(endpointCreates()).toHaveLength(1);
    }),
  );

  test.provider("recovery read marks an existing endpoint as unowned", (stack) =>
    Effect.gen(function* () {
      const out = yield* stack.deploy(privateDatabase());
      const provider = yield* Scaleway.DatabaseEndpoint.Provider.pipe(Effect.provide(endpointLayer));
      const olds = { instance: out.db.databaseInstanceId, privateNetwork: out.lan.privateNetworkId };

      const recovered = yield* provider.read!({ id: "DatabaseLan", fqn: "DatabaseLan", instanceId: "test", olds, output: undefined });
      const elsewhere = yield* provider.read!({
        id: "DatabaseLan",
        fqn: "DatabaseLan",
        instanceId: "test",
        olds: { ...olds, privateNetwork: out.other.privateNetworkId },
        output: undefined,
      });

      const staticWanted = yield* provider.read!({
        id: "DatabaseLan",
        fqn: "DatabaseLan",
        instanceId: "test",
        olds: { ...olds, serviceIp: "172.16.8.10/22" },
        output: undefined,
      });

      expect(recovered !== undefined && Unowned.is(recovered)).toBe(true);
      expect(recovered?.endpointId).toBe(out.endpoint.endpointId);
      expect(elsewhere).toBeUndefined();
      expect(staticWanted).toBeUndefined();
    }),
  );
});

describe("DatabaseInstance publicEndpoint", () => {
  test.provider("removes and restores the public endpoint without touching the private one", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(privateDatabase({ publicEndpoint: false }));

      expect(created.db.publicEndpoint).toBe(false);
      expect(created.db.endpointIp).toBeUndefined();
      expect(created.db.endpointPort).toBeUndefined();
      expect(endpointDeletes()).toHaveLength(1);

      const endpointReads = () => requests("GET", new RegExp(`^/rdb/v1/regions/fr-par/endpoints/${created.endpoint.endpointId}$`)).length;
      const readsBefore = endpointReads();
      const restored = yield* stack.deploy(privateDatabase({ publicEndpoint: true }));

      expect(endpointReads()).toBe(readsBefore);

      expect(restored.db.publicEndpoint).toBe(true);
      expect(restored.db.endpointIp).toMatch(/^198\.51\.100\./);
      expect(restored.db.endpointIp).not.toBe(restored.endpoint.ip);
      expect(restored.endpoint.endpointId).toBe(created.endpoint.endpointId);
      expect(bodyOf(endpointCreates().at(-1)).endpoint_spec).toEqual({ load_balancer: {} });
    }),
  );

  test.provider("keeps the public endpoint by default", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(database());

      expect(created.publicEndpoint).toBe(true);
      expect(created.endpointPort).toBe(5432);
      expect(endpointCreates()).toHaveLength(0);
      expect(endpointDeletes()).toHaveLength(0);
    }),
  );
});
