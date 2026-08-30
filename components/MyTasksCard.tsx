"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";

interface Task {
  taskId: string;
  title: string;
  department: string;
  priority: "low" | "medium" | "high";
  status: "open" | "in_progress" | "completed" | "cancelled";
  assigneeId?: string;
  createdAt: string;
  updatedAt: string;
}

const PRIORITY_COLORS: Record<Task["priority"], { bg: string; text: string }> = {
  low: { bg: "#e0f2fe", text: "#0369a1" },
  medium: { bg: "#fef3c7", text: "#92400e" },
  high: { bg: "#fee2e2", text: "#991b1b" },
};

export function MyTasksCard() {
  const { call, storeVersion } = useBridge();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await call("getMyTasks") as { success: boolean; data?: { tasks: Task[] } };
    if (res.success && res.data) setTasks(res.data.tasks);
  }, [call]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (storeVersion > 0) refresh(); }, [storeVersion, refresh]);

  async function handleComplete(taskId: string) {
    setBusy(taskId);
    setError(null);
    try {
      const res = await call("completeTask", { taskId }) as { success: boolean; error?: { message: string } };
      if (!res.success) setError(res.error?.message ?? "Failed to complete task");
      else await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        My Tasks
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>assigned to you</span>
      </h2>
      <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 14 }}>getMyTasks / completeTask</p>

      {error && <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 10 }}>{error}</p>}

      {tasks.length === 0 ? (
        <p style={{ color: "#9ca3af", fontSize: 13 }}>No tasks assigned to you.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {tasks.map((t) => (
            <div key={t.taskId} className="row">
              <span style={{ fontSize: 13 }}>
                <strong>{t.title}</strong>
                <span style={{ marginLeft: 8, fontSize: 11, color: "#6b7280" }}>{t.department}</span>
                <span
                  className="badge"
                  style={{ marginLeft: 8, background: PRIORITY_COLORS[t.priority].bg, color: PRIORITY_COLORS[t.priority].text }}
                >
                  {t.priority}
                </span>
              </span>
              {t.status === "completed" ? (
                <span className="badge badge-ok">completed</span>
              ) : t.status === "cancelled" ? (
                <span className="badge badge-err">cancelled</span>
              ) : (
                <button
                  type="button"
                  disabled={busy === t.taskId}
                  onClick={() => handleComplete(t.taskId)}
                  style={{ fontSize: 11, padding: "3px 10px", background: "#dcfce7", color: "#166534" }}
                >
                  {busy === t.taskId ? "Completing…" : "Complete"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
