"use client";

import { useEffect, useState } from "react";
import { useBridge } from "@/app/providers";

interface DailySummary {
  date: string;
  totalRevenue: number;
  totalCovers: number;
  transactionCount: number;
  adjustmentTotal: number;
  netRevenue: number;
  byCategory?: Record<string, number>;
  byMethod?: Record<string, number>;
}

interface WeeklySummary {
  weekStartDate: string;
  weekEndDate: string;
  totalRevenue: number;
  netRevenue: number;
  totalCovers: number;
  totalTransactions: number;
  days: DailySummary[];
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function BreakdownBars({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  if (entries.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>{title}</p>
      {entries.map(([k, v]) => (
        <div key={k} style={{ marginBottom: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span>{k}</span>
            <span>${v.toFixed(2)}</span>
          </div>
          <div style={{ background: "#e5e7eb", borderRadius: 3, height: 6 }}>
            <div style={{ background: "#4f46e5", borderRadius: 3, height: 6, width: `${(v / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="row" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
      <span style={{ fontSize: 11, color: "#6b7280" }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

export function RevenueCard() {
  const { call } = useBridge();
  const [date, setDate] = useState(todayISO());
  const [daily, setDaily] = useState<DailySummary | null>(null);
  const [weekStart, setWeekStart] = useState(todayISO());
  const [weekly, setWeekly] = useState<WeeklySummary | null>(null);
  const [loading, setLoading] = useState(false);

  // Load today's summary on mount — an admin landing on this tab should see
  // real numbers immediately, not an empty state waiting for a manual click.
  useEffect(() => { loadDaily(date); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadDaily(d: string) {
    setLoading(true);
    try {
      const res = await call("getDailyRevenueSummary", { date: d }) as { success: boolean; data?: DailySummary };
      if (res.success && res.data) setDaily(res.data);
    } finally {
      setLoading(false);
    }
  }

  async function loadWeekly(d: string) {
    const res = await call("getWeeklyRevenueSummary", { weekStartDate: d }) as { success: boolean; data?: WeeklySummary };
    if (res.success && res.data) setWeekly(res.data);
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Revenue
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>getDailyRevenueSummary / getWeeklyRevenueSummary</span>
      </h2>

      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button type="button" disabled={loading} onClick={() => loadDaily(date)} style={{ background: "#4f46e5", color: "#fff" }}>
          {loading ? "Loading…" : "Load Day"}
        </button>
      </div>

      {daily && (
        <>
          <div className="field-grid">
            <KpiTile label="Total revenue" value={`$${daily.totalRevenue.toFixed(2)}`} />
            <KpiTile label="Net revenue" value={`$${daily.netRevenue.toFixed(2)}`} />
            <KpiTile label="Covers" value={String(daily.totalCovers)} />
            <KpiTile label="Transactions" value={String(daily.transactionCount)} />
          </div>
          {daily.byCategory && <BreakdownBars title="By category" data={daily.byCategory} />}
          {daily.byMethod && <BreakdownBars title="By method" data={daily.byMethod} />}
        </>
      )}

      <div style={{ display: "flex", gap: 10, margin: "16px 0 12px" }}>
        <input type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
        <button type="button" onClick={() => loadWeekly(weekStart)} style={{ background: "#f3f4f6", color: "#374151" }}>
          Load Week
        </button>
      </div>

      {weekly && (
        <>
          <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
            {weekly.weekStartDate} → {weekly.weekEndDate} · ${weekly.totalRevenue.toFixed(2)} total · {weekly.totalTransactions} transactions
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {weekly.days.map((d) => (
              <div key={d.date} className="row">
                <span style={{ fontSize: 12 }}>{d.date}</span>
                <span style={{ fontSize: 12, color: "#6b7280" }}>${d.totalRevenue.toFixed(2)} · {d.transactionCount} tx</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
