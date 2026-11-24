// The credit ledger: one record per principal (agent client or human user).
//
// The arithmetic lives in pure functions (refill / reserve / settle) so the
// Redis path and the in-process path can't drift. Redis writes are a
// compare-and-set on a version number (one small Lua script), retried on
// conflict, so instances never race each other on the same ledger. Without
// Redis — or while it's down — the in-process Map is used: limits keep
// working per instance instead of switching off.
import { getRedis } from "@/lib/shared-state/redis";
import type { Profile } from "./policy";

export interface Ledger {
  /** Credits available now. Fractional (refill is continuous); negative after expensive calls. */
  balance: number;
  /** Credits reserved by calls still running. */
  outstanding: number;
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

export function effectiveProfile(p: Profile, o: Override | null): Profile {
  if (!o) return p;
  const maxWindow = o.maxWindow !== undefined ? Math.max(1, o.maxWindow) : p.maxWindow;
  return {
    ...p,
    maxWindow,
    minWindow: Math.min(p.minWindow, maxWindow),
    initialWindow: Math.min(p.initialWindow, maxWindow),
    refillPerSec: o.refillPerSec ?? p.refillPerSec,
  };
}

export function freshLedger(p: Profile, now: number): Ledger {
  return { balance: p.initialWindow, outstanding: 0, window: p.initialWindow, refilledAt: now, calls: 0, spent: 0, refused: 0, lastAt: now, v: 0 };
}

/** Lazy trickle refill toward the window; also clamps to the current window. */
export function refill(l: Ledger, p: Profile, now: number): Ledger {
  const window = Math.min(Math.max(l.window, p.minWindow), p.maxWindow);
  const room = window - l.outstanding;
  const elapsed = Math.max(0, now - l.refilledAt) / 1000;
  let balance = l.balance;
  if (balance < room) balance = Math.min(room, balance + elapsed * p.refillPerSec);
  else if (balance > Math.max(room, 0)) balance = Math.max(room, 0); // the window shrank
  return { ...l, window, balance, refilledAt: now };
}

export type ReserveOutcome =
  | { ok: true; ledger: Ledger; reserved: number }
  | { ok: false; ledger: Ledger; waitMs: number; reason: "insufficient" | "frozen" };

/**
 * Take the up-front charge. A charge bigger than the whole window is admitted
 * against the full window (the rest is settled afterwards, as debt) — otherwise
 * a large request could never run at all.
 */
export function reserve(l0: Ledger, charge: number, p: Profile, now: number, frozen = false): ReserveOutcome {
  const l = refill(l0, p, now);
  if (frozen) return { ok: false, ledger: { ...l, refused: l.refused + 1, lastAt: now }, waitMs: 0, reason: "frozen" };
  const need = Math.min(charge, l.window);
  if (l.balance >= need) {
    return { ok: true, reserved: need, ledger: { ...l, balance: l.balance - need, outstanding: l.outstanding + need, lastAt: now } };
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
  /** Cost beyond the reservation: response size, run time, unplanned nested ops. */
  extra: number;
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
  const outstanding = Math.max(0, l.outstanding - s.reserved);
  let balance = l.balance - s.extra;
  const charged = s.reserved + s.extra;

  let window = l.window;
  let shrunk = false;
  let grew = false;
  if (s.durationMs > p.longCallMs || balance < 0) {
    const next = Math.max(p.minWindow, Math.floor(window / 2));
    shrunk = next < window;
    window = next;
  } else if (s.pressure < 0.25 && window < p.maxWindow) {
    window += 1;
    grew = true;
  }

  const asked = s.creditRequest !== undefined ? Math.max(0, Math.floor(s.creditRequest)) : s.reserved;
  const room = Math.max(0, window - outstanding - balance);
  const granted = Math.max(0, Math.floor(Math.min(asked, room) * (1 - Math.min(1, Math.max(0, s.pressure)))));
  balance += granted;

  return {
    ledger: { ...l, balance, outstanding, window, calls: l.calls + 1, spent: l.spent + charged, lastAt: now },
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

// SET only if the stored version still matches the one we read.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local v = 0
if cur then v = tonumber(cjson.decode(cur).v) or 0 end
if v ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

declare global {
  // eslint-disable-next-line no-var
  var __creditLedgers: { ledgers: Map<string, Ledger>; overrides: Map<string, Override> } | undefined;
}
function mem() {
  return (globalThis.__creditLedgers ??= { ledgers: new Map(), overrides: new Map() });
}

async function redis() {
  return getRedis().catch(() => null);
}

/**
 * Read-modify-write one ledger atomically. `fn` gets the current ledger (or
 * null) and returns the next one plus a value to hand back. On Redis, retried
 * on a version conflict; a Redis error falls back to in-process memory.
 */
export async function updateLedger<T>(
  principal: string,
  fn: (current: Ledger | null, override: Override | null) => { next: Ledger; value: T }
): Promise<T> {
  const r = await redis();
  if (r) {
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const [raw, rawOverride] = await r.mGet([ledgerKey(principal), overrideKey(principal)]);
        const current = raw ? (JSON.parse(raw) as Ledger) : null;
        const override = rawOverride ? (JSON.parse(rawOverride) as Override) : null;
        const { next, value } = fn(current, override);
        const expected = current?.v ?? 0;
        const stored = { ...next, v: expected + 1 };
        const okSet = await r.eval(CAS_SCRIPT, {
          keys: [ledgerKey(principal)],
          arguments: [String(expected), JSON.stringify(stored), String(LEDGER_TTL_S)],
        });
        if (Number(okSet) === 1) {
          if (!current) await r.sAdd(INDEX_KEY, principal);
          return value;
        }
      }
      console.warn(`[credits] ledger ${principal} contended, settling in-process`);
    } catch (err) {
      console.warn("[credits] ledger write failed, using in-process ledger:", err);
    }
  }
  const m = mem();
  const { next, value } = fn(m.ledgers.get(principal) ?? null, m.overrides.get(principal) ?? null);
  m.ledgers.set(principal, { ...next, v: (next.v ?? 0) + 1 });
  return value;
}

export async function getLedger(principal: string): Promise<{ ledger: Ledger | null; override: Override | null }> {
  const r = await redis();
  if (r) {
    try {
      const [raw, rawOverride] = await r.mGet([ledgerKey(principal), overrideKey(principal)]);
      return { ledger: raw ? JSON.parse(raw) : null, override: rawOverride ? JSON.parse(rawOverride) : null };
    } catch (err) {
      console.warn("[credits] ledger read failed, using in-process state:", err);
    }
  }
  return { ledger: mem().ledgers.get(principal) ?? null, override: mem().overrides.get(principal) ?? null };
}

export async function getOverride(principal: string): Promise<Override | null> {
  const r = await redis();
  if (r) {
    try {
      const raw = await r.get(overrideKey(principal));
      return raw ? (JSON.parse(raw) as Override) : null;
    } catch (err) {
      console.warn("[credits] override read failed, using in-process state:", err);
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
    if (o) await r.multi().set(overrideKey(principal), JSON.stringify(o)).sAdd(INDEX_KEY, principal).exec();
    else await r.del(overrideKey(principal));
  } catch (err) {
    console.warn("[credits] override write failed (kept in-process):", err);
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
      const principals = await r.sMembers(INDEX_KEY);
      if (principals.length === 0) return [];
      const raws = await r.mGet(principals.flatMap((p) => [ledgerKey(p), overrideKey(p)]));
      const rows: LedgerRow[] = [];
      const gone: string[] = [];
      principals.forEach((principal, i) => {
        const l = raws[i * 2];
        const o = raws[i * 2 + 1];
        if (!l && !o) gone.push(principal);
        else rows.push({ principal, ledger: l ? JSON.parse(l) : null, override: o ? JSON.parse(o) : null });
      });
      // Ledgers expire on their own; prune their index entries as we go.
      if (gone.length) await r.sRem(INDEX_KEY, gone).catch(() => undefined);
      return rows;
    } catch (err) {
      console.warn("[credits] ledger list failed, using in-process state:", err);
    }
  }
  const m = mem();
  const keys = new Set([...m.ledgers.keys(), ...m.overrides.keys()]);
  return [...keys].map((principal) => ({
    principal,
    ledger: m.ledgers.get(principal) ?? null,
    override: m.overrides.get(principal) ?? null,
  }));
}
