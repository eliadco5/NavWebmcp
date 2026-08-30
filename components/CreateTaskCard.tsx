"use client";

import { useState } from "react";
import { useBridge } from "@/app/providers";
import { DEMO_USERS } from "@/lib/constants";

export function CreateTaskCard({ onCreated }: { onCreated?: () => void }) {
  const { call } = useBridge();
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");
  const [assigneeId, setAssigneeId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !department.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await call("createTask", {
        title: title.trim(),
        department: department.trim(),
        priority,
        ...(assigneeId && { assigneeId }),
      }) as { success: boolean; error?: { message: string } };
      if (!res.success) {
        setError(res.error?.message ?? "Failed to create task");
      } else {
        setTitle("");
        setDepartment("");
        setAssigneeId("");
        onCreated?.();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        New Task
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>createTask</span>
      </h2>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 10 }}>
        <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <div className="field-grid">
          <input placeholder="Department" value={department} onChange={(e) => setDepartment(e.target.value)} required />
          <select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">Unassigned</option>
            {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        {error && <p style={{ color: "#ef4444", fontSize: 13 }}>{error}</p>}
        <button type="submit" disabled={loading} style={{ background: "#4f46e5", color: "#fff" }}>
          {loading ? "Creating…" : "Create Task"}
        </button>
      </form>
    </div>
  );
}
