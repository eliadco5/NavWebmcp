"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";
import { CATEGORY_LABELS, type BugCategory, type BugReport, type BugStatus } from "@/lib/bugreport/types";
import { provenanceVerdict } from "@/lib/bugreport/verdict";

interface Summary {
  id: string; createdAt: string; category: BugCategory; status: BugStatus;
  description: string; reporterRole: string; op?: string; field?: string;
}
type Detail = Omit<BugReport, "screenshot"> & { hasScreenshot: boolean };

const STATUSES: BugStatus[] = ["open", "triaged", "fixed"];
const mono: React.CSSProperties = { fontFamily: "ui-monospace, monospace", fontSize: 12 };
const pre: React.CSSProperties = { ...mono, background: "#f4f6f8", borderRadius: 6, padding: 10, overflow: "auto", maxHeight: 220, whiteSpace: "pre-wrap", wordBreak: "break-all" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: "#374151" }}>{title}</h4>
      {children}
    </div>
  );
}

export function BugReportsPanel() {
  const { call, storeVersion } = useBridge();
  const [reports, setReports] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);

  const refresh = useCallback(async () => {
    const r = await call("listBugReports") as { success: boolean; data?: { reports: Summary[] } };
    if (r.success && r.data) setReports(r.data.reports);
  }, [call]);

  useEffect(() => { refresh(); }, [refresh, storeVersion]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    (async () => {
      const r = await call("getBugReport", { id: selected }) as { success: boolean; data?: { report: Detail } };
      setDetail(r.success && r.data ? r.data.report : null);
    })();
  }, [selected, call]);

  async function setStatus(status: BugStatus) {
    if (!detail) return;
    const r = await call("updateBugReportStatus", { id: detail.id, status }) as { success: boolean };
    if (r.success) {
      setDetail({ ...detail, status });
      refresh();
    }
  }

  function downloadDetail() {
    if (!detail) return;
    const blob = new Blob([JSON.stringify(detail, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `bug-report-${detail.id}.json`;
    a.click();
  }

  const el = detail?.element;
  const prov = el?.provenance;

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 16 }}>
        Bug reports
        <span style={{ marginLeft: 8, fontSize: 12, color: "#9ca3af", fontWeight: 400 }}>(also via listBugReports / getBugReport over MCP)</span>
      </h2>

      {reports.length === 0 ? (
        <p style={{ color: "#888" }}>No bug reports yet. Use 🐞 Report a bug (bottom-right) to file one.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {reports.map((r) => (
            <button
              key={r.id}
              type="button"
              className="row"
              onClick={() => setSelected(selected === r.id ? null : r.id)}
              style={{ textAlign: "left", color: "inherit", outline: selected === r.id ? "2px solid #4f46e5" : undefined }}
            >
              <span style={{ flex: 1, minWidth: 200 }}>
                <span className={`badge ${r.status === "fixed" ? "badge-ok" : r.status === "open" ? "badge-err" : "badge-write"}`}>{r.status}</span>
                <span style={{ marginLeft: 8, fontWeight: 600 }}>{CATEGORY_LABELS[r.category]}</span>
                <span style={{ marginLeft: 8, color: "#374151" }}>{r.description.slice(0, 90)}</span>
              </span>
              <span style={{ fontSize: 12, color: "#6b7280" }}>
                {r.op && <span style={mono}>{r.op}{r.field ? `.${r.field}` : ""} · </span>}
                {r.reporterRole} · {new Date(r.createdAt).toLocaleString()} · <span style={mono}>{r.id}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {detail && (
        <div style={{ marginTop: 20, borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <strong style={mono}>{detail.id}</strong>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select value={detail.status} onChange={(e) => setStatus(e.target.value as BugStatus)} style={{ width: "auto" }}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button type="button" onClick={downloadDetail} style={{ fontSize: 12, background: "#e5e7eb", color: "#374151" }}>Download JSON</button>
            </div>
          </div>

          <p style={{ marginTop: 10 }}>{detail.description}</p>
          <p style={{ fontSize: 13, color: "#374151", marginTop: 6 }}>
            Shows: <strong>{detail.actual ?? "—"}</strong> · Should show: <strong>{detail.expected ?? "—"}</strong>
          </p>
          <p style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
            {detail.reporter.displayName} ({detail.reporter.role}) · {detail.page.url}
            {detail.sinks.filter((s) => s.sink !== "store").map((s) => (
              <span key={s.sink}> · {s.sink}: {s.ok ? (s.url ? <a href={s.url} target="_blank" rel="noopener" style={{ color: "#4f46e5" }}>{s.ref}</a> : s.ref) : `failed (${s.error})`}</span>
            ))}
          </p>

          {detail.hasScreenshot && (
            <Section title="Screenshot">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/bug-report?id=${encodeURIComponent(detail.id)}`} alt="Reported screen" style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid #e5e7eb" }} />
            </Section>
          )}

          {el && (
            <Section title="Element">
              <div style={mono}>{el.component && <strong>&lt;{el.component}&gt; </strong>}{el.selector}</div>
              {el.componentStack.length > 0 && <div style={{ ...mono, color: "#6b7280", marginTop: 4 }}>{el.componentStack.join(" ← ")}</div>}
              <pre style={{ ...pre, marginTop: 6 }}>{el.outerHTML}</pre>
            </Section>
          )}

          {prov && (
            <Section title="Data provenance">
              <div style={{ padding: 8, borderRadius: 6, background: "#eef2ff", color: "#3730a3", fontSize: 13 }}>{provenanceVerdict(prov, detail.expected)}</div>
              <pre style={{ ...pre, marginTop: 6 }}>{JSON.stringify({ op: prov.op, params: prov.params, field: prov.field, entity: prov.entity, apiValue: prov.apiValue, uiText: prov.uiText }, null, 2)}</pre>
            </Section>
          )}

          <Section title={`Business calls (${detail.calls.length}) — replay with invoke()`}>
            <pre style={pre}>{detail.calls.map((c) => `${c.success === false ? "✗" : "✓"} ${c.name} ${JSON.stringify(c.params)}`).join("\n") || "—"}</pre>
          </Section>

          <Section title={`Console (${detail.console.length})`}>
            <pre style={pre}>{detail.console.map((c) => `[${c.level}] ${c.ts.slice(11, 19)} ${c.message}`).join("\n") || "—"}</pre>
          </Section>

          <Section title={`Network (${detail.network.length})`}>
            <pre style={pre}>{detail.network.map((n) => `${n.status ?? "ERR"} ${n.method} ${n.url}${n.op ? ` [${n.op.name}]` : ""} ${n.durationMs}ms`).join("\n") || "—"}</pre>
          </Section>
        </div>
      )}
    </div>
  );
}
