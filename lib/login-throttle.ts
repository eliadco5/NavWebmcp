// Sign-in throttle: at most LOGIN_MAX_ATTEMPTS failed sign-ins per IP per
// LOGIN_WINDOW_S (default 10 per 5 minutes), to slow password guessing. A
// fixed window on Redis INCR — shared by every instance — with an in-process
// fallback, like the other management stores. Only failures count, so a
// person who signs in correctly is never slowed down.
import { getRedis } from "@/lib/shared-state/redis";

const NAMESPACE = process.env.VERCEL_ENV ?? "dev";
const key = (ip: string, windowId: number) => `webmcp:login:${NAMESPACE}:${ip}:${windowId}`;

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

/** Null when the IP may try; otherwise how long until it may (ms). */
export async function loginBlockedFor(ip: string | undefined, now = Date.now()): Promise<number | null> {
  const { max, windowS } = loginLimits();
  const w = windowOf(now, windowS);
  const k = key(ip ?? "unknown", w.id);
  let count = mem().get(k) ?? 0;
  const r = await getRedis().catch(() => null);
  if (r) {
    try {
      count = Number((await r.get(k)) ?? 0);
    } catch (err) {
      console.warn("[login-throttle] read failed, using in-process count:", err);
    }
  }
  return count >= max ? w.resetMs : null;
}

export async function noteLoginFailure(ip: string | undefined, now = Date.now()): Promise<void> {
  const { windowS } = loginLimits();
  const w = windowOf(now, windowS);
  const k = key(ip ?? "unknown", w.id);
  const m = mem();
  m.set(k, (m.get(k) ?? 0) + 1);
  // Forget old windows so the map can't grow without bound.
  if (m.size > 10_000) for (const old of m.keys()) if (!old.endsWith(`:${w.id}`)) m.delete(old);
  const r = await getRedis().catch(() => null);
  if (!r) return;
  try {
    await r.multi().incr(k).expire(k, windowS).exec();
  } catch (err) {
    console.warn("[login-throttle] write failed, counted in-process:", err);
  }
}
