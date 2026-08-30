"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";
import { DEMO_USERS } from "@/lib/constants";

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

const STATUSES: Task["status"][] = ["open", "in_progress", "completed", "cancelled"];
const PRIORITIES: Task["priority"][] = ["low", "medium", "high"];

export function TaskSearchCard({ isAdmin }: { isAdmin: boolean }) {
  const { call, storeVersion } = useBridge();
  const [department, setDepartment] = useState("");
  const [status, setStatus] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async () => {
    const params: Record<string, unknown> = {};
    if (department.trim()) params.department = department.trim();
    if (status) params.status = status;
    if (assigneeId) params.assigneeId = assigneeId;
    const res = await call("searchTasks", params) as { success: boolean; data?: { tasks: Task[] } };
    if (res.success && res.data) setTasks(res.data.tasks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, department, status, assigneeId]);

  useEffect(() => { search(); }, [search]);
  useEffect(() => { if (storeVersion > 0) search(); }, [storeVersion, search]);

  async function updateField(taskId: string, field: "status" | "priority" | "assigneeId", value: string) {
    setBusy(taskId);
    setError(null);
    try {
      const res = await call("updateTask", { taskId, [field]: value }) as { success: boolean; error?: { message: string } };
      if (!res.success) setError(res.error?.message ?? "Failed to update task");
      else await search();
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(taskId: string) {
    setBusy(taskId);
    setError(null);
    try {
      // deleteTask carries requiresConfirmation: true — providers.tsx's
      // ConfirmationDialog intercepts this call automatically, no extra code here.
      const res = await call("deleteTask", { taskId, confirm: true }) as { success: boolean; error?: { message: string } };
      if (!res.success && res.error?.message) setError(res.error.message);
      else await search();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Task Search
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>searchTasks / updateTask</span>
      </h2>
      <div className="field-grid" style={{ marginBottom: 14 }}>
        <input placeholder="Department" value={department} onChange={(e) => setDepartment(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Any assignee</option>
          {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>

      {error && <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 10 }}>{error}</p>}

      {tasks.length === 0 ? (
        <p style={{ color: "#9ca3af", fontSize: 13 }}>No tasks match.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {tasks.map((t) => (
            <div key={t.taskId} className="row">
              <span style={{ fontSize: 13, flex: 1 }}>
                <strong>{t.title}</strong>
                <span style={{ marginLeft: 8, fontSize: 11, color: "#6b7280" }}>{t.department}</span>
              </span>
              <select
                value={t.status}
                disabled={busy === t.taskId}
                onChange={(e) => updateField(t.taskId, "status", e.target.value)}
                style={{ width: "auto" }}
              >
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select
                value={t.priority}
                disabled={busy === t.taskId}
                onChange={(e) => updateField(t.taskId, "priority", e.target.value)}
                style={{ width: "auto" }}
              >
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <select
                value={t.assigneeId ?? ""}
                disabled={busy === t.taskId}
                onChange={(e) => updateField(t.taskId, "assigneeId", e.target.value)}
                style={{ width: "auto" }}
              >
                <option value="">unassigned</option>
                {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              {isAdmin && (
                <button
                  type="button"
                  disabled={busy === t.taskId}
                  onClick={() => handleDelete(t.taskId)}
                  style={{ fontSize: 11, padding: "3px 10px", background: "#fee2e2", color: "#991b1b" }}
                >
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
