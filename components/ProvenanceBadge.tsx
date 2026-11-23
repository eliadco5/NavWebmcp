"use client";

import { DEMO_USERS } from "@/lib/constants";
import { describeProvenance, type Provenance } from "@/lib/provenance";

const nameOf = (userId: string) => DEMO_USERS.find((u) => u.id === userId)?.name;

/**
 * "Created by Alice · via Claude (MCP)". Tells a person's change from an
 * agent's at a glance; the tooltip carries the audit event id so the full
 * record can be looked up in the audit trail.
 */
export function ProvenanceBadge({ p, verb = "Created by" }: { p?: Provenance; verb?: string }) {
  if (!p) return null;
  const isAgent = p.actorType === "agent";
  const title = [
    `${verb} ${describeProvenance(p, nameOf)}`,
    new Date(p.at).toLocaleString(),
    p.agentClientId && `Agent client: ${p.agentClientId}`,
    p.auditId && `Audit event: ${p.auditId}`,
  ].filter(Boolean).join("\n");
  return (
    <span
      className={`badge ${isAgent ? "badge-agent" : "badge-ui"}`}
      title={title}
      data-actor-type={p.actorType}
      style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, textTransform: "none", letterSpacing: 0 }}
    >
      <span aria-hidden="true">{isAgent ? "🤖 " : p.actorType === "human" ? "👤 " : "⚙ "}</span>
      {verb} {describeProvenance(p, nameOf)}
    </span>
  );
}
