"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";

interface ScheduleItem {
  id: string;
  tableId: string;
  scheduledTime: string;
  assignee: string;
  task: string;
  done: boolean;
  completedAt?: string;
}

export function CleaningScheduleCard() {
  const { call, storeVersion } = useBridge();
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [counts, setCounts] = useState<{ total: number; completed: number; pending: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await call("getTodaySchedule") as {
      success: boolean;
      data?: { scheduleItems: ScheduleItem[]; total: number; completed: number; pending: number };
    };
    if (res.success && res.data) {
      setItems(res.data.scheduleItems);
      setCounts({ total: res.data.total, completed: res.data.completed, pending: res.data.pending });
    }
  }, [call]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (storeVersion > 0) refresh(); }, [storeVersion, refresh]);

  async function handleDone(scheduleId: string) {
    setBusy(scheduleId);
    try {
      await call("markScheduleItemDone", { scheduleId });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Today&apos;s Cleaning Schedule
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>getTodaySchedule / markScheduleItemDone</span>
      </h2>
      {counts && (
        <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 14 }}>
          {counts.completed} of {counts.total} done · {counts.pending} pending
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((item) => (
          <div key={item.id} className="row">
            <span style={{ fontSize: 13 }}>
              <strong>{item.scheduledTime}</strong> · {item.tableId} · {item.task}
              <span style={{ marginLeft: 8, fontSize: 11, color: "#6b7280" }}>{item.assignee}</span>
            </span>
            {item.done ? (
              <span className="badge badge-ok">done</span>
            ) : (
              <button
                type="button"
                disabled={busy === item.id}
                onClick={() => handleDone(item.id)}
                style={{ fontSize: 11, padding: "3px 10px", background: "#dcfce7", color: "#166534" }}
              >
                {busy === item.id ? "Marking…" : "Mark Done"}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
