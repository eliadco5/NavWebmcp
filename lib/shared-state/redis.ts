import { Redis } from "@upstash/redis";

// Absence of config is the local-dev/test fallback switch, not an error — see
// lib/shared-state/index.ts. Cached after first call so every request doesn't
// re-check env vars or construct a new client.
let client: Redis | null | undefined;

export function getRedis(): Redis | null {
  if (client !== undefined) return client;

  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  client = url && token ? new Redis({ url, token }) : null;
  return client;
}

/** Test-only: forget the cached client so a test can flip env vars and re-resolve. */
export function resetRedisClientForTests(): void {
  client = undefined;
}
