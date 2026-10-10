/**
 * Live smoke test for `Scaleway.Service`. Gated by SCW_LIVE_SERVICE_TEST=1.
 *
 *   op run --environment <alchemy-scaleway-production> -- \
 *     SCW_LIVE_SERVICE_TEST=1 bun run scripts/scaleway-service-smoke.ts
 *
 * Deploys scripts/smoke-service/main.ts as a Service (bundle, daemonless
 * image push to a temporary registry namespace, Serverless Container),
 * fetches it until it answers with its bound secret and plain env value,
 * redeploys unchanged, then destroys the stack and fails on leaked containers.
 * Needs no Docker daemon; npm is only used when `build.install` is set.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (process.env.SCW_LIVE_SERVICE_TEST !== "1") {
  throw new Error("Set SCW_LIVE_SERVICE_TEST=1 to run the live Scaleway Service smoke test");
}

const secretKey = required("SCW_SECRET_KEY");
required("SCW_DEFAULT_PROJECT_ID");

const region = process.env.SCW_DEFAULT_REGION || "fr-par";
const apiUrl = process.env.SCW_API_URL ?? "https://api.scaleway.com";
const suffix = process.env.SCW_SERVICE_SMOKE_RUN_ID ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const stage = process.env.SCW_SERVICE_SMOKE_STAGE ?? `service-smoke-${suffix}`;
const prefix = (process.env.SCW_SERVICE_SMOKE_PREFIX ?? `alchemy-svc-${suffix}`).toLowerCase();
const greeting = randomBytes(8).toString("hex");
const stackFile = "scripts/scaleway-service-smoke-stack.ts";

console.log(`service smoke stage=${stage} prefix=${prefix}`);

function runAlchemy(command: "deploy" | "destroy") {
  console.log(`alchemy ${command}`);
  const result = spawnSync("bun", ["alchemy", command, stackFile, "--stage", stage, "--yes"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ALCHEMY_TELEMETRY_DISABLED: process.env.ALCHEMY_TELEMETRY_DISABLED ?? "1",
      CI: process.env.CI ?? "1",
      SCW_SERVICE_SMOKE_PREFIX: prefix,
      SERVICE_SMOKE_GREETING: greeting,
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`alchemy ${command} exited with ${result.status ?? "unknown"}`);
  return result;
}

type ContainerListResponse = {
  containers?: Array<{ id: string; name: string; domain_name?: string; image?: string }>;
};

async function containersNamed(name: string) {
  const response = await fetch(`${apiUrl}/containers/v1/regions/${region}/containers?name=${encodeURIComponent(name)}`, {
    headers: { Accept: "application/json", "X-Auth-Token": secretKey },
  });
  if (!response.ok) throw new Error(`list containers failed with ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as ContainerListResponse;
  return (body.containers ?? []).filter((container) => container.name === name);
}

async function fetchService(url: string) {
  const expected = `${greeting}:plain`;
  let last = "";
  for (let attempt = 1; attempt <= 36; attempt += 1) {
    try {
      const response = await fetch(url);
      last = `${response.status} ${await response.text()}`;
      if (response.ok && last.endsWith(expected)) {
        console.log(`fetched ${url} (${response.status})`);
        return;
      }
    } catch (error) {
      last = String(error);
    }
    console.log(`waiting for ${url} attempt ${attempt}/36: ${last}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`service at ${url} never answered with the bound values; last response: ${last}`);
}

let failure: unknown;
try {
  runAlchemy("deploy");
  const [container] = await containersNamed(prefix);
  if (!container?.domain_name) throw new Error(`no deployed container named ${prefix}`);
  await fetchService(`https://${container.domain_name}/`);

  runAlchemy("deploy");
  const [redeployed] = await containersNamed(prefix);
  if (redeployed?.image !== container.image) {
    throw new Error(`unchanged redeploy changed the image from ${container.image} to ${redeployed?.image}`);
  }
} catch (error) {
  failure = error;
} finally {
  runAlchemy("destroy");
}

const leaked = await containersNamed(prefix);
if (leaked.length > 0) {
  throw new Error(`service smoke leaked container(s): ${leaked.map((container) => container.id).join(", ")}`);
}

if (failure) throw failure;

console.log("service smoke test deployed, served bound values, redeployed unchanged and cleaned up");
