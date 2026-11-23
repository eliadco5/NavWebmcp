#!/usr/bin/env node
// npm run test:redis — run the Redis-backed tests against a real local Redis.
//
//   1. docker compose up -d --wait redis   (docker-compose.yml, port 6390)
//   2. vitest run tests/integration/redis-live.test.ts with REDIS_LIVE_URL set
//   3. docker compose down                 (skip with --keep to leave it running)
//
// Already have a Redis? Point at it instead and skip Docker:
//   REDIS_LIVE_URL=redis://localhost:6379 npm run test:redis -- --no-docker
//
// Needs Docker Desktop (or another Docker engine) running.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const noDocker = args.includes("--no-docker");
const url = process.env.REDIS_LIVE_URL ?? "redis://localhost:6390";

function run(cmd, cmdArgs, env = process.env) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", env, shell: process.platform === "win32" });
  return r.status ?? 1;
}

if (!noDocker) {
  const probe = spawnSync("docker", ["info"], { stdio: "ignore", shell: process.platform === "win32" });
  if (probe.status !== 0) {
    console.error(
      "\nDocker isn't reachable. Start Docker Desktop (or your Docker engine) and try again,\n" +
      "or point at an existing Redis:  REDIS_LIVE_URL=redis://host:port npm run test:redis -- --no-docker\n"
    );
    process.exit(1);
  }
  if (run("docker", ["compose", "up", "-d", "--wait", "redis"]) !== 0) process.exit(1);
}

const status = run("npx", ["vitest", "run", "tests/integration/redis-live.test.ts"], { ...process.env, REDIS_LIVE_URL: url });

if (!noDocker && !keep) run("docker", ["compose", "down"]);
process.exit(status);
