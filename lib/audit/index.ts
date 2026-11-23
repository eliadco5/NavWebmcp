// What the rest of the app calls to write the SOC2 audit trail. Each recorder
// builds a versioned event, redacts it, appends it to the hash-chained store,
// then hands it to the export sinks without making the caller wait for them.
import type { Actor, Channel, CallMeta, Operation } from "@/lib/operations/types";
import { redact } from "./redact";
import { appendAuditEvent } from "./store";
import { runAuditSinks } from "./sinks";
import { installAuditRecorder } from "./port";
import {
  AUDIT_EVENT_VERSION, outcomeFor,
  type AuditCategory, type AuditEvent, type AuditEventBody, type AuditOutcome, type AuditTarget,
} from "./types";

export type { AuditEvent, AuditTarget, AuditOutcome, AuditCategory } from "./types";
export { queryAudit, verifyAuditChain, enforceRetention, isDurable, retentionDays } from "./store";

/** Run the sinks after the response when Next can (after()), else in the background. */
async function exportLater(event: AuditEvent) {
  const job = () => runAuditSinks([event]).then(() => undefined);
  try {
    const { after } = await import("next/server");
    after(job);
  } catch {
    void job().catch(() => undefined);
  }
}

async function record(body: AuditEventBody): Promise<AuditEvent | null> {
  const event = await appendAuditEvent(body);
  if (event) await exportLater(event);
  return event;
}

// ── Target resolution ────────────────────────────────────────────────────────

/** Input keys that name the record an operation acts on, most specific first. */
const TARGET_KEYS: [key: string, type: string][] = [
  ["reservationId", "reservation"],
  ["paymentId", "payment"],
  ["adjustmentId", "adjustment"],
  ["taskId", "task"],
  ["guestId", "guest"],
  ["scheduleId", "scheduleItem"],
  ["tableId", "table"],
  ["slotId", "slot"],
  ["id", "record"],
];

function idOf(obj: unknown, type: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of [`${type}Id`, "id"]) if (typeof o[k] === "string") return o[k] as string;
  return undefined;
}

/**
 * Which record a call touched, for "show me everything that happened to
 * reservation X". An op can declare it (`audit.target`); otherwise the output
 * is checked for a single wrapped entity ({ reservation: { id } }) — that's how
 * creates report the id they just assigned — then the input's id fields.
 */
export function resolveTarget(
  op: Pick<Operation, "audit"> | undefined,
  input: Record<string, unknown>,
  output: unknown
): AuditTarget | undefined {
  const declared = op?.audit?.target?.(input, output);
  if (declared !== undefined) return declared ?? undefined;

  if (output && typeof output === "object" && !Array.isArray(output)) {
    const entries = Object.entries(output as Record<string, unknown>).filter(
      ([, v]) => v && typeof v === "object" && !Array.isArray(v)
    );
    if (entries.length === 1) {
      const [type, value] = entries[0];
      const id = idOf(value, type);
      if (id) return { type, id };
    }
  }
  for (const [key, type] of TARGET_KEYS) {
    if (typeof input[key] === "string" && input[key]) return { type, id: input[key] as string };
  }
  return undefined;
}

// ── Recorders ────────────────────────────────────────────────────────────────

export interface OperationAudit {
  operation: string;
  op?: Pick<Operation, "audit" | "permission">;
  input: Record<string, unknown>;
  success: boolean;
  /** data on success, error on failure. */
  output?: unknown;
  errorCode?: string;
  actor: Actor;
  meta: CallMeta;
  durationMs?: number;
  reportedBy?: "client";
}

export function auditOperation(a: OperationAudit): Promise<AuditEvent | null> {
  const redactKeys = a.op?.audit?.redact;
  return record({
    v: AUDIT_EVENT_VERSION,
    id: a.meta.callId ?? crypto.randomUUID(),
    ts: new Date().toISOString(),
    category: "operation",
    action: a.operation,
    outcome: outcomeFor(a.success, a.errorCode),
    errorCode: a.errorCode,
    actor: a.actor,
    channel: a.meta.channel,
    requestId: a.meta.requestId,
    callId: a.meta.callId,
    parentCallId: a.meta.parentCallId,
    ip: a.meta.ip,
    userAgent: a.meta.userAgent,
    target: a.success ? resolveTarget(a.op, a.input, a.output) : resolveTarget(a.op, a.input, undefined),
    input: redact(a.input, { keys: redactKeys }),
    output: redact(a.output, { keys: redactKeys }),
    durationMs: a.durationMs,
    reportedBy: a.reportedBy,
  });
}

export interface ControlAudit {
  action: string;
  outcome: AuditOutcome;
  errorCode?: string;
  actor: Actor;
  channel?: Channel;
  ip?: string;
  userAgent?: string;
  target?: AuditTarget;
  /** Extra non-sensitive facts (redacted anyway). */
  detail?: Record<string, unknown>;
}

function control(category: AuditCategory, a: ControlAudit): Promise<AuditEvent | null> {
  return record({
    v: AUDIT_EVENT_VERSION,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    category,
    action: a.action,
    outcome: a.outcome,
    errorCode: a.errorCode,
    actor: a.actor,
    channel: a.channel ?? "ui",
    ip: a.ip,
    userAgent: a.userAgent?.slice(0, 300),
    target: a.target,
    output: a.detail ? redact(a.detail) : undefined,
  });
}

/** Sign-in, sign-out, role switch, token issuance, session/client ending. */
export function auditAuth(a: ControlAudit) {
  return control("auth", a);
}

/** Administrative acts: revocations by an admin, exports, retention. */
export function auditAdmin(a: ControlAudit) {
  return control("admin", a);
}

// Importing this module (from a server entry point) is what turns on
// operation auditing in execute(); see ./port.ts.
installAuditRecorder(auditOperation);

/** Actor for an auth event about a known user acting in the browser. */
export function humanActor(user: { id: string; role: Actor["role"] }, sessionId?: string): Actor {
  return { type: "human", userId: user.id, role: user.role, assurance: "verified", sessionId };
}
