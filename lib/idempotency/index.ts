// Server idempotency store (NavWebMcp 2.1.0). Importing this module from a
// server entry point installs it for execute() via ./port.ts.
//
// With REDIS_URL, records live in Redis, so two instances share them: the claim
// is one Lua script (GET, else SET with a TTL), so exactly one instance runs a
// given key. Without Redis, or while it is down, the per-process store in
// ./port.ts is used: the same fail-open trade-off as the rest of shared state.
import { getRedis } from "@/lib/shared-state/redis";
import {
  installIdempotency, memoryIdempotencyStore,
  type ClaimOutcome, type IdempotencyRecord, type IdempotencyStore,
} from "./port";

export * from "./port";

function redisKey(scope: string): string {
  // Read at call time (not module load) so tests can namespace by VERCEL_ENV.
  return `webmcp:idem:${process.env.VERCEL_ENV ?? "dev"}:${scope}`;
}

/** Longest one idempotency command waits on Redis before using memory. */
function redisTimeoutMs(): number {
  const n = Number(process.env.IDEMPOTENCY_REDIS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

function timed<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis took over ${redisTimeoutMs()} ms`)), redisTimeoutMs());
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// Returns the stored record if the key is taken; otherwise stores ours and returns nil.
const CLAIM_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur then return cur end
redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
return false
`;

// Replace (ARGV[2] non-empty) or delete (empty) the record, only if our claim still holds it.
const SETTLE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local ok, d = pcall(cjson.decode, cur)
if not ok or type(d) ~= 'table' or d.token ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3])) end
return 1
`;

/** Tokens of claims made in Redis start with this; anything else was made in memory. */
const REDIS_TOKEN = "r:";

function parseRecord(raw: unknown): IdempotencyRecord | null {
  if (typeof raw !== "string") return null;
  try {
    const r = JSON.parse(raw) as IdempotencyRecord;
    return r && (r.state === "pending" || r.state === "done") && typeof r.argsHash === "string" ? r : null;
  } catch {
    return null;
  }
}

async function settle(key: string, token: string, value: string, ttlMs: number): Promise<boolean> {
  const r = await getRedis().catch(() => null);
  if (!r) return false;
  try {
    await timed(r.eval(SETTLE_SCRIPT, { keys: [redisKey(key)], arguments: [token, value, String(ttlMs)] }));
    return true;
  } catch (err) {
    console.warn("[idempotency] redis settle failed:", (err as Error)?.message ?? err);
    return false;
  }
}

export const serverIdempotencyStore: IdempotencyStore = {
  async claim(key, argsHash, pendingTtlMs): Promise<ClaimOutcome> {
    const r = await getRedis().catch(() => null);
    if (r) {
      const token = REDIS_TOKEN + crypto.randomUUID();
      const record: IdempotencyRecord = { state: "pending", argsHash, token, at: Date.now() };
      try {
        const existing = await timed(r.eval(CLAIM_SCRIPT, {
          keys: [redisKey(key)],
          arguments: [JSON.stringify(record), String(pendingTtlMs)],
        }));
        if (existing === null || existing === undefined) return { claimed: true, token };
        const stored = parseRecord(existing);
        if (stored) return { claimed: false, record: stored };
        // Unreadable value: treat the key as taken by a call still running,
        // rather than risk running the write twice.
        return { claimed: false, record: { state: "pending", argsHash, token: "", at: Date.now() } };
      } catch (err) {
        console.warn("[idempotency] redis claim failed, using in-process store:", (err as Error)?.message ?? err);
      }
    }
    return memoryIdempotencyStore.claim(key, argsHash, pendingTtlMs);
  },
  async complete(key, token, result, ttlMs) {
    if (!token.startsWith(REDIS_TOKEN)) return memoryIdempotencyStore.complete(key, token, result, ttlMs);
    const raw = await getRedis().catch(() => null);
    if (!raw) return;
    // Re-read the claim to keep argsHash/at; the script checks the token again.
    let base: IdempotencyRecord | null = null;
    try {
      base = parseRecord(await timed(raw.get(redisKey(key))));
    } catch { /* fall through */ }
    if (!base || base.token !== token) return;
    await settle(key, token, JSON.stringify({ ...base, state: "done", result }), ttlMs);
  },
  async release(key, token) {
    if (!token.startsWith(REDIS_TOKEN)) return memoryIdempotencyStore.release(key, token);
    await settle(key, token, "", 0);
  },
};

installIdempotency(serverIdempotencyStore);
