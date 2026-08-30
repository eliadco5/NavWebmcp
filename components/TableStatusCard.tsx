"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";

interface TableStatusRecord {
  tableId: string;
  status: "clean" | "dirty" | "in-progress";
  lastUpdated: string;
  updatedBy: string;
}

const STATUS_COLORS: Record<TableStatusRecord["status"], { bg: string; text: string }> = {
  clean: { bg: "#dcfce7", text: "#166534" },
  dirty: { bg: "#fee2e2", text: "#991b1b" },
  "in-progress": { bg: "#fef3c7", text: "#92400e" },
};

export function TableStatusCard() {
  const { call, storeVersion, user } = useBridge();
  const [tables, setTables] = useState<TableStatusRecord[]>([]);
  const [summary, setSummary] = useState<{ clean: number; dirty: number; inProgress: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await call("getTableCleaningStatus") as {
      success: boolean;
      data?: { tables: TableStatusRecord[]; summary: { clean: number; dirty: number; inProgress: number } };
    };
    if (res.success && res.data) {
      setTables(res.data.tables);
      setSummary(res.data.summary);
    }
  }, [call]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (storeVersion > 0) refresh(); }, [storeVersion, refresh]);

  async function handleStatusChange(tableId: string, status: TableStatusRecord["status"]) {
    setBusy(tableId);
    try {
      await call("updateTableStatus", { tableId, status, updatedBy: user?.id ?? "unknown" });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Table Cleaning Status
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>getTableCleaningStatus / updateTableStatus</span>
      </h2>

      {summary && (
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <span className="badge badge-ok">{summary.clean} clean</span>
          <span className="badge badge-err">{summary.dirty} dirty</span>
          <span className="badge badge-write">{summary.inProgress} in progress</span>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {tables.map((t) => (
          <div key={t.tableId} className="row">
            <span style={{ fontSize: 13 }}>
              <strong>{t.tableId}</strong>
              <span
                className="badge"
                style={{ marginLeft: 8, background: STATUS_COLORS[t.status].bg, color: STATUS_COLORS[t.status].text }}
              >
                {t.status}
              </span>
            </span>
            <select
              value={t.status}
              disabled={busy === t.tableId}
              onChange={(e) => handleStatusChange(t.tableId, e.target.value as TableStatusRecord["status"])}
              style={{ width: "auto" }}
            >
              <option value="clean">clean</option>
              <option value="dirty">dirty</option>
              <option value="in-progress">in-progress</option>
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
