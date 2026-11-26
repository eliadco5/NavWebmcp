// The credit ledger: one record per principal (agent client or human user).
//
// The arithmetic lives in pure functions (refill / reserve / settle) so the
// Redis path and the in-process path can't drift. Redis writes are a
// compare-and-set on a version number (one small Lua script), retried on
// conflict, so instances never race each other on the same ledger. Without
// Redis — or while it's down or slow — the in-process Map is used: limits
// keep working per instance instead of switching off, and a call never waits
// on Redis longer than CREDITS_REDIS_TIMEOUT_MS.
//
// Safety properties this file guarantees (tests/unit/credits/ledger-fuzz.test.ts):
//   - outstanding is always the sum of live reservations, never negative;
//   - a reservation whose settle never comes (instance killed mid-call)
//     expires, so no caller is starved forever;
//   - a corrupt stored ledger is discarded, not trusted (a NaN balance would
//     otherwise refuse every call forever);
//   - balance + outstanding never exceeds the window after a refill.
import { getRedis } from "@/lib/shared-state/redis";
import type { Profile } from "./policy";

export interface Ledger {
  /** Credits available now. Fractional (refill is continuous); negative after expensive calls. */
  balance: number;
  /** Credits reserved by calls still running: always the sum of `holds`. */
  outstanding: number;
  /** Each running call's reservation: id → [credits, reservedAt]. */
  holds?: Record<string, [number, number]>;
  window: number;
  refilledAt: number;
  /** Totals, for the management view. */
  calls: number;
  spent: number;
  refused: number;
  lastAt: number;
  /** CAS version. */
  v: number;
}

/** Per-principal admin override (setClientCreditPolicy). */
export interface Override {
  maxWindow?: number;
  refillPerSec?: number;
  /** Refuse every call. */
  frozen?: boolean;
  by?: string;
  at?: string;
}

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** A reservation older than this is treated as lost. Longer than any call can
 *  legitimately run (handler deadline 15 s; Vercel maxDuration 60 s). */
export function holdStaleMs(): number {
  return envNum("CREDITS_HOLD_STALE_MS", 120_000);
}

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function effectiveProfile(p: Profile, o: Override | null): Profile {
  if (!o) return p;
  const maxWindow = isNum(o.maxWindow) ? Math.max(1, o.maxWindow) : p.maxWindow;
  return {
    ...p,
    maxWindow,
    minWindow: Math.min(p.minWindow, maxWindow),
    initialWindow: Math.min(p.initialWindow, maxWindow),
    refillPerSec: isNum(o.refillPerSec) && o.refillPerSec >= 0 ? o.refillPerSec : p.refillPerSec,
  };
}

export function freshLedger(p: Profile, now: number): Ledger {
  return { balance: p.initialWindow, outstanding: 0, holds: {}, window: p.initialWindow, refilledAt: now, calls: 0, spent: 0, refused: 0, lastAt: now, v: 0 };
}

function sumHolds(h: Record<string, [number, number]>): number {
  let s = 0;
  for (const k in h) s += h[k][0];
  return s;
}

/** A ledger as read from storage, or null if it's unusable (then the caller starts fresh). */
export function sanitizeLedger(raw: unknown): Ledger | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Partial<Ledger>;
  if (![l.balance, l.window, l.refilledAt, l.lastAt].every(isNum) || (l.window as number) < 1) return null;
  const holds: Record<string, [number, number]> = {};
  if (l.holds && typeof l.holds === "object") {
    for (const [id, h] of Object.entries(l.holds)) {
      if (Array.isArray(h) && isNum(h[0]) && isNum(h[1]) && h[0] > 0) holds[id] = [h[0], h[1]];
    }
  }
  return {
    balance: l.balance as number,
    outstanding: sumHolds(holds),
    holds,
    window: l.window as number,
    refilledAt: l.refilledAt as number,
    calls: isNum(l.calls) ? l.calls : 0,
    spent: isNum(l.spent) ? l.spent : 0,
    refused: isNum(l.refused) ? l.refused : 0,
    lastAt: l.lastAt as number,
    v: isNum(l.v) ? l.v : 0,
  };
}

export function sanitizeOverride(raw: unknown): Override | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Override;
  return {
    ...(isNum(o.maxWindow) && { maxWindow: o.maxWindow }),
    ...(isNum(o.refillPerSec) && { refillPerSec: o.refillPerSec }),
    ...(typeof o.frozen === "boolean" && { frozen: o.frozen }),
    ...(typeof o.by === "string" && { by: o.by }),
    ...(typeof o.at === "string" && { at: o.at }),
  };
}

