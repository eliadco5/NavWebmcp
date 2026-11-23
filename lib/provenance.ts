// "Who created this reservation?" answered on the record itself.
//
// Every record an operation creates or changes carries a Provenance stamp:
// whether a person, an agent or the platform did it, on whose behalf, through
// which surface, and the id of the audit event with the full details (the
// audit event id IS the call id — lib/audit/index.ts). The stamp is a
// convenience for display and filtering; the audit trail stays the system of
// record, and the two point at each other.
//
// Client-safe (no Node imports): the UI renders these.
import type { ActorType, Channel, OperationContext } from "@/lib/operations/types";
import type { Role } from "@/lib/auth";

export interface Provenance {
  at: string;
  actorType: ActorType;
  /** The accountable user (for agents: the user who authorised the agent). */
  userId: string;
  role: Role;
  channel: Channel;
  /** Agent client id, when an agent did it. */
  agentClientId?: string;
  /** Agent software name, when known (self-reported by the agent). */
  agentName?: string;
  sessionId?: string;
  /** Audit event id for this change (= the operation call id). */
  auditId?: string;
  requestId?: string;
}

/** Stamp for a change made by the call running with `ctx`. */
export function stamp(ctx: OperationContext, at = new Date().toISOString()): Provenance {
  const actor = ctx.actor;
  const meta = ctx.meta;
  return {
    at,
    actorType: actor?.type ?? "system",
    userId: actor?.userId ?? ctx.userId,
    role: actor?.role ?? ctx.role,
    channel: meta?.channel ?? "internal",
    ...(actor?.agent?.clientId && { agentClientId: actor.agent.clientId }),
    ...(actor?.agent?.name && { agentName: actor.agent.name }),
    ...(actor?.sessionId && { sessionId: actor.sessionId }),
    ...(meta?.callId && { auditId: meta.callId }),
    ...(meta?.requestId && { requestId: meta.requestId }),
  };
}

/** Fields an entity gets. Optional: records made before provenance existed
 *  (and seed data) simply have none. */
export interface Provenanced {
  createdBy?: Provenance;
  lastModifiedBy?: Provenance;
}

const CHANNEL_LABEL: Record<Channel, string> = {
  ui: "the app",
  webmcp: "in-page agent",
  mcp: "MCP",
  internal: "system",
};

/** "Alice · via Claude (MCP)", "Alice (the app)", "System". */
export function describeProvenance(p: Provenance, displayName?: (userId: string) => string | undefined): string {
  if (p.actorType === "system") return "System";
  const who = displayName?.(p.userId) ?? p.userId;
  if (p.actorType === "agent") {
    const agent = p.agentName ?? "an agent";
    return `${who} · via ${agent} (${CHANNEL_LABEL[p.channel]})`;
  }
  return `${who} (${CHANNEL_LABEL[p.channel]})`;
}
