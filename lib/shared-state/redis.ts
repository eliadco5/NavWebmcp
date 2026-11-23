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
//
// Fail fast when Redis is unreachable. node-redis's connect() never settles
// while the server is down (it keeps reconnecting in the background), and by
// default commands sent while disconnected wait in an offline queue. Either
// would make every request that touches shared state, the audit trail or the
// metrics hang until the platform timeout. So:
//   - the first connect is raced against REDIS_CONNECT_TIMEOUT_MS (default
//     1500); on timeout getRedis() returns null and callers use their
//     in-memory fallback, exactly as without REDIS_URL;
//   - after a failure, getRedis() answers null immediately for
//     REDIS_RETRY_COOLDOWN_MS (default 30s) instead of paying the timeout on
//     every request; the client keeps reconnecting in the background and is
//     used again as soon as it's ready;
//   - disableOfflineQueue makes a command on a dropped connection reject at
//     once (callers already catch and fall back) instead of queueing.
let client: RedisClientType | undefined;
let connecting: Promise<RedisClientType> | undefined;
let downUntil = 0;

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function buildClient(url: string): RedisClientType {
  const c = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: envMs("REDIS_CONNECT_TIMEOUT_MS", 1500),
      // Keep trying in the background, backing off to every 5s.
      reconnectStrategy: (retries: number) => Math.min(100 * 2 ** retries, 5000),
    },
  }) as RedisClientType;
  // node-redis throws if an 'error' event has no listener — a dropped
  // connection would otherwise crash the whole Node process, not just this
  // request. hydrate()/flush() (lib/shared-state/index.ts) separately catch
  // failed commands and fail open; this only stops the crash. Logged once
  // per outage, not once per reconnect attempt.
  let reported = false;
  c.on("error", (err) => {
    if (reported) return;
    reported = true;
    console.warn("[shared-state] redis connection error (falling back to in-process state):", err?.message ?? err);
  });
  c.on("ready", () => {
    reported = false;
    downUntil = 0;
  });
  return c;
}

/** Returns a connected client, or null when REDIS_URL isn't configured or Redis
 *  is unreachable right now (callers then use their in-memory fallback). */
export async function getRedis(): Promise<RedisClientType | null> {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  if (client?.isReady) return client;
  if (Date.now() < downUntil) return null;

  if (!connecting) {
    client ??= buildClient(url);
    const c = client;
    connecting = c.isOpen
      ? Promise.resolve(c) // reconnecting in the background already
      : c.connect().then(() => c);
    connecting.catch(() => undefined).finally(() => {
      connecting = undefined;
    });
  }

  const timeoutMs = envMs("REDIS_CONNECT_TIMEOUT_MS", 1500);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = await Promise.race([connecting.catch(() => null), timedOut]);
  clearTimeout(timer);

  if (!result || !result.isReady) {
    downUntil = Date.now() + envMs("REDIS_RETRY_COOLDOWN_MS", 30_000);
    return null;
  }
  return result;
}

/** True while a recent connection failure has getRedis() answering null. */
export function isRedisDown(): boolean {
  return Boolean(process.env.REDIS_URL) && Date.now() < downUntil;
}

/** Test-only: forget the cached client so a test can flip env vars and re-resolve. */
export function resetRedisClientForTests(): void {
  const c = client;
  client = undefined;
  connecting = undefined;
  downUntil = 0;
  // destroy() also stops background reconnect attempts, so a test pointed at
  // an unreachable Redis doesn't leave a retry loop running.
  try { if (c?.isOpen) c.destroy(); } catch { /* already closed */ }
}
