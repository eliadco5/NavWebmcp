"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";

interface InspectionRecord {
  id: string;
  tableId: string;
  inspector: string;
  result: "pass" | "fail";
  notes: string;
  timestamp: string;
}

const TABLE_IDS = ["t_01", "t_02", "t_03", "t_04", "t_05"];

export function InspectionsCard() {
  const { call, storeVersion, user } = useBridge();
  const [tableFilter, setTableFilter] = useState("");
  const [resultFilter, setResultFilter] = useState("");
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);

  const [logTableId, setLogTableId] = useState(TABLE_IDS[0]);
  const [logResult, setLogResult] = useState<"pass" | "fail">("pass");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const params: Record<string, unknown> = {};
    if (tableFilter) params.tableId = tableFilter;
    if (resultFilter) params.result = resultFilter;
    const res = await call("listInspections", params) as { success: boolean; data?: { inspections: InspectionRecord[] } };
    if (res.success && res.data) setInspections(res.data.inspections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, tableFilter, resultFilter]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (storeVersion > 0) refresh(); }, [storeVersion, refresh]);

  async function handleLog(e: React.FormEvent) {
    e.preventDefault();
    if (!notes.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await call("logInspection", {
        tableId: logTableId,
        inspector: user?.id ?? "unknown",
        result: logResult,
        notes: notes.trim(),
      }) as { success: boolean; error?: { message: string } };
      if (!res.success) setError(res.error?.message ?? "Failed to log inspection");
      else {
        setNotes("");
        await refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Inspections
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>listInspections / logInspection</span>
      </h2>

      <form onSubmit={handleLog} style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
        <div className="field-grid">
          <select value={logTableId} onChange={(e) => setLogTableId(e.target.value)}>
            {TABLE_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          <select value={logResult} onChange={(e) => setLogResult(e.target.value as "pass" | "fail")}>
            <option value="pass">pass</option>
            <option value="fail">fail</option>
          </select>
        </div>
        <input placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} required />
        {error && <p style={{ color: "#ef4444", fontSize: 13 }}>{error}</p>}
        <button type="submit" disabled={loading} style={{ background: "#4f46e5", color: "#fff" }}>
          {loading ? "Logging…" : "Log Inspection"}
        </button>
      </form>

      <div className="field-grid" style={{ marginBottom: 12 }}>
        <select value={tableFilter} onChange={(e) => setTableFilter(e.target.value)}>
          <option value="">All tables</option>
          {TABLE_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <select value={resultFilter} onChange={(e) => setResultFilter(e.target.value)}>
          <option value="">Any result</option>
          <option value="pass">pass</option>
          <option value="fail">fail</option>
        </select>
      </div>

      {inspections.length === 0 ? (
        <p style={{ color: "#9ca3af", fontSize: 13 }}>No inspections logged.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {inspections.map((i) => (
            <div key={i.id} className="row">
              <span style={{ fontSize: 13 }}>
                <strong>{i.tableId}</strong> — {i.notes}
                <span style={{ marginLeft: 8, fontSize: 11, color: "#6b7280" }}>{i.inspector}</span>
              </span>
              <span className={`badge ${i.result === "pass" ? "badge-ok" : "badge-err"}`}>{i.result}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
