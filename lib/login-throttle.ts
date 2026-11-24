// Sign-in throttle: at most LOGIN_MAX_ATTEMPTS failed sign-ins per IP and
// username per LOGIN_WINDOW_S (default 10 per 5 minutes), to slow password
// guessing. A fixed window on Redis INCR — shared by every instance — with an
// in-process fallback, like the other management stores.
//
// Keyed by IP *and* username: someone guessing one account can't lock every
// other user behind the same IP (an office NAT) out. Only failures count. A
// slow or broken Redis never blocks a sign-in: each command is bounded and
// falls back to the in-process count.
import { getRedis } from "@/lib/shared-state/redis";

const NAMESPACE = process.env.VERCEL_ENV ?? "dev";
const key = (ip: string, user: string, windowId: number) =>
  `webmcp:login:${NAMESPACE}:${ip}:${encodeURIComponent(user.slice(0, 64).toLowerCase())}:${windowId}`;

/** Most counters kept in memory; beyond this the oldest are dropped. */
const MEMORY_MAX = 50_000;
const REDIS_TIMEOUT_MS = 300;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loginLimits() {
  return { max: envInt("LOGIN_MAX_ATTEMPTS", 10), windowS: envInt("LOGIN_WINDOW_S", 300) };
}

declare global {
  // eslint-disable-next-line no-var
  var __loginAttempts: Map<string, number> | undefined;
}
function mem() {
  return (globalThis.__loginAttempts ??= new Map());
}

function windowOf(now: number, windowS: number) {
  const id = Math.floor(now / (windowS * 1000));
  return { id, resetMs: (id + 1) * windowS * 1000 - now };
}

function timed<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("redis timeout")), REDIS_TIMEOUT_MS);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Null when this IP may try this username; otherwise how long until it may (ms). */
export async function loginBlockedFor(ip: string | undefined, username: string, now = Date.now()): Promise<number | null> {
  const { max, windowS } = loginLimits();
  const w = windowOf(now, windowS);
  const k = key(ip ?? "unknown", username, w.id);
  let count = mem().get(k) ?? 0;
  const r = await getRedis().catch(() => null);
  if (r) {
    try {
      count = Math.max(count, Number((await timed(r.get(k))) ?? 0));
    } catch (err) {
      console.warn("[login-throttle] read failed, using in-process count:", (err as Error)?.message ?? err);
    }
  }
  return count >= max ? w.resetMs : null;
}

export async function noteLoginFailure(ip: string | undefined, username: string, now = Date.now()): Promise<void> {
  const { windowS } = loginLimits();
  const w = windowOf(now, windowS);
  const k = key(ip ?? "unknown", username, w.id);
  const m = mem();
  const count = (m.get(k) ?? 0) + 1;
  m.delete(k); // re-insert: Map order is the LRU order
  m.set(k, count);
  if (m.size > MEMORY_MAX) {
    for (const old of m.keys()) if (!old.endsWith(`:${w.id}`)) m.delete(old);
    while (m.size > MEMORY_MAX) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }
  const r = await getRedis().catch(() => null);
  if (!r) return;
  try {
    await timed(r.multi().incr(k).expire(k, windowS).exec());
  } catch (err) {
    console.warn("[login-throttle] write failed, counted in-process:", (err as Error)?.message ?? err);
  }
}
