"use client";

import { useMemo, useState } from "react";
import {
  BUG_CATEGORIES, CATEGORY_LABELS,
  type AttachmentKind, type BugCategory, type BugReportInput, type ElementInfo, type SinkResult,
} from "@/lib/bugreport/types";
import { provenanceVerdict } from "@/lib/bugreport/verdict";
import { FILE_LABELS, formatBytes, type CapturedBase } from "@/lib/bugreport/clientTypes";
import { ScenarioSteps } from "./ScenarioSteps";

interface Props {
  base: CapturedBase;
  onClose: () => void;
}

type Outcome = { id: string; sinks: SinkResult[] } | null;
type UploadState = "pending" | "uploading" | "done" | "failed";

function guessCategory(el: ElementInfo | undefined, isScenario: boolean): BugCategory {
  if (isScenario) return "scenario";
  if (!el) return "missing-data";
  if (el.provenance) return "wrong-value";
  if (/^h[1-6]$|^label$|^th$|^button$/.test(el.tag)) return "wrong-label";
  return "other";
}

function download(report: unknown, name: string) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BugReportDialog({ base, onClose }: Props) {
  const el = base.element;
  const prov = el?.provenance;
  const scenario = base.scenario;
  const [category, setCategory] = useState<BugCategory>(guessCategory(el, Boolean(scenario)));
  const [description, setDescription] = useState("");
  const [expected, setExpected] = useState("");
  const [actual, setActual] = useState(prov?.uiText ?? el?.text.slice(0, 200) ?? "");
  const [incConsole, setIncConsole] = useState(true);
  const [incNetwork, setIncNetwork] = useState(true);
  const [incFiles, setIncFiles] = useState<Record<string, boolean>>(() => Object.fromEntries(base.files.map((f) => [f.kind, true])));
  const [showJson, setShowJson] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploads, setUploads] = useState<Partial<Record<AttachmentKind, UploadState>>>({});
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const report: BugReportInput = useMemo(() => ({
    ...(({ files: _f, ...rest }) => rest)(base),
    category,
    description: description.trim(),
    ...(expected.trim() ? { expected: expected.trim() } : {}),
    ...(actual.trim() ? { actual: actual.trim() } : {}),
    console: incConsole ? base.console : [],
    network: incNetwork ? base.network : [],
  }), [base, category, description, expected, actual, incConsole, incNetwork]);

  const files = base.files.filter((f) => incFiles[f.kind]);
  const errorCount = base.console.filter((c) => c.level === "error").length;
  const failedCalls = base.network.filter((n) => n.op?.success === false || (n.status ?? 0) >= 400 || n.error).length;
  const images = (kind: AttachmentKind) => base.files.find((f) => f.kind === kind && incFiles[kind])?.previewUrl;

  /** JSON download embeds images as data URLs; replay/video are too big for that. */
  function downloadable() {
    const embedded = Object.fromEntries(files.filter((f) => f.previewUrl).map((f) => [f.kind, f.previewUrl]));
    return { ...report, ...(Object.keys(embedded).length ? { images: embedded } : {}) };
  }

  async function submit() {
    if (!report.description) { setError("Please describe the problem."); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      });
      const data = await res.json() as { success: boolean; data?: { id: string; sinks: SinkResult[]; uploadToken: string }; error?: { message: string } };
      if (!data.success || !data.data) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
      const { id, uploadToken } = data.data;

      // The report exists now; each upload can fail on its own without losing it.
      setUploads(Object.fromEntries(files.map((f) => [f.kind, "uploading"])));
      await Promise.all(files.map(async (f) => {
        try {
          const r = await fetch(`/api/bug-report/${encodeURIComponent(id)}/attachments/${f.kind}`, {
            method: "PUT",
            headers: { "Content-Type": f.blob.type, "x-upload-token": uploadToken },
            body: f.blob,
          });
          setUploads((u) => ({ ...u, [f.kind]: r.ok ? "done" : "failed" }));
        } catch {
          setUploads((u) => ({ ...u, [f.kind]: "failed" }));
        }
      }));

      const fin = await fetch(`/api/bug-report/${encodeURIComponent(id)}/finalize`, { method: "POST", headers: { "x-upload-token": uploadToken } });
      const finData = await fin.json().catch(() => null) as { data?: { sinks: SinkResult[] } } | null;
      setOutcome({ id, sinks: finData?.data?.sinks ?? data.data.sinks });
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)} — you can still download the report.`);
    } finally {
      setSubmitting(false);
    }
  }

  const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 };
  const ta: React.CSSProperties = { font: "inherit", width: "100%", border: "1px solid #cdd1d9", borderRadius: 6, padding: "8px 12px", resize: "vertical" };
  const check: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center" };
  const thumb: React.CSSProperties = { width: "100%", borderRadius: 6, border: "1px solid #e5e7eb" };
  const failedUploads = Object.entries(uploads).filter(([, s]) => s === "failed").map(([k]) => FILE_LABELS[k as AttachmentKind]);

  return (
    <div
      data-bug-reporter-ui=""
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2147483001, padding: 12 }}
      onKeyDown={(e) => { if (e.key === "Escape" && !submitting) onClose(); }}
    >
      <div className="card" role="dialog" aria-modal="true" aria-label="Report a bug"
        style={{ width: "100%", maxWidth: 600, maxHeight: "92vh", overflow: "auto", padding: 24 }}>
        <h3 style={{ fontSize: 18, marginBottom: 14 }}>🐞 Report a bug</h3>

        {outcome ? (
          <div>
            <p style={{ marginBottom: 10 }}>Thanks — report <strong>{outcome.id}</strong> was submitted.</p>
            {failedUploads.length > 0 && (
              <p style={{ fontSize: 13, color: "#991b1b", marginBottom: 6 }}>Couldn&apos;t upload: {failedUploads.join(", ")}.</p>
            )}
            {outcome.sinks.filter((s) => s.sink !== "store").map((s) => (
              <p key={s.sink} style={{ fontSize: 13, color: s.ok ? "#166534" : "#991b1b", marginBottom: 6 }}>
                {s.sink}: {s.ok ? (s.url ? <a href={s.url} target="_blank" rel="noopener" style={{ textDecoration: "underline" }}>{s.ref}</a> : s.ref) : `failed — ${s.error}`}
              </p>
            ))}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" onClick={() => download({ id: outcome.id, ...downloadable() }, `bug-report-${outcome.id}.json`)} style={{ background: "#e5e7eb", color: "#374151" }}>Download JSON</button>
              <button type="button" onClick={onClose} style={{ background: "#4f46e5", color: "#fff" }}>Close</button>
            </div>
          </div>
        ) : (
          <>
            {scenario && (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 10, marginBottom: 14, fontSize: 12 }}>
                <strong>Recorded scenario</strong> · {scenario.steps.length} steps · {Math.round(scenario.durationMs / 1000)}s
                {scenario.truncated && " · stopped at the limit"}
                {scenario.videoNote && <div style={{ color: "#92400e", marginTop: 4 }}>{scenario.videoNote}</div>}
                <div style={{ marginTop: 8, maxHeight: 180, overflow: "auto" }}>
                  <ScenarioSteps steps={scenario.steps} compact />
                </div>
                {(images("before") || images("after")) && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <figure>{images("before") && <img src={images("before")} alt="Before" style={thumb} />}<figcaption style={{ color: "#6b7280" }}>Before</figcaption></figure>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <figure>{images("after") && <img src={images("after")} alt="After" style={thumb} />}<figcaption style={{ color: "#6b7280" }}>After</figcaption></figure>
                  </div>
                )}
              </div>
            )}

            {el && (
              <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, marginBottom: 14, fontSize: 12 }}>
                <div style={{ fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>
                  {el.component && <strong>&lt;{el.component}&gt; </strong>}{el.selector}
                </div>
                {el.text && <div style={{ color: "#6b7280", marginTop: 4 }}>“{el.text.slice(0, 140)}”</div>}
                {prov && (
                  <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: "#eef2ff", color: "#3730a3" }}>
                    {provenanceVerdict(prov, expected)}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <label style={label} htmlFor="bug-category">What kind of problem?</label>
                <select id="bug-category" value={category} onChange={(e) => setCategory(e.target.value as BugCategory)}>
                  {BUG_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                </select>
              </div>
              <div>
                <label style={label} htmlFor="bug-desc">Describe it *</label>
                <textarea id="bug-desc" rows={3} style={ta} autoFocus value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder={scenario ? 'e.g. "After checking in, the table still shows as available"' : 'e.g. "The table doesn\'t show my reservation from yesterday"'} />
              </div>
              <div className="field-grid">
                <div>
                  <label style={label} htmlFor="bug-actual">What it shows</label>
                  <input id="bug-actual" value={actual} onChange={(e) => setActual(e.target.value)} />
                </div>
                <div>
                  <label style={label} htmlFor="bug-expected">What it should show</label>
                  <input id="bug-expected" value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="e.g. 2" />
                </div>
              </div>

              <fieldset style={{ border: "none", fontSize: 13, color: "#374151", display: "flex", gap: 14, flexWrap: "wrap" }}>
                <legend style={{ ...label, marginBottom: 6 }}>Attach</legend>
                <label style={check}>
                  <input type="checkbox" style={{ width: "auto" }} checked={incConsole} onChange={(e) => setIncConsole(e.target.checked)} />
                  Console ({base.console.length}{errorCount ? `, ${errorCount} errors` : ""})
                </label>
                <label style={check}>
                  <input type="checkbox" style={{ width: "auto" }} checked={incNetwork} onChange={(e) => setIncNetwork(e.target.checked)} />
                  Network ({base.network.length}{failedCalls ? `, ${failedCalls} failed` : ""})
                </label>
                {base.files.map((f) => (
                  <label key={f.kind} style={check}>
                    <input type="checkbox" style={{ width: "auto" }} checked={!!incFiles[f.kind]} onChange={(e) => setIncFiles((s) => ({ ...s, [f.kind]: e.target.checked }))} />
                    {FILE_LABELS[f.kind]} ({formatBytes(f.blob.size)})
                    {uploads[f.kind] === "uploading" && " ⏳"}{uploads[f.kind] === "done" && " ✓"}{uploads[f.kind] === "failed" && " ✗"}
                  </label>
                ))}
                {!base.files.some((f) => f.kind === "screenshot") && !scenario && <span style={{ opacity: 0.5 }}>Screenshot (unavailable)</span>}
              </fieldset>

              {images("screenshot") && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={images("screenshot")} alt="Screenshot to be attached" style={thumb} />
              )}

              <div>
                <button type="button" onClick={() => setShowJson((v) => !v)} style={{ fontSize: 12, padding: "2px 0", background: "none", color: "#4f46e5" }}>
                  {showJson ? "Hide" : "Show"} everything that will be sent
                </button>
                {showJson && (
                  <pre style={{ background: "#f4f6f8", borderRadius: 6, padding: 10, fontSize: 11, maxHeight: 220, overflow: "auto", marginTop: 6 }}>
                    {JSON.stringify({ ...report, attachments: files.map((f) => `${f.kind}: ${formatBytes(f.blob.size)}`) }, null, 2)}
                  </pre>
                )}
              </div>
            </div>

            {error && <p style={{ color: "#991b1b", fontSize: 13, marginTop: 12 }}>{error}</p>}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18, flexWrap: "wrap" }}>
              <button type="button" onClick={onClose} disabled={submitting} style={{ background: "#e5e7eb", color: "#374151" }}>Cancel</button>
              <button type="button" onClick={() => download(downloadable(), `bug-report-${Date.now()}.json`)} style={{ background: "#e5e7eb", color: "#374151" }}>Download JSON</button>
              <button type="button" onClick={submit} disabled={submitting} style={{ background: "#4f46e5", color: "#fff" }}>
                {submitting ? (Object.keys(uploads).length ? "Uploading…" : "Sending…") : "Submit"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
