import type { Actor, Channel } from "@/lib/operations/types";

/** Bump when the event shape changes; verifiers and exporters key off it. */
export const AUDIT_EVENT_VERSION = 1 as const;

export type AuditCategory = "operation" | "auth" | "admin";

/**
 * "denied": stopped by an access control (RBAC, authentication, a declined
 * confirmation). "failure": allowed, but didn't succeed. Kept apart because
 * auditors look for denials specifically (SOC2 CC6/CC7).
 */
export type AuditOutcome = "success" | "failure" | "denied";

export interface AuditTarget {
  /** e.g. "reservation", "guest", "task", "session", "agentClient". */
  type: string;
  id: string;
}

/** Everything about an event except its position in the chain. */
export interface AuditEventBody {
  v: typeof AUDIT_EVENT_VERSION;
  id: string;
  ts: string;
  category: AuditCategory;
  /** Operation name for "operation"; e.g. "auth.login", "admin.revoke_client". */
  action: string;
  outcome: AuditOutcome;
  errorCode?: string;
  actor: Actor;
  channel: Channel;
  requestId?: string;
  callId?: string;
  parentCallId?: string;
  ip?: string;
  userAgent?: string;
  target?: AuditTarget;
  /** Redacted and size-capped. */
  input?: unknown;
  /** Redacted and size-capped. */
  output?: unknown;
  durationMs?: number;
  /** Set when the event was reported by the browser rather than observed by
   *  the server (in-page ui_* operations), so its content is client-asserted. */
  reportedBy?: "client";
  /** The idempotency key the call ran under (NavWebMcp 2.1.0). */
  idempotencyKey?: string;
  /** Answered from the stored result of an earlier call with the same key:
   *  nothing ran again, whatever `output` shows. */
  replayed?: true;
}

/** A stored event: the body plus its link in the tamper-evident chain. */
export interface AuditEvent extends AuditEventBody {
  /** Position in the chain, from 1. */
  seq: number;
  /** `hash` of the previous event ("" for the first event ever). */
  prevHash: string;
  /** HMAC-SHA256 over prevHash + canonical JSON of the body + seq. */
  hash: string;
}

const DENIAL_CODES = new Set([
  "FORBIDDEN",
  "UNAUTHENTICATED",
  "CONFIRMATION_DENIED",
  "INVALID_CREDENTIALS",
  "SESSION_ENDED",
]);

export function outcomeFor(success: boolean, errorCode?: string): AuditOutcome {
  if (success) return "success";
  return errorCode && DENIAL_CODES.has(errorCode) ? "denied" : "failure";
}
