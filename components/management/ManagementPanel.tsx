"use client";

import { useEffect, useState } from "react";
import { UsageOverview } from "./UsageOverview";
import { AuditExplorer } from "./AuditExplorer";
import { AccessPanel } from "./AccessPanel";
import { UsersPanel } from "../UsersPanel";
import { INK, SectionTitle, Status, adminApi } from "./shared";

type View = "overview" | "audit" | "access" | "users";
const VIEWS: { id: View; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "audit", label: "Audit trail" },
  { id: "access", label: "Sessions & agents" },
  { id: "users", label: "Users" },
];

interface Health {
  redis: { configured: boolean; connected: boolean };
  audit: { durable: boolean; retentionDays: number; hmacKey: string; sinks: { name: string; enabled: boolean }[] };
  telemetry: { otlpTraces: boolean; otlpMetrics: boolean };
  warnings: string[];
}

/** Is the management layer in a compliant configuration? Shown above every view. */
function HealthBanner() {
  const [h, setH] = useState<Health | null>(null);
  useEffect(() => { adminApi<Health>("health").then(setH).catch(() => setH(null)); }, []);
  if (!h) return null;
  return (
    <div className="card" style={{ padding: "12px 16px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Status kind={h.audit.durable ? "good" : "warning"} label={h.audit.durable ? "Audit trail durable" : "Audit trail in memory only"} />
        <span style={{ fontSize: 12, color: INK.secondary }}>Retention {h.audit.retentionDays} days</span>
        <span style={{ fontSize: 12, color: INK.secondary }}>
          Export: {h.audit.sinks.filter((s) => s.enabled).map((s) => s.name).join(", ") || "none"}
        </span>
        <span style={{ fontSize: 12, color: INK.secondary }}>
          OpenTelemetry: {h.telemetry.otlpTraces || h.telemetry.otlpMetrics ? "on" : "off"}
        </span>
      </div>
      {h.warnings.length > 0 && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "#92400e" }}>
          {h.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Admin-only: usage, the audit trail, who's connected, and the user roster. */
export function ManagementPanel() {
  const [view, setView] = useState<View>("overview");
  const [focus, setFocus] = useState<{ targetType: string; targetId: string } | null>(null);
  const showHistory = (targetType: string, targetId: string) => {
    setFocus({ targetType, targetId });
    setView("audit");
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div>
        <SectionTitle hint="Monitor how the app is used by people and by agents, audit every change, and control access.">Management</SectionTitle>
        <div data-intro="mgmt-views" role="tablist" aria-label="Management views" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              onClick={() => { setView(v.id); if (v.id === "audit") setFocus(null); }}
              style={{ fontSize: 13, padding: "6px 12px", background: view === v.id ? "#4f46e5" : "#fff", color: view === v.id ? "#fff" : INK.secondary, border: "1px solid #e5e7eb" }}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div data-intro="mgmt-health"><HealthBanner /></div>
      {view === "overview" && <UsageOverview />}
      {view === "audit" && <AuditExplorer focus={focus} />}
      {view === "access" && <AccessPanel onHistory={showHistory} />}
      {view === "users" && <UsersPanel />}
    </div>
  );
}
