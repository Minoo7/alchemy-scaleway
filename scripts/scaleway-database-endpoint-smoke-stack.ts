import * as Alchemy from "alchemy";
import { destroy } from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Scaleway from "../src/index.ts";

export type DatabaseEndpointSmokePhase = "private" | "public" | "moved";

const phase = (process.env.SCW_DATABASE_ENDPOINT_SMOKE_PHASE ?? "private") as DatabaseEndpointSmokePhase;
const prefix = process.env.SCW_DATABASE_ENDPOINT_SMOKE_PREFIX ?? "alchemy-dbep-smoke";
const tags = ["alchemy-smoke-test", `alchemy-dbep-smoke=${prefix}`];
const password = Redacted.make(`AlchemySmokeDb1!${prefix.replace(/[^A-Za-z0-9]/g, "").slice(0, 32) || "default"}`);

export const databaseEndpointSmokeNames = (smokePrefix: string) => ({
  database: `${smokePrefix}-db`,
  lan: `${smokePrefix}-lan`,
  other: `${smokePrefix}-other`,
});
export const OTHER_SUBNET = "172.16.64.0/22";
export const OTHER_SERVICE_IP = "172.16.64.10/22";

const names = databaseEndpointSmokeNames(prefix);

export default Alchemy.Stack(
  "alchemy-scaleway-database-endpoint-smoke",
  {
    providers: Scaleway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const lan = yield* Scaleway.PrivateNetwork("Lan", { name: names.lan, tags }).pipe(destroy());
    const other = phase === "moved"
      ? yield* Scaleway.PrivateNetwork("Other", { name: names.other, tags, subnets: [OTHER_SUBNET] }).pipe(destroy())
      : undefined;
    const database = yield* Scaleway.DatabaseInstance("Database", {
      name: names.database,
      engine: "PostgreSQL-16",
      nodeType: "db-dev-s",
      userName: "smoke",
      password,
      tags,
      publicEndpoint: phase !== "private",
    }).pipe(destroy());
    const endpoint = yield* Scaleway.DatabaseEndpoint("DatabaseEndpoint", other
      ? { instance: database, privateNetwork: other, serviceIp: OTHER_SERVICE_IP }
      : { instance: database, privateNetwork: lan });

    return {
      databaseInstanceId: database.databaseInstanceId,
      publicEndpoint: database.publicEndpoint,
      endpointIp: database.endpointIp,
      privateEndpointId: endpoint.endpointId,
      privateIp: endpoint.ip,
      privateNetworkId: endpoint.privateNetworkId,
    };
  }),
);
