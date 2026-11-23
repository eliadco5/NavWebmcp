// Indirection between the admin.* management operations and the server-side
// management service — same reason as lib/audit/port.ts: the operation
// registry is bundled into the browser, the service needs Redis and
// node:crypto. lib/management/service.ts installs itself here when a server
// entry point imports it (app/api/call/route.ts, lib/adapters/mcp.ts).
import type { Actor, Channel } from "@/lib/operations/types";
import type { AuditEvent } from "@/lib/audit/types";
import type { AuditQuery } from "@/lib/audit/store";
import type { ChainVerification } from "@/lib/audit/chain";
import type { UsageQuery, UsageSummary } from "@/lib/telemetry/summary";
import type { ClientView, SessionView } from "./sessions";

export interface RevokeInfo {
  ip?: string;
  userAgent?: string;
  /** Surface the revocation came through (the admin UI, or an agent). */
  channel?: Channel;
}

export interface RevokeResult {
  /** False when it was already ended (still reported as success: idempotent). */
  revoked: boolean;
  found: boolean;
}

export interface ManagementPort {
  queryAudit(q: AuditQuery): Promise<{ events: AuditEvent[]; nextBeforeSeq?: number }>;
  verifyAudit(): Promise<ChainVerification & { durable: boolean }>;
  usageSummary(q: UsageQuery): Promise<UsageSummary>;
  listSessions(filter: { userId?: string }): Promise<SessionView[]>;
  listClients(filter: { userId?: string }): Promise<ClientView[]>;
  revokeSession(sid: string, by: Actor, info?: RevokeInfo): Promise<RevokeResult>;
  revokeClient(clientId: string, by: Actor, info?: RevokeInfo): Promise<RevokeResult>;
}

declare global {
  // eslint-disable-next-line no-var
  var __managementPort: ManagementPort | undefined;
}

export function installManagement(port: ManagementPort): void {
  globalThis.__managementPort = port;
}

export function management(): ManagementPort | undefined {
  return globalThis.__managementPort;
}
