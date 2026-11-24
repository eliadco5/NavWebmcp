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

//
// A Redis that is CONNECTED BUT NOT ANSWERING (paused, overloaded, a network
// black hole) is worse than one that's down: nothing errors, every command
// just waits. Found by scripts/credits-stress.mjs (`docker pause`): every
// request hung for 20 s+ — the app was unreachable. So, as well:
//   - every command times out after REDIS_COMMAND_TIMEOUT_MS (default 1000)
//     and rejects; callers already catch and fall back;
//   - the client PINGs every second and the socket times out after
//     REDIS_SOCKET_TIMEOUT_MS (default 3000) without data, so a hung server
//     is detected, the socket dropped and Redis marked down for the cooldown
//     — later requests skip it at once instead of each paying the timeout.
function buildClient(url: string): RedisClientType {
  const c = createClient({
    url,
    disableOfflineQueue: true,
    pingInterval: envMs("REDIS_PING_INTERVAL_MS", 1000),
    commandOptions: { timeout: envMs("REDIS_COMMAND_TIMEOUT_MS", 1000) },
    socket: {
      connectTimeout: envMs("REDIS_CONNECT_TIMEOUT_MS", 1500),
      socketTimeout: envMs("REDIS_SOCKET_TIMEOUT_MS", 3000),
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
    // Any connection-level error (including the socket timeout above) skips
    // Redis for the cooldown, so requests stop waiting on it at once.
    downUntil = Date.now() + envMs("REDIS_RETRY_COOLDOWN_MS", 30_000);
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
