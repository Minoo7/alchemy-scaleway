#!/usr/bin/env bun
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
if (!log) throw new Error("FAKE_DOCKER_LOG is required");

const auth = process.env.DOCKER_AUTH_CONFIG;
const servers = auth ? Object.keys(JSON.parse(auth).auths ?? {}) : [];
const pushIndex = args.indexOf("--push");
const context = pushIndex >= 0 ? args[pushIndex + 1] : undefined;
const build =
  context && existsSync(context)
    ? {
        files: readdirSync(context, { recursive: true }).map(String).sort(),
        dockerfile: readFileSync(join(context, "Dockerfile"), "utf8"),
        entry: readFileSync(join(context, "index.mjs"), "utf8"),
      }
    : undefined;
appendFileSync(log, `${JSON.stringify({ args, servers, build })}\n`);

if (args[0] === "buildx" && args[1] === "version") {
  console.log("github.com/docker/buildx v0.30.1 0123456");
} else if (args[0] === "buildx" && args[1] === "build" && process.env.FAKE_DOCKER_FAIL_BUILD === "1") {
  console.error("failed to solve: base image not found");
  process.exit(1);
}
