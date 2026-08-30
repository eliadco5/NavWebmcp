"use client";

import { useState } from "react";
import { useBridge } from "@/app/providers";

interface WaitTimeResult {
  partySize: number;
  estimatedWaitMinutes: number;
  tableAvailable: boolean;
  message: string;
}

// Lives in the reservations tab (not front desk) specifically so customers can
// reach getWaitTime — it's one of the few frontoffice.* ops open to every role.
export function WaitTimeCard() {
  const { call } = useBridge();
  const [partySize, setPartySize] = useState(2);
  const [result, setResult] = useState<WaitTimeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCheck(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await call("getWaitTime", { partySize }) as {
        success: boolean;
        data?: WaitTimeResult;
        error?: { message: string };
      };
      if (res.success && res.data) setResult(res.data);
      else setError(res.error?.message ?? "Failed to check wait time");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Wait Time
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>walk-ins</span>
      </h2>
      <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 14 }}>
        Estimated wait for a walk-in party right now.
      </p>
      <form onSubmit={handleCheck} style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        <label style={{ fontSize: 13, color: "#374151", flex: 1 }}>
          Party size
          <input
            type="number"
            value={partySize}
            onChange={(e) => setPartySize(Number(e.target.value))}
            min={1}
            max={20}
            required
          />
        </label>
        <button type="submit" disabled={loading} style={{ background: "#4f46e5", color: "#fff" }}>
          {loading ? "Checking…" : "Check"}
        </button>
      </form>

      {error && <p style={{ color: "#ef4444", fontSize: 13, marginTop: 10 }}>{error}</p>}

      {result && (
        <div className="row" style={{ marginTop: 12, background: result.tableAvailable ? "#dcfce7" : "#f9fafb" }}>
          <span style={{ fontSize: 13 }}>{result.message}</span>
          <span
            className={`badge ${result.tableAvailable ? "badge-ok" : "badge-write"}`}
          >
            {result.tableAvailable ? "available now" : `~${result.estimatedWaitMinutes} min`}
          </span>
        </div>
      )}
    </div>
  );
}
