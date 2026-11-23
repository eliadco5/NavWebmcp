"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ACTOR_COLOR, ACTOR_LABEL, INK, th, td, type ActorKind } from "./shared";

export interface SeriesPoint { t: string; human: number; agent: number; system: number; errors: number; denials: number }

const KINDS: ActorKind[] = ["human", "agent", "system"];
const H = 180;
const PAD = { top: 8, right: 8, bottom: 22, left: 36 };

function niceMax(v: number) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p) * p;
}

/**
 * Calls over time, stacked by who made them (people / agents / system).
 * Stacked bars: one baseline, 2px surface gaps between segments, legend
 * always shown (identity is never color alone), hover tooltip per bar, and a
 * table view — required because the system series is below 3:1 on white.
 */
export function UsageChart({ series, resolution }: { series: SeriesPoint[]; resolution: "minute" | "hour" }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [width, setWidth] = useState(640);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [asTable, series.length]);

  const max = useMemo(() => niceMax(Math.max(1, ...series.map((p) => p.human + p.agent + p.system))), [series]);
  const innerW = Math.max(width - PAD.left - PAD.right, 50);
  const innerH = H - PAD.top - PAD.bottom;
  const slot = series.length ? innerW / series.length : innerW;
  const barW = Math.max(Math.min(slot - 2, 24), 1);
  const y = (v: number) => (v / max) * innerH;
  const fmt = (t: string) => {
    const d = new Date(t);
    return resolution === "minute"
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" });
  };
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(series.length / 6));
  const total = series.reduce((n, p) => n + p.human + p.agent + p.system, 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 8, flexWrap: "wrap" }}>
        {KINDS.map((k) => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: INK.secondary }}>
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: ACTOR_COLOR[k] }} />
            {ACTOR_LABEL[k]}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          style={{ marginLeft: "auto", fontSize: 12, padding: "2px 10px", background: "#f3f4f6", color: INK.secondary }}
        >
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {total === 0 && !asTable ? (
        <p style={{ fontSize: 13, color: INK.muted, padding: "24px 0", textAlign: "center" }}>No calls in this range yet.</p>
      ) : asTable ? (
        <div style={{ maxHeight: 240, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Time", "People", "Agents", "System", "Errors", "Denied"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {series.filter((p) => p.human + p.agent + p.system > 0).map((p) => (
                <tr key={p.t}>
                  <td style={td}>{fmt(p.t)}</td><td style={td}>{p.human}</td><td style={td}>{p.agent}</td>
                  <td style={td}>{p.system}</td><td style={td}>{p.errors}</td><td style={td}>{p.denials}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          ref={boxRef}
          style={{ position: "relative" }}
          onMouseLeave={() => setHover(null)}
        >
          <svg width="100%" height={H} role="img" aria-label={`Calls over time: ${total} total, stacked by people, agents and system`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={PAD.left + innerW} y1={PAD.top + innerH - y(t)} y2={PAD.top + innerH - y(t)} stroke={t === 0 ? INK.axis : INK.grid} strokeWidth={1} />
                <text x={PAD.left - 6} y={PAD.top + innerH - y(t) + 4} fontSize={10} fill={INK.muted} textAnchor="end">{Math.round(t)}</text>
              </g>
            ))}
            {series.map((p, i) => {
              const x = PAD.left + i * slot + (slot - barW) / 2;
              let base = PAD.top + innerH;
              const segs = KINDS.filter((k) => p[k] > 0);
              return (
                <g key={p.t} opacity={hover === null || hover === i ? 1 : 0.45}>
                  {segs.map((k, j) => {
                    const h = y(p[k]);
                    const gap = j > 0 ? 2 : 0; // 2px surface gap between stacked segments
                    const top = base - h;
                    const isTop = j === segs.length - 1;
                    const r = isTop ? Math.min(2, barW / 2, h) : 0;
                    const rect = (
                      <path
                        key={k}
                        d={`M${x},${base - gap} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${base - gap} Z`}
                        fill={ACTOR_COLOR[k]}
                      />
                    );
                    base = top;
                    return rect;
                  })}
                  {i % labelEvery === 0 && (
                    <text x={x + barW / 2} y={H - 6} fontSize={10} fill={INK.muted} textAnchor="middle">{fmt(p.t)}</text>
                  )}
                  {/* Hit target: the whole column, taller and wider than the bar. */}
                  <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
          {hover !== null && series[hover] && (
            <div
              role="tooltip"
              style={{
                position: "absolute", top: 4, left: Math.min(PAD.left + hover * slot + slot + 8, Math.max(width - 170, 0)),
                background: "#fff", border: "1px solid rgba(11,11,11,0.10)", borderRadius: 8, padding: "8px 10px",
                boxShadow: "0 4px 12px rgba(0,0,0,.08)", fontSize: 12, pointerEvents: "none", minWidth: 150,
              }}
            >
              <div style={{ fontWeight: 600, color: INK.primary, marginBottom: 4 }}>{fmt(series[hover].t)}</div>
              {KINDS.map((k) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, color: INK.secondary }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: ACTOR_COLOR[k] }} />{ACTOR_LABEL[k]}
                  </span>
                  <span style={{ color: INK.primary, fontVariantNumeric: "tabular-nums" }}>{series[hover][k]}</span>
                </div>
              ))}
              {(series[hover].errors > 0 || series[hover].denials > 0) && (
                <div style={{ marginTop: 4, color: INK.muted }}>{series[hover].errors} errors · {series[hover].denials} denied</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
