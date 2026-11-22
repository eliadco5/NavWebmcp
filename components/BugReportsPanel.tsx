"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useBridge } from "@/app/providers";
import { CATEGORY_LABELS, type AttachmentKind, type BugCategory, type BugReport, type BugStatus } from "@/lib/bugreport/types";
import { provenanceVerdict } from "@/lib/bugreport/verdict";
import { formatBytes } from "@/lib/bugreport/clientTypes";
import { ScenarioSteps } from "./bugreport/ScenarioSteps";
import { ReplayPlayer, type ReplayHandle } from "./bugreport/ReplayPlayer";

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

const attUrl = (id: string, kind: AttachmentKind) => `/api/bug-report/${encodeURIComponent(id)}/attachments/${kind}`;

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }); }}
      style={{ fontSize: 11, padding: "2px 8px", background: "#e5e7eb", color: "#374151" }}>
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function ScenarioDetail({ detail }: { detail: Detail }) {
  const sc = detail.scenario!;
  const has = (k: AttachmentKind) => detail.attachments.some((a) => a.kind === k);
  const replay = useRef<ReplayHandle>(null);
  const [active, setActive] = useState<number | undefined>();
  const [tab, setTab] = useState<"invoke" | "playwright">("invoke");
  const img: React.CSSProperties = { width: "100%", borderRadius: 6, border: "1px solid #e5e7eb" };

  return (
    <>
      <Section title={`Scenario — ${sc.steps.length} steps · ${Math.round(sc.durationMs / 1000)}s${sc.truncated ? " · stopped at limit" : ""}`}>
        {sc.videoNote && <p style={{ fontSize: 12, color: "#92400e", marginBottom: 6 }}>{sc.videoNote}</p>}
        <div style={{ display: "grid", gridTemplateColumns: has("replay") ? "minmax(0, 3fr) minmax(220px, 2fr)" : "1fr", gap: 12, alignItems: "start" }}>
          {has("replay") && (
            <div style={{ overflow: "auto" }}>
              <ReplayPlayer ref={replay} src={attUrl(detail.id, "replay")} width={560} />
            </div>
          )}
          <div style={{ maxHeight: 420, overflow: "auto" }}>
            <ScenarioSteps steps={sc.steps} activeIndex={active}
              onSeek={has("replay") ? (s) => { setActive(s.index); replay.current?.seekTo(Date.parse(s.ts)); } : undefined} />
          </div>
        </div>
      </Section>

      {has("video") && (
        <Section title="Screen video">
          <video controls src={attUrl(detail.id, "video")} style={{ maxWidth: "100%", borderRadius: 6, background: "#000" }} />
        </Section>
      )}

      {(has("before") || has("after")) && (
        <Section title="Before / after">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <figure>{has("before") ? <img src={attUrl(detail.id, "before")} alt="Before" style={img} /> : "—"}<figcaption style={{ fontSize: 12, color: "#6b7280" }}>Before (recording started)</figcaption></figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <figure>{has("after") ? <img src={attUrl(detail.id, "after")} alt="After" style={img} /> : "—"}<figcaption style={{ fontSize: 12, color: "#6b7280" }}>After (recording stopped)</figcaption></figure>
          </div>
        </Section>
      )}

      {detail.repro && (
        <Section title="Reproduce">
          <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
            <button type="button" className="tab" aria-selected={tab === "invoke"} onClick={() => setTab("invoke")}>Agent: invoke({"{"} calls {"}"})</button>
            <button type="button" className="tab" aria-selected={tab === "playwright"} onClick={() => setTab("playwright")}>Playwright</button>
            <span style={{ flex: 1 }} />
            <CopyButton text={tab === "invoke" ? JSON.stringify(detail.repro.invoke, null, 2) : detail.repro.playwright} />
          </div>
          <pre style={{ ...pre, maxHeight: 320 }}>{tab === "invoke" ? JSON.stringify(detail.repro.invoke, null, 2) : detail.repro.playwright}</pre>
        </Section>
      )}
    </>
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

          {detail.attachments.length > 0 && (
            <p style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
              Attachments: {detail.attachments.map((a) => (
                <a key={a.kind} href={attUrl(detail.id, a.kind)} target="_blank" rel="noopener" style={{ color: "#4f46e5", marginRight: 10 }}>{a.kind} ({formatBytes(a.bytes)})</a>
              ))}
            </p>
          )}

          {detail.scenario && <ScenarioDetail key={detail.id} detail={detail} />}

          {detail.hasScreenshot && (
            <Section title={detail.scenario ? "Picked element" : "Screenshot"}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={attUrl(detail.id, "screenshot")} alt="Reported screen" style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid #e5e7eb" }} />
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
