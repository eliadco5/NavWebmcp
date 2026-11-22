"use client";

import { useState } from "react";
import type { ScenarioStep } from "@/lib/bugreport/types";

const KIND_ICON: Record<ScenarioStep["kind"], string> = {
  click: "🖱", input: "⌨", select: "▾", submit: "↵", navigate: "↪",
};

function describe(step: ScenarioStep): string {
  const t = step.target;
  const what = t ? (t.label || t.text || t.component || t.selector).slice(0, 70) : "";
  if (step.kind === "navigate") return `Go to ${step.value || "page"}`;
  if (step.kind === "input") return `Type into ${what || "field"}: "${(step.value ?? "").slice(0, 40)}"`;
  if (step.kind === "select") return `Choose "${(step.value ?? "").slice(0, 40)}" in ${what || "list"}`;
  if (step.kind === "submit") return `Submit ${what || "form"}`;
  return `Click ${what ? `"${what}"` : t?.tag ?? "element"}`;
}

/** Numbered step list; each step shows the business calls it triggered.
 *  In the admin view, clicking a step seeks the replay (onSeek). */
export function ScenarioSteps({ steps, compact, onSeek, activeIndex }: {
  steps: ScenarioStep[];
  compact?: boolean;
  onSeek?: (step: ScenarioStep) => void;
  activeIndex?: number;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (steps.length === 0) return <p style={{ color: "#6b7280", fontSize: 12 }}>No steps were recorded.</p>;
  return (
    <ol style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
      {steps.map((s) => (
        <li key={s.index} style={{
          background: activeIndex === s.index ? "#eef2ff" : compact ? "transparent" : "#f9fafb",
          border: compact ? "none" : "1px solid #e5e7eb", borderRadius: 6, padding: compact ? "1px 0" : "6px 8px",
        }}>
          <div
            onClick={() => { onSeek?.(s); if (!compact) setOpen(open === s.index ? null : s.index); }}
            style={{ display: "flex", gap: 6, alignItems: "baseline", cursor: onSeek || !compact ? "pointer" : "default", flexWrap: "wrap" }}
          >
            <span style={{ color: "#9ca3af", minWidth: 18 }}>{s.index + 1}.</span>
            <span aria-hidden>{KIND_ICON[s.kind]}</span>
            <span>{describe(s)}</span>
            {!compact && <span style={{ color: "#9ca3af" }}>{(s.tOffsetMs / 1000).toFixed(1)}s</span>}
            {s.calls.map((c, i) => (
              <span key={i} className={`badge ${c.success === false ? "badge-err" : "badge-ok"}`} style={{ textTransform: "none", letterSpacing: 0 }}>
                {c.name}{c.success === false ? ` ✗${c.errorCode ? ` ${c.errorCode}` : ""}` : ""}
              </span>
            ))}
          </div>
          {!compact && open === s.index && s.calls.length > 0 && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
              {s.calls.map((c, i) => (
                <pre key={i} style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 4, padding: 6, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 160, overflow: "auto" }}>
                  {`${c.name}(${JSON.stringify(c.params)})\n→ ${c.resultPreview ?? "(no response captured)"}`}
                </pre>
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
