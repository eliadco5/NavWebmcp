// Tamper evidence: each event's hash covers the previous event's hash, so
// altering, removing or reordering any stored event breaks every hash after
// it. Keyed (HMAC) so someone with write access to Redis but not the key
// can't recompute a consistent chain after editing it.
import crypto from "node:crypto";
import type { AuditEvent, AuditEventBody } from "./types";

function key(): string {
  // Same fallback philosophy as lib/auth-tokens.ts: a deterministic default so a
  // misconfigured deploy is "weaker" rather than "every instance disagrees".
  return process.env.AUDIT_HMAC_KEY ?? process.env.AUTH_SECRET ?? "agentbridge-demo-insecure-audit-key";
}

/** JSON with object keys sorted at every level, and undefined fields dropped:
 *  the same event always serialises to the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function computeHash(prevHash: string, seq: number, body: AuditEventBody): string {
  return crypto
    .createHmac("sha256", key())
    .update(`${prevHash}\n${seq}\n${canonicalJson(body)}`)
    .digest("hex");
}

export function link(body: AuditEventBody, prev: { seq: number; hash: string }): AuditEvent {
  const seq = prev.seq + 1;
  return { ...body, seq, prevHash: prev.hash, hash: computeHash(prev.hash, seq, body) };
}

export function bodyOf(event: AuditEvent): AuditEventBody {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { seq, prevHash, hash, ...body } = event;
  return body;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstSeq?: number;
  lastSeq?: number;
  /** First event that doesn't verify, and why. */
  brokenAt?: { seq: number; id: string; reason: "hash_mismatch" | "link_mismatch" | "seq_gap" };
}

/**
 * Verify a contiguous run of events in chain order (oldest first). The first
 * event's own prevHash is taken as the anchor, so a window that starts after
 * retention trimming still verifies.
 */
export function verifyEvents(events: AuditEvent[]): ChainVerification {
  if (events.length === 0) return { ok: true, checked: 0 };
  let prev: AuditEvent | undefined;
  for (const e of events) {
    if (prev && e.seq !== prev.seq + 1) {
      return { ok: false, checked: events.length, brokenAt: { seq: e.seq, id: e.id, reason: "seq_gap" } };
    }
    if (prev && e.prevHash !== prev.hash) {
      return { ok: false, checked: events.length, brokenAt: { seq: e.seq, id: e.id, reason: "link_mismatch" } };
    }
    if (computeHash(e.prevHash, e.seq, bodyOf(e)) !== e.hash) {
      return { ok: false, checked: events.length, brokenAt: { seq: e.seq, id: e.id, reason: "hash_mismatch" } };
    }
    prev = e;
  }
  return { ok: true, checked: events.length, firstSeq: events[0].seq, lastSeq: events[events.length - 1].seq };
}