/** Drop reservations whose settle never came; recompute outstanding. */
function expireHolds(l: Ledger, now: number): Ledger {
  const stale = holdStaleMs();
  const kept: Record<string, [number, number]> = {};
  for (const [id, h] of Object.entries(l.holds ?? {})) {
    if (now - h[1] <= stale) kept[id] = h;
  }
  return { ...l, holds: kept, outstanding: sumHolds(kept) };
}

/** Lazy trickle refill toward the window; also clamps to the current window. */
export function refill(l0: Ledger, p: Profile, now: number): Ledger {
  const l = expireHolds(l0, now);
  const window = Math.min(Math.max(l.window, p.minWindow), p.maxWindow);
  const room = window - l.outstanding;
  // A clock that went backwards (another instance's clock ahead of ours) neither refills nor un-refills.
  const elapsed = Math.max(0, now - l.refilledAt) / 1000;
  let balance = l.balance;
  if (balance < room) balance = Math.min(room, balance + elapsed * p.refillPerSec);
  else if (balance > Math.max(room, 0)) balance = Math.max(room, 0); // the window shrank
  return { ...l, window, balance, refilledAt: Math.max(now, l.refilledAt) };
}

export type ReserveOutcome =
  | { ok: true; ledger: Ledger; reserved: number; holdId: string }
  | { ok: false; ledger: Ledger; waitMs: number; reason: "insufficient" | "frozen" };

