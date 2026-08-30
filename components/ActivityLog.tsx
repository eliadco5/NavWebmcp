"use client";

import { useState } from "react";
import type { AuditEntry } from "@/lib/auditlog";

interface Props {
  entries: AuditEntry[];
}

export function ActivityLog({ entries }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (entries.length === 0) {
    return <p style={{ color: "#888", fontSize: 13 }}>No activity yet.</p>;
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 560, overflowY: "auto" }}>
      {entries.map((e) => {
        const isOpen = expanded.has(e.id);
        const hasDetail = Object.keys(e.input ?? {}).length > 0 || e.output !== undefined;
        return (
          <div key={e.id} style={{ borderBottom: "1px solid #f3f4f6", paddingBottom: isOpen ? 8 : 0 }}>
            <button
              type="button"
              onClick={() => hasDetail && toggle(e.id)}
              aria-expanded={isOpen}
              style={{
                display: "flex", gap: 10, alignItems: "flex-start", width: "100%",
                fontSize: 12, padding: "6px 0", background: "none", border: "none",
                cursor: hasDetail ? "pointer" : "default", textAlign: "left", color: "inherit",
              }}
            >
              {hasDetail && (
                <span style={{ flexShrink: 0, marginTop: 1, color: "#9ca3af", width: 10 }}>
                  {isOpen ? "▾" : "▸"}
                </span>
              )}
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
            </button>

            {isOpen && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginLeft: 20, marginTop: 2 }}>
                <div>
                  <p style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 4 }}>
                    Request — what the {e.source === "agent" ? "agent" : "UI"} sent
                  </p>
                  <pre style={{
                    fontSize: 11, background: "#f3f4f6", borderRadius: 6, padding: 8,
                    overflowX: "auto", margin: 0, maxHeight: 200,
                  }}>
                    {JSON.stringify(e.input ?? {}, null, 2)}
                  </pre>
                </div>
                <div>
                  <p style={{
                    fontSize: 11, fontWeight: 600, marginBottom: 4,
                    color: e.success ? "#166534" : "#991b1b",
                  }}>
                    {e.success ? "Response — what the platform returned" : "Error — what the platform returned"}
                  </p>
                  <pre style={{
                    fontSize: 11, background: e.success ? "#f0fdf4" : "#fef2f2", borderRadius: 6, padding: 8,
                    overflowX: "auto", margin: 0, maxHeight: 200,
                  }}>
                    {e.output !== undefined ? JSON.stringify(e.output, null, 2) : "(no data)"}
                  </pre>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
