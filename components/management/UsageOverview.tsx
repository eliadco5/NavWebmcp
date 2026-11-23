"use client";

import { useCallback, useEffect, useState } from "react";
import type { UsageSummary } from "@/lib/telemetry/summary";
import { UsageChart } from "./UsageChart";
import { ACTOR_COLOR, INK, SectionTitle, Status, adminApi, th, td } from "./shared";

const RANGES = [
  { id: "1h", label: "Last hour", ms: 3_600_000 },
  { id: "24h", label: "24 hours", ms: 86_400_000 },
  { id: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { id: "30d", label: "30 days", ms: 30 * 86_400_000 },
] as const;

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 14px", minWidth: 0 }}>
      <div style={{ fontSize: 12, color: INK.secondary }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 650, color: INK.primary, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: INK.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function UsageOverview() {
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("24h");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const ms = RANGES.find((r) => r.id === range)!.ms;
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    try {
      setData(await adminApi<UsageSummary>(`metrics?from=${from.toISOString()}&to=${to.toISOString()}`));
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, [range]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const lat = data?.latency;
  return (
    <div className="col">
      <div className="card">
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <SectionTitle hint="Every operation call, split by who made it. Refreshes every 15s.">Usage</SectionTitle>
          <div role="group" aria-label="Time range" style={{ display: "flex", gap: 4 }}>
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={range === r.id}
                onClick={() => setRange(r.id)}
                style={{ fontSize: 12, padding: "4px 10px", background: range === r.id ? "#4f46e5" : "#f3f4f6", color: range === r.id ? "#fff" : INK.secondary }}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {error && <p style={{ color: "#991b1b", fontSize: 13 }}>{error}</p>}
        {data && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
              <Tile label="Calls" value={data.totals.calls.toLocaleString()} sub={`${data.totals.topLevelCalls.toLocaleString()} requests · ${data.totals.callsPerRequest ?? "—"} calls/request`} />
              <Tile
                label="Changes made by agents"
                value={pct(data.adoption.agentShareOfWrites)}
                sub={`${data.byActorType.agent.writes} of ${data.totals.writes} writes`}
              />
              <Tile label="Active" value={`${data.adoption.activeUsers} users`} sub={`${data.adoption.activeAgentClients} agent clients`} />
              <Tile
                label="Connected now"
                value={data.connections ? `${data.connections.humanSessions} people` : "—"}
                sub={data.connections ? `${data.connections.agentClients} MCP agents` : undefined}
              />
              <Tile label="Errors / denied" value={`${pct(data.totals.errorRate)} / ${pct(data.totals.denialRate)}`} sub={`${data.totals.errors} errors · ${data.totals.denials} denied`} />
              <Tile
                label={`p99 latency (target ≤ ${lat?.sloMs} ms)`}
                value={lat?.p99Ms === null || lat?.p99Ms === undefined ? (data.totals.calls ? "> 5 s" : "—") : `≤ ${lat.p99Ms} ms`}
                sub={data.totals.calls ? <Status kind={lat?.sloMet ? "good" : "critical"} label={lat?.sloMet ? "Within target" : "Over target"} /> : "No calls yet"}
              />
            </div>
            <UsageChart series={data.series} resolution={data.range.resolution} />
          </>
        )}
      </div>

      {data && data.operations.length > 0 && (
        <div className="card">
          <SectionTitle hint="Busiest operations in the range, and who calls them.">Operations</SectionTitle>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>{["Operation", "Kind", "Calls", "People", "Agents", "System", "Errors", "Denied", "p95"].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {data.operations.map((o) => (
                  <tr key={o.operation}>
                    <td style={{ ...td, fontWeight: 600 }}>{o.operation}</td>
                    <td style={td}>{o.kind}</td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{o.calls}</td>
                    {(["human", "agent", "system"] as const).map((k) => (
                      <td key={k} style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                        <span aria-hidden="true" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: ACTOR_COLOR[k], marginRight: 6, opacity: o.byActorType[k] ? 1 : 0.25 }} />
                        {o.byActorType[k]}
                      </td>
                    ))}
                    <td style={td}>{o.errors}</td>
                    <td style={td}>{o.denials}</td>
                    <td style={td}>{o.p95Ms === null ? "—" : `≤ ${o.p95Ms} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