let holdSeq = 0;
export function newHoldId(now = Date.now()): string {
  holdSeq = (holdSeq + 1) % 1e9;
  return `${now.toString(36)}.${holdSeq.toString(36)}.${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Take the up-front charge. A charge bigger than the whole window is admitted
 * against the full window (the rest is settled afterwards, as debt) — otherwise
 * a large request could never run at all.
 */
export function reserve(l0: Ledger, charge: number, p: Profile, now: number, frozen = false, holdId = newHoldId(now)): ReserveOutcome {
  const l = refill(l0, p, now);
  if (frozen) return { ok: false, ledger: { ...l, refused: l.refused + 1, lastAt: now }, waitMs: 0, reason: "frozen" };
  const need = Math.max(1, Math.min(isNum(charge) ? charge : 1, l.window));
  if (l.balance >= need) {
    const holds = { ...(l.holds ?? {}), [holdId]: [need, now] as [number, number] };
    return { ok: true, reserved: need, holdId, ledger: { ...l, holds, balance: l.balance - need, outstanding: sumHolds(holds), lastAt: now } };
  }
  const deficit = need - l.balance;
  const waitMs = p.refillPerSec > 0 ? Math.ceil((deficit / p.refillPerSec) * 1000) : Number.POSITIVE_INFINITY;
  return { ok: false, ledger: { ...l, lastAt: now }, waitMs, reason: "insufficient" };
}

/** Count a refusal without changing anything else. */
export function noteRefusal(l: Ledger, now: number): Ledger {
  return { ...l, refused: l.refused + 1, lastAt: now };
}

export interface SettleInput {
  reserved: number;
  /** The reservation to release (from reserve). */
  holdId?: string;
  /** Cost beyond the reservation: response size, run time, unplanned nested ops. */
  extra: number;
  /** Part of the reservation handed back (an idempotent replay pays the request cost only). */
  refund?: number;
  durationMs: number;
  creditRequest?: number;
  /** 0..1 server load. */
  pressure: number;
}

export interface SettleOutcome {
  ledger: Ledger;
  granted: number;
  shrunk: boolean;
  grew: boolean;
}

/**
 * Settle a finished call, then grant (SMB's CreditResponse). The grant is what
 * the caller asked for (default: what the call cost), limited by the window
 * and scaled down by server load. The window adapts AIMD-style: a long call or
 * a call that leaves the caller in debt halves it; a quick one under low load
 * grows it by one.
 */
export function settle(l0: Ledger, s: SettleInput, p: Profile, now: number): SettleOutcome {
  const l = refill(l0, p, now);
  const holds = { ...(l.holds ?? {}) };
  if (s.holdId !== undefined) {
    // If it already expired (a very late settle), there's nothing left to release.
    delete holds[s.holdId];
  } else {
    // No id: release the oldest reservation of that size.
    const match = Object.entries(holds)
      .filter(([, h]) => h[0] === s.reserved)
      .sort((a, b) => a[1][1] - b[1][1])[0];
    if (match) delete holds[match[0]];
  }
  const outstanding = sumHolds(holds);
  const extra = isNum(s.extra) && s.extra > 0 ? s.extra : 0;
  const durationMs = isNum(s.durationMs) ? s.durationMs : 0;
  const pressure = isNum(s.pressure) ? Math.min(1, Math.max(0, s.pressure)) : 0;
  const refund = isNum(s.refund) && s.refund > 0 ? Math.min(s.refund, s.reserved) : 0;
  let balance = l.balance - extra + refund;
  const charged = s.reserved + extra - refund;

  let window = l.window;
  let shrunk = false;
  let grew = false;
  if (durationMs > p.longCallMs || balance < 0) {
    const next = Math.max(p.minWindow, Math.floor(window / 2));
    shrunk = next < window;
    window = next;
  } else if (pressure < 0.25 && window < p.maxWindow) {
    window += 1;
    grew = true;
  }

  const asked = isNum(s.creditRequest) ? Math.max(0, Math.floor(s.creditRequest)) : s.reserved;
  const room = Math.max(0, window - outstanding - balance);
  const granted = Math.max(0, Math.floor(Math.min(asked, room) * (1 - pressure)));
  balance += granted;

  return {
    ledger: { ...l, holds, balance, outstanding, window, calls: l.calls + 1, spent: l.spent + charged, lastAt: now },
    granted,
    shrunk,
    grew,
  };
}

// ── Storage ──────────────────────────────────────────────────────────────────

const NAMESPACE = process.env.VERCEL_ENV ?? "dev";
const PREFIX = `webmcp:credits:${NAMESPACE}`;
const ledgerKey = (principal: string) => `${PREFIX}:l:${principal}`;
const overrideKey = (principal: string) => `${PREFIX}:o:${principal}`;
const INDEX_KEY = `${PREFIX}:idx`;
/** An idle ledger is forgotten after a day (it starts fresh next time). */
const LEDGER_TTL_S = 24 * 60 * 60;
/** Most ledgers the admin view lists. */
const LIST_MAX = 2000;

// SET only if the stored version still matches the one we read. A stored value
// that isn't valid JSON counts as version 0, so it can be overwritten.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local v = 0
if cur then
  local ok, decoded = pcall(cjson.decode, cur)
  if ok and type(decoded) == 'table' then v = tonumber(decoded.v) or 0 end
end
if v ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

/** Longest a credit check waits on Redis before using the in-process ledger. */
function redisTimeoutMs(): number {
  return envNum("CREDITS_REDIS_TIMEOUT_MS", 300);
}

/** Most ledgers kept in process memory (least recently used dropped first). */
function memoryMax(): number {
  return envNum("CREDITS_MEMORY_MAX_LEDGERS", 20_000);
}

declare global {
  // eslint-disable-next-line no-var
  var __creditLedgers:
    | { ledgers: Map<string, Ledger>; overrides: Map<string, Override>; queues: Map<string, Promise<unknown>> }
    | undefined;
}
function mem() {
  const m = (globalThis.__creditLedgers ??= { ledgers: new Map(), overrides: new Map(), queues: new Map() });
  m.queues ??= new Map();
  return m;
}

function memPut(principal: string, l: Ledger) {
  const m = mem().ledgers;
  m.delete(principal); // re-insert: Map order is the LRU order
  m.set(principal, l);
  const max = memoryMax();
  while (m.size > max) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

class RedisTimeout extends Error {}

function timed<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RedisTimeout(`redis took over ${redisTimeoutMs()} ms`)), redisTimeoutMs());
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// getRedis() already fails fast on its own (connect timeout, then a cooldown
// during which it answers null at once — lib/shared-state/redis.ts). What it
// can't bound is a connected Redis that has stopped answering; every command
// below is wrapped in timed() for that.
async function redis() {
  return getRedis().catch(() => null);
}

function parse(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Per-principal serialization within this instance: concurrent calls of one
 *  caller queue up here instead of fighting over the Redis CAS. */
async function serialized<T>(principal: string, fn: () => Promise<T>): Promise<T> {
  const queues = mem().queues;
  const prev = queues.get(principal) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  queues.set(principal, tail);
  void tail.then(() => {
    if (queues.get(principal) === tail) queues.delete(principal);
  });
  return run;
}

const CAS_ATTEMPTS = 10;

/**
 * Read-modify-write one ledger atomically. `fn` gets the current ledger (or
 * null) and returns the next one plus a value to hand back. On Redis, retried
 * on a version conflict (other instances); a Redis error or timeout falls back
 * to in-process memory. Never throws for storage reasons.
 */
export function updateLedger<T>(
  principal: string,
  fn: (current: Ledger | null, override: Override | null) => { next: Ledger; value: T }
): Promise<T> {
  return serialized(principal, async () => {
    const r = await redis();
    if (r) {
      try {
        for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
          const [raw, rawOverride] = await timed(r.mGet([ledgerKey(principal), overrideKey(principal)]));
          const stored = parse(raw);
          const current = sanitizeLedger(stored);
          const override = sanitizeOverride(parse(rawOverride));
          const { next, value } = fn(current, override);
          // The version guards what's actually stored, even if we discarded it as corrupt.
          const expected = isNum((stored as { v?: unknown } | null)?.v) ? (stored as { v: number }).v : 0;
          const okSet = await timed(r.eval(CAS_SCRIPT, {
            keys: [ledgerKey(principal)],
            arguments: [String(expected), JSON.stringify({ ...next, v: expected + 1 }), String(LEDGER_TTL_S)],
          }));
          if (Number(okSet) === 1) {
            if (!raw) await timed(r.sAdd(INDEX_KEY, principal)).catch(() => undefined);
            memPut(principal, { ...next, v: expected + 1 }); // warm copy for a Redis outage
            return value;
          }
          // Lost a race with another instance: back off a little, with jitter.
          await new Promise((res) => setTimeout(res, Math.random() * (5 + attempt * 5)));
        }
        console.warn(`[credits] ledger ${principal} contended ${CAS_ATTEMPTS}x, settling in-process`);
      } catch (err) {
        console.warn("[credits] ledger write failed, using in-process ledger:", (err as Error)?.message ?? err);
      }
    }
    const m = mem();
    const { next, value } = fn(sanitizeLedger(m.ledgers.get(principal)), m.overrides.get(principal) ?? null);
    memPut(principal, { ...next, v: (next.v ?? 0) + 1 });
    return value;
  });
}

export async function getLedger(principal: string): Promise<{ ledger: Ledger | null; override: Override | null }> {
  const r = await redis();
  if (r) {
    try {
      const [raw, rawOverride] = await timed(r.mGet([ledgerKey(principal), overrideKey(principal)]));
      return { ledger: sanitizeLedger(parse(raw)), override: sanitizeOverride(parse(rawOverride)) };
    } catch (err) {
      console.warn("[credits] ledger read failed, using in-process state:", (err as Error)?.message ?? err);
    }
  }
  return { ledger: sanitizeLedger(mem().ledgers.get(principal)), override: mem().overrides.get(principal) ?? null };
}

export async function getOverride(principal: string): Promise<Override | null> {
  const r = await redis();
  if (r) {
    try {
      return sanitizeOverride(parse(await timed(r.get(overrideKey(principal)))));
    } catch (err) {
      console.warn("[credits] override read failed, using in-process state:", (err as Error)?.message ?? err);
    }
  }
  return mem().overrides.get(principal) ?? null;
}

/** Set (or with null, clear) a principal's override. */
export async function setOverride(principal: string, o: Override | null): Promise<void> {
  const m = mem();
  if (o) m.overrides.set(principal, o);
  else m.overrides.delete(principal);
  const r = await redis();
  if (!r) return;
  try {
    if (o) await timed(r.multi().set(overrideKey(principal), JSON.stringify(o)).sAdd(INDEX_KEY, principal).exec());
    else await timed(r.del(overrideKey(principal)));
  } catch (err) {
    console.warn("[credits] override write failed (kept in-process):", (err as Error)?.message ?? err);
  }
}

export interface LedgerRow {
  principal: string;
  ledger: Ledger | null;
  override: Override | null;
}

export async function listLedgers(): Promise<LedgerRow[]> {
  const r = await redis();
  if (r) {
    try {
      const principals = (await timed(r.sMembers(INDEX_KEY))).slice(0, LIST_MAX);
      if (principals.length === 0) return [];
      const raws = await timed(r.mGet(principals.flatMap((p) => [ledgerKey(p), overrideKey(p)])));
      const rows: LedgerRow[] = [];
      const gone: string[] = [];
      principals.forEach((principal, i) => {
        const l = sanitizeLedger(parse(raws[i * 2]));
        const o = sanitizeOverride(parse(raws[i * 2 + 1]));
        if (!l && !o) gone.push(principal);
        else rows.push({ principal, ledger: l, override: o });
      });
      // Ledgers expire on their own; prune their index entries as we go.
      if (gone.length) await timed(r.sRem(INDEX_KEY, gone)).catch(() => undefined);
      return rows;
    } catch (err) {
      console.warn("[credits] ledger list failed, using in-process state:", (err as Error)?.message ?? err);
    }
  }
  const m = mem();
  const keys = [...new Set([...m.ledgers.keys(), ...m.overrides.keys()])].slice(0, LIST_MAX);
  return keys.map((principal) => ({
    principal,
    ledger: sanitizeLedger(m.ledgers.get(principal)),
    override: m.overrides.get(principal) ?? null,
  }));
}
