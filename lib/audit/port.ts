// Indirection between execute() and the audit store — same reason as
// lib/ui-relay/port.ts: the operation registry (and so execute) is bundled
// into the browser, while lib/audit needs node:crypto and the Redis client,
// which must never reach the client bundle. lib/audit/index.ts installs itself
// here when a SERVER entry point imports it (app/api/call/route.ts,
// lib/adapters/mcp.ts, the auth routes).
import type { OperationAudit } from "./index";

export type AuditRecorder = (a: OperationAudit) => Promise<unknown>;

declare global {
  // eslint-disable-next-line no-var
  var __auditRecorder: AuditRecorder | undefined;
}

export function installAuditRecorder(fn: AuditRecorder): void {
  globalThis.__auditRecorder = fn;
}

export function auditRecorder(): AuditRecorder | undefined {
  return globalThis.__auditRecorder;
}
