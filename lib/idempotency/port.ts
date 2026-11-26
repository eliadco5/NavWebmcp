// Idempotency keys (NavWebMcp 2.1.0). Client-safe: execute() is bundled into
// the browser, so this module holds only the types, the in-memory store and
// the helpers execute() needs. lib/idempotency/index.ts installs the server
// store (Redis when configured, in memory otherwise) from the same server entry
// points that install credits. With nothing installed (the browser, unit tests
// that don't import it) the in-memory store below is used.
import { z } from "zod";
import type { Result } from "@/lib/result";
import type { Operation } from "@/lib/operations/types";

export type { IdempotencyInfo } from "@/lib/result";

export interface IdempotencyRecord {
  /** "pending" while the first call runs; "done" once its success is stored. */
  state: "pending" | "done";
  /** SHA-256 of the canonical arguments, idempotencyKey excluded. */
  argsHash: string;
  /** Identifies the claim, so only its owner can complete or release it. */
  token: string;
  /** The first call's Result, once done. */
  result?: Result<unknown>;
  /** When the record was claimed (ms since epoch). */
  at: number;
}

export type ClaimOutcome =
  | { claimed: true; token: string }
  | { claimed: false; record: IdempotencyRecord };

export interface IdempotencyStore {
  /** Atomically claim `key` for a call with these arguments, or return the
   *  record that already holds it. A pending claim expires after `pendingTtlMs`
   *  (so a crashed instance can't block the key for a day). */
  claim(key: string, argsHash: string, pendingTtlMs: number): Promise<ClaimOutcome>;
  /** Store the first call's Result under the claim. No-op if the claim is gone. */
  complete(key: string, token: string, result: Result<unknown>, ttlMs: number): Promise<void>;
  /** Drop the claim (the call failed and nothing was written): a retry runs again. */
  release(key: string, token: string): Promise<void>;
}

/** The input field every idempotent operation accepts (published in its input schema). */
export const IDEMPOTENCY_KEY_FIELD = "idempotencyKey";

export const IdempotencyKeySchema = () =>
  z
    .string()
    .min(1)
    .max(128)
    // Short on purpose: it is published in every write's input schema.
    .describe("New UUID per action. Same key + same args (24 h) returns the first result; never writes twice.");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOp = Operation<any, any>;

/**
 * Operations that accept an idempotencyKey: every write that runs on the
 * server. Excluded: ops that only dispatch others (invoke — its nested writes
 * take their own keys) and ops that act on the page's own UI components
 * (ui_*), which aren't durable writes.
 */
export function isIdempotentOp(op: Pick<AnyOp, "permission" | "dispatchesOps" | "runsInPage">): boolean {
  return op.permission === "write" && !op.dispatchesOps && !op.runsInPage;
}

/** Done records live this long (IDEMPOTENCY_TTL_SECONDS, default 24 h). */
export function idempotencyTtlMs(): number {
  const n = Number(typeof process !== "undefined" ? process.env?.IDEMPOTENCY_TTL_SECONDS : undefined);
  return (Number.isFinite(n) && n > 0 ? n : 24 * 60 * 60) * 1000;
}

/** A pending claim expires after this long (IDEMPOTENCY_PENDING_TTL_MS, default 5 min). */
export function idempotencyPendingTtlMs(): number {
  const n = Number(typeof process !== "undefined" ? process.env?.IDEMPOTENCY_PENDING_TTL_MS : undefined);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60_000;
}

/** JSON with object keys sorted at every level, undefined values dropped. */
export function canonicalArgs(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalArgs(v))).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalArgs(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The store key for one (user, operation, key) scope. Hashed, so a long or
 *  odd key never makes an odd storage key. */
export function scopeKey(userId: string, operation: string, key: string): Promise<string> {
  return sha256Hex(`${userId}\u0000${operation}\u0000${key}`);
}

// ── In-memory store ──────────────────────────────────────────────────────────

interface MemEntry {
  record: IdempotencyRecord;
  expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __idempotencyMem: Map<string, MemEntry> | undefined;
  // eslint-disable-next-line no-var
  var __idempotencyPort: IdempotencyStore | undefined;
}

function mem(): Map<string, MemEntry> {
  return (globalThis.__idempotencyMem ??= new Map());
}

/** Drop expired entries now and then, so the map can't grow without bound. */
function prune(map: Map<string, MemEntry>, now: number) {
  if (map.size < 1000) return;
  for (const [k, e] of map) if (e.expiresAt <= now) map.delete(k);
}

function newToken(): string {
  return globalThis.crypto.randomUUID();
}

/** Per process. Every step is synchronous, so a claim is atomic within it. */
export const memoryIdempotencyStore: IdempotencyStore = {
  async claim(key, argsHash, pendingTtlMs) {
    const map = mem();
    const now = Date.now();
    prune(map, now);
    const existing = map.get(key);
    if (existing && existing.expiresAt > now) return { claimed: false, record: existing.record };
    const token = newToken();
    map.set(key, { record: { state: "pending", argsHash, token, at: now }, expiresAt: now + pendingTtlMs });
    return { claimed: true, token };
  },
  async complete(key, token, result, ttlMs) {
    const map = mem();
    const e = map.get(key);
    if (!e || e.record.token !== token) return;
    map.set(key, { record: { ...e.record, state: "done", result }, expiresAt: Date.now() + ttlMs });
  },
  async release(key, token) {
    const map = mem();
    if (map.get(key)?.record.token === token) map.delete(key);
  },
};

export function installIdempotency(store: IdempotencyStore): void {
  globalThis.__idempotencyPort = store;
}

export function idempotencyStore(): IdempotencyStore {
  return globalThis.__idempotencyPort ?? memoryIdempotencyStore;
}
