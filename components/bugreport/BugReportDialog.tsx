"use client";

import { useMemo, useState } from "react";
import {
  BUG_CATEGORIES, CATEGORY_LABELS,
  type BugCategory, type BugReportInput, type ElementInfo, type SinkResult,
} from "@/lib/bugreport/types";
import { provenanceVerdict } from "@/lib/bugreport/verdict";

interface Props {
  /** Everything captured automatically; the dialog adds the user's words. */
  base: Omit<BugReportInput, "category" | "description" | "expected" | "actual">;
  onClose: () => void;
}

type Outcome = { id: string; sinks: SinkResult[] } | null;

function guessCategory(el?: ElementInfo): BugCategory {
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
  const [category, setCategory] = useState<BugCategory>(guessCategory(el));
  const [description, setDescription] = useState("");
  const [expected, setExpected] = useState("");
  const [actual, setActual] = useState(prov?.uiText ?? el?.text.slice(0, 200) ?? "");
  const [incConsole, setIncConsole] = useState(true);
  const [incNetwork, setIncNetwork] = useState(true);
  const [incShot, setIncShot] = useState(Boolean(base.screenshot));
  const [showJson, setShowJson] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const report: BugReportInput = useMemo(() => ({
    ...base,
    category,
    description: description.trim(),
    ...(expected.trim() ? { expected: expected.trim() } : {}),
    ...(actual.trim() ? { actual: actual.trim() } : {}),
    console: incConsole ? base.console : [],
    network: incNetwork ? base.network : [],
    screenshot: incShot ? base.screenshot : undefined,
  }), [base, category, description, expected, actual, incConsole, incNetwork, incShot]);

  const errorCount = base.console.filter((c) => c.level === "error").length;
  const failedCalls = base.network.filter((n) => n.op?.success === false || (n.status ?? 0) >= 400 || n.error).length;

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
      const data = await res.json() as { success: boolean; data?: Outcome; error?: { message: string } };
      if (!data.success || !data.data) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
      setOutcome(data.data);
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)} — you can still download the report.`);
    } finally {
      setSubmitting(false);
    }
  }

  const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 };
  const ta: React.CSSProperties = { font: "inherit", width: "100%", border: "1px solid #cdd1d9", borderRadius: 6, padding: "8px 12px", resize: "vertical" };

  return (
    <div
      data-bug-reporter-ui=""
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2147483001, padding: 12 }}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div className="card" role="dialog" aria-modal="true" aria-label="Report a bug"
        style={{ width: "100%", maxWidth: 560, maxHeight: "92vh", overflow: "auto", padding: 24 }}>
        <h3 style={{ fontSize: 18, marginBottom: 14 }}>🐞 Report a bug</h3>

        {outcome ? (
          <div>
            <p style={{ marginBottom: 10 }}>Thanks — report <strong>{outcome.id}</strong> was submitted.</p>
            {outcome.sinks.filter((s) => s.sink !== "store").map((s) => (
              <p key={s.sink} style={{ fontSize: 13, color: s.ok ? "#166534" : "#991b1b", marginBottom: 6 }}>
                {s.sink}: {s.ok ? (s.url ? <a href={s.url} target="_blank" rel="noopener" style={{ textDecoration: "underline" }}>{s.ref}</a> : s.ref) : `failed — ${s.error}`}
              </p>
            ))}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" onClick={() => download({ id: outcome.id, ...report }, `bug-report-${outcome.id}.json`)} style={{ background: "#e5e7eb", color: "#374151" }}>Download JSON</button>
              <button type="button" onClick={onClose} style={{ background: "#4f46e5", color: "#fff" }}>Close</button>
            </div>
          </div>
        ) : (
          <>
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
                  placeholder={'e.g. "The table doesn\'t show my reservation from yesterday"'} />
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
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={incConsole} onChange={(e) => setIncConsole(e.target.checked)} />
                  Console ({base.console.length}{errorCount ? `, ${errorCount} errors` : ""})
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={incNetwork} onChange={(e) => setIncNetwork(e.target.checked)} />
                  Network ({base.network.length}{failedCalls ? `, ${failedCalls} failed` : ""})
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", opacity: base.screenshot ? 1 : 0.5 }}>
                  <input type="checkbox" style={{ width: "auto" }} disabled={!base.screenshot} checked={incShot} onChange={(e) => setIncShot(e.target.checked)} />
                  Screenshot{base.screenshot ? "" : " (unavailable)"}
                </label>
              </fieldset>

              {incShot && base.screenshot && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={base.screenshot} alt="Screenshot to be attached" style={{ width: "100%", borderRadius: 6, border: "1px solid #e5e7eb" }} />
              )}

              <div>
                <button type="button" onClick={() => setShowJson((v) => !v)} style={{ fontSize: 12, padding: "2px 0", background: "none", color: "#4f46e5" }}>
                  {showJson ? "Hide" : "Show"} everything that will be sent
                </button>
                {showJson && (
                  <pre style={{ background: "#f4f6f8", borderRadius: 6, padding: 10, fontSize: 11, maxHeight: 220, overflow: "auto", marginTop: 6 }}>
                    {JSON.stringify({ ...report, screenshot: report.screenshot ? `[${Math.round(report.screenshot.length / 1024)} KB image]` : undefined }, null, 2)}
                  </pre>
                )}
              </div>
            </div>

            {error && <p style={{ color: "#991b1b", fontSize: 13, marginTop: 12 }}>{error}</p>}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18, flexWrap: "wrap" }}>
              <button type="button" onClick={onClose} style={{ background: "#e5e7eb", color: "#374151" }}>Cancel</button>
              <button type="button" onClick={() => download(report, `bug-report-${Date.now()}.json`)} style={{ background: "#e5e7eb", color: "#374151" }}>Download JSON</button>
              <button type="button" onClick={submit} disabled={submitting} style={{ background: "#4f46e5", color: "#fff" }}>
                {submitting ? "Sending…" : "Submit"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
