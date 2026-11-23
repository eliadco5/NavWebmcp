// The management service: what admins (through /api/admin/* and the UI) and
// admins' agents (through the admin.* operations) can see and do. One
// implementation for both, so the two surfaces can't drift.
//
// Server-only. Importing it installs it into ./port.ts for the operations.
import { auditAdmin, queryAudit, verifyAuditChain } from "@/lib/audit";
import { getUsageSummary } from "@/lib/telemetry";
import type { Actor } from "@/lib/operations/types";
import { revokeRecord, getClient, getEnd, getSession, listClients, listSessions } from "./sessions";
import { installManagement, type ManagementPort, type RevokeInfo, type RevokeResult } from "./port";


async function revoke(
  kind: "session" | "agentClient",
  id: string,
  exists: boolean,
  by: Actor,
  info: RevokeInfo = {}
): Promise<RevokeResult> {
  if (!exists) return { revoked: false, found: false };
  const already = await getEnd(id);
  // Upgrades a logout to a revocation; a no-op if already revoked.
  const revoked = await revokeRecord(id, by.userId);
  await auditAdmin({
    action: kind === "session" ? "admin.session_revoked" : "admin.agent_client_revoked",
    outcome: "success",
    actor: by,
    channel: info.channel ?? "ui",
    ip: info.ip,
    userAgent: info.userAgent,
    target: { type: kind, id },
    detail: { alreadyEnded: Boolean(already), previousEnd: already?.reason },
  });
  return { revoked, found: true };
}

export const managementService: ManagementPort = {
  queryAudit: (q) => queryAudit(q),
  verifyAudit: () => verifyAuditChain(),
  usageSummary: (q) => getUsageSummary(q),
  listSessions: (f) => listSessions(f),
  listClients: (f) => listClients(f),
  async revokeSession(sid, by, info) {
    return revoke("session", sid, Boolean(await getSession(sid)), by, info);
  },
  async revokeClient(clientId, by, info) {
    return revoke("agentClient", clientId, Boolean(await getClient(clientId)), by, info);
  },
};

installManagement(managementService);
