import { spawnSync } from "node:child_process";
import {
  databaseEndpointSmokeNames,
  OTHER_SERVICE_IP,
  type DatabaseEndpointSmokePhase,
} from "./scaleway-database-endpoint-smoke-stack.ts";

type Endpoint = {
  id: string;
  ip?: string;
  load_balancer?: object | null;
  private_network?: { private_network_id: string; service_ip?: string; provisioning_mode?: string } | null;
};
type Instance = { id: string; name: string; status?: string; endpoints?: Endpoint[] };
type PrivateNetwork = { id: string; name: string };

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (process.env.SCW_LIVE_DATABASE_ENDPOINT_TEST !== "1") {
  throw new Error("Set SCW_LIVE_DATABASE_ENDPOINT_TEST=1 to run the live Scaleway database endpoint smoke test");
}

const secretKey = required("SCW_SECRET_KEY");
const projectId = required("SCW_DEFAULT_PROJECT_ID");
const region = process.env.SCW_DEFAULT_REGION || "fr-par";
const apiUrl = process.env.SCW_API_URL ?? "https://api.scaleway.com";
const suffix = process.env.SCW_DATABASE_ENDPOINT_SMOKE_RUN_ID ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const stage = process.env.SCW_DATABASE_ENDPOINT_SMOKE_STAGE ?? `dbep-smoke-${suffix}`;
const prefix = process.env.SCW_DATABASE_ENDPOINT_SMOKE_PREFIX ?? `alchemy-dbep-${suffix}`;
const names = databaseEndpointSmokeNames(prefix);
const stackFile = "scripts/scaleway-database-endpoint-smoke-stack.ts";
const timings: Array<[string, number]> = [];

console.log(`database endpoint smoke stage=${stage} prefix=${prefix} region=${region}`);

function runAlchemy(command: "deploy" | "destroy", phase: DatabaseEndpointSmokePhase, label: string) {
  console.log(`alchemy ${command} ${label}`);
  const started = Date.now();
  const result = spawnSync("bun", ["alchemy", command, stackFile, "--stage", stage, "--yes"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ALCHEMY_TELEMETRY_DISABLED: process.env.ALCHEMY_TELEMETRY_DISABLED ?? "1",
      CI: process.env.CI ?? "1",
      SCW_DATABASE_ENDPOINT_SMOKE_PHASE: phase,
      SCW_DATABASE_ENDPOINT_SMOKE_PREFIX: prefix,
    },
  });
  timings.push([`${command} ${label}`, Date.now() - started]);
  if (result.status !== 0) {
    throw new Error(`alchemy ${command} ${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

async function scaleway<T>(method: "GET" | "DELETE", path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { Accept: "application/json", "X-Auth-Token": secretKey },
  });
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${await response.text()}`);
  return response.status === 204 ? (undefined as T) : await response.json() as T;
}

const query = (name: string) => `project_id=${projectId}&name=${encodeURIComponent(name)}&page_size=100`;

async function findInstance() {
  const { instances } = await scaleway<{ instances: Instance[] }>("GET", `/rdb/v1/regions/${region}/instances?${query(names.database)}`);
  return instances.find((instance) => instance.name === names.database);
}

async function findPrivateNetworks() {
  const found: PrivateNetwork[] = [];
  for (const name of [names.lan, names.other]) {
    const { private_networks } = await scaleway<{ private_networks: PrivateNetwork[] }>(
      "GET",
      `/vpc/v2/regions/${region}/private-networks?${query(name)}`,
    );
    found.push(...private_networks.filter((network) => network.name === name));
  }
  return found;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`smoke check failed: ${message}`);
  console.log(`ok - ${message}`);
}

async function observe() {
  const instance = await findInstance();
  if (!instance) throw new Error(`database ${names.database} not found`);
  const endpoints = instance.endpoints ?? [];
  const privateEndpoints = endpoints.filter((endpoint) => endpoint.private_network);
  const publicEndpoints = endpoints.filter((endpoint) => endpoint.load_balancer);
  const networks = Object.fromEntries((await findPrivateNetworks()).map((network) => [network.name, network.id]));
  console.log(`observed ${instance.id} status=${instance.status} endpoints=${JSON.stringify(endpoints)}`);
  return { instance, privateEndpoints, publicEndpoints, networks };
}

async function verifyDestroyed() {
  const instance = await findInstance();
  const networks = await findPrivateNetworks();
  return { instance, networks };
}

let failure: unknown;
try {
  runAlchemy("deploy", "private", "private");
  const first = await observe();
  check(first.instance.status === "ready", "database is ready after the private deploy");
  check(first.publicEndpoints.length === 0, "publicEndpoint: false removed the load-balancer endpoint");
  check(first.privateEndpoints.length === 1, "exactly one Private Network endpoint exists");
  const privateEndpoint = first.privateEndpoints[0]!;
  check(privateEndpoint.private_network?.private_network_id === first.networks[names.lan], "endpoint is on the Lan network");
  check(privateEndpoint.private_network?.provisioning_mode === "ipam", "endpoint address comes from IPAM");

  runAlchemy("deploy", "private", "private (unchanged)");
  const again = await observe();
  check(again.instance.id === first.instance.id, "unchanged redeploy keeps the database");
  check(again.privateEndpoints[0]?.id === privateEndpoint.id, "unchanged redeploy keeps the endpoint");

  runAlchemy("deploy", "public", "public");
  const restored = await observe();
  check(restored.publicEndpoints.length === 1, "publicEndpoint: true restored the load-balancer endpoint");
  check(restored.privateEndpoints[0]?.id === privateEndpoint.id, "restoring the public endpoint keeps the private endpoint");

  runAlchemy("deploy", "moved", "moved");
  const moved = await observe();
  check(moved.instance.id === first.instance.id, "moving the endpoint keeps the database");
  check(moved.privateEndpoints.length === 1, "still exactly one Private Network endpoint");
  const movedEndpoint = moved.privateEndpoints[0]!;
  check(movedEndpoint.id !== privateEndpoint.id, "the endpoint was replaced");
  check(movedEndpoint.private_network?.private_network_id === moved.networks[names.other], "endpoint moved to the Other network");
  check(movedEndpoint.private_network?.service_ip === OTHER_SERVICE_IP, "endpoint uses the static service IP");
  check(moved.publicEndpoints.length === 1, "the public endpoint survives the move");
} catch (error) {
  failure = error;
} finally {
  try {
    runAlchemy("destroy", "moved", "destroy");
  } catch (error) {
    failure ??= error;
  }
}

const leftovers = await verifyDestroyed().catch((error: unknown) => {
  console.error(`could not check for leaked resources: ${String(error)}`);
  failure ??= error;
  return { instance: undefined, networks: [] };
});
if (failure) console.error(`smoke failure: ${failure instanceof Error ? failure.message : String(failure)}`);
if (leftovers.instance) console.error(`leaked database ${leftovers.instance.id} (${leftovers.instance.status})`);
for (const network of leftovers.networks) console.error(`leaked private network ${network.id} (${network.name})`);

console.log("timings:");
for (const [label, ms] of timings) console.log(`  ${label}: ${(ms / 1000).toFixed(1)}s`);

if (leftovers.instance || leftovers.networks.length > 0) {
  throw new Error(
    "database endpoint smoke left resources behind; rerun `bun alchemy destroy " +
      `${stackFile} --stage ${stage} --yes` + "` with the same SCW_DATABASE_ENDPOINT_SMOKE_PREFIX to clean up",
  );
}
if (failure) throw failure;
console.log("database endpoint smoke test passed");
