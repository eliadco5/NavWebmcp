import { createClient, type RedisClientType } from "redis";

// Absence of REDIS_URL is the local-dev/test fallback switch, not an error — see
// lib/shared-state/index.ts.
//
// node-redis holds a real TCP connection, unlike an HTTP client — it must be
// reused across requests within the same warm serverless instance rather than
// reconnected every call (each connect() is a round trip, and Redis providers
// cap concurrent connections). Caching on a module-level variable is exactly
// the same "survives while this instance is warm" pattern already used
// throughout this codebase for globalThis singletons.
let client: RedisClientType | undefined;
let connecting: Promise<RedisClientType> | undefined;

function buildClient(url: string): RedisClientType {
  const c = createClient({ url });
  // node-redis throws if an 'error' event has no listener — a dropped
  // connection would otherwise crash the whole Node process, not just this
  // request. hydrate()/flush() (lib/shared-state/index.ts) separately catch
  // failed commands and fail open; this only stops the crash.
  c.on("error", (err) => {
    console.warn("[shared-state] redis connection error:", err);
  });
  return c;
}

/** Returns a connected client, or null when REDIS_URL isn't configured. */
export async function getRedis(): Promise<RedisClientType | null> {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  if (client?.isReady) return client;

  if (!connecting) {
    client ??= buildClient(url);
    const c = client;
    connecting = (c.isOpen ? Promise.resolve(c) : c.connect().then(() => c)).finally(() => {
      connecting = undefined;
    });
  }
  return connecting;
}

/** Test-only: forget the cached client so a test can flip env vars and re-resolve. */
export function resetRedisClientForTests(): void {
  client = undefined;
  connecting = undefined;
}
