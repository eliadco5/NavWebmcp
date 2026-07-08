"use client";

import type { AuditEntry } from "@/lib/auditlog";

interface Props {
  entries: AuditEntry[];
}

export function ActivityLog({ entries }: Props) {
  if (entries.length === 0) {
    return <p style={{ color: "#888", fontSize: 13 }}>No activity yet.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {entries.map((e) => (
        <div
          key={e.id}
          style={{
            display: "flex", gap: 10, alignItems: "flex-start",
            fontSize: 12, padding: "6px 0",
            borderBottom: "1px solid #f3f4f6",
          }}
        >
          <span
            className={`badge ${e.source === "agent" ? "badge-agent" : "badge-ui"}`}
            style={{ flexShrink: 0, marginTop: 1 }}
          >
            {e.source}
          </span>
          <span
            className={`badge ${e.success ? "badge-ok" : "badge-err"}`}
            style={{ flexShrink: 0, marginTop: 1 }}
          >
            {e.success ? "ok" : "err"}
          </span>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>{e.operation}</span>
          <span style={{ color: "#9ca3af", flexShrink: 0, marginLeft: "auto" }}>
            {new Date(e.timestamp).toLocaleTimeString()}
          </span>
        </div>
      ))}
    </div>
  );
}
