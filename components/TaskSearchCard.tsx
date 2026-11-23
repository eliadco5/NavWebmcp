"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useBridge } from "@/app/providers";
import { DEMO_USERS, DEMO_USER_IDS } from "@/lib/constants";
import { useAgentComponent } from "@/lib/ui-components/useAgentComponent";
import { tableStateSchema } from "@/lib/ui-components/kinds";
import type { Provenance } from "@/lib/provenance";
import { ProvenanceBadge } from "./ProvenanceBadge";

interface Task {
  taskId: string;
  title: string;
  department: string;
  priority: "low" | "medium" | "high";
  status: "open" | "in_progress" | "completed" | "cancelled";
  assigneeId?: string;
  reservationId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: Provenance;
  lastModifiedBy?: Provenance;
}

const STATUSES = ["open", "in_progress", "completed", "cancelled"] as const;
const PRIORITIES: Task["priority"][] = ["low", "medium", "high"];
// Must match searchTasks' sortBy enum (lib/operations/searchTasks.ts).
const SORT_COLUMNS = ["createdAt", "updatedAt", "priority", "title", "status"] as const;
const SORT_LABELS: Record<(typeof SORT_COLUMNS)[number], string> = {
  createdAt: "Created", updatedAt: "Updated", priority: "Priority", title: "Title", status: "Status",
};

// Agent-operable state (kind "table", docs/ui-components.md). The filters mirror
// searchTasks' inputs, so whatever an agent sets here is exactly what the
// user's own controls could set.
const TABLE_SCHEMA = tableStateSchema(
  {
    department: z.string().min(1).max(100).optional().describe("Exact department name, e.g. housekeeping"),
    status: z.enum(STATUSES).optional().describe("Task status"),
    assigneeId: z.enum(DEMO_USER_IDS).optional().describe("Assigned user id"),
    reservationId: z.string().min(1).max(64).optional().describe("Linked reservation id"),
  },
  SORT_COLUMNS
);
type TableState = z.infer<typeof TABLE_SCHEMA>;
const INITIAL_STATE: TableState = { filters: {}, sort: [] };

export function TaskSearchCard({ isAdmin }: { isAdmin: boolean }) {
  const { call, storeVersion } = useBridge();
  const [table, setTable] = useState<TableState>(INITIAL_STATE);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { filters, sort } = table;

  const setFilter = (key: keyof TableState["filters"], value: string) =>
    setTable((t) => {
      const next = { ...t.filters };
      if (value) (next as Record<string, string>)[key] = value;
      else delete next[key];
      return { ...t, filters: next };
    });

  const search = useCallback(async () => {
    const params: Record<string, unknown> = {};
    if (filters.department?.trim()) params.department = filters.department.trim();
    if (filters.status) params.status = filters.status;
    if (filters.assigneeId) params.assigneeId = filters.assigneeId;
    if (filters.reservationId?.trim()) params.reservationId = filters.reservationId.trim();
    if (sort[0]) {
      params.sortBy = sort[0].column;
      params.sortDir = sort[0].direction;
    }
    const res = await call("searchTasks", params) as { success: boolean; data?: { tasks: Task[] } };
    if (res.success && res.data) setTasks(res.data.tasks);
  }, [call, filters, sort]);

  useEffect(() => { search(); }, [search]);
  useEffect(() => { if (storeVersion > 0) search(); }, [storeVersion, search]);

  const searchRef = useRef(search);
  searchRef.current = search;
  useAgentComponent({
    id: "tasks.table",
    kind: "table",
    title: "Task Search",
    description: "The Tasks tab's task list. Filters and sort change what the user sees; rows come from searchTasks.",
    schema: TABLE_SCHEMA,
    state: table,
    setState: setTable,
    initialState: INITIAL_STATE,
    actions: {
      refresh: { description: "Re-run the search with the current filters", run: () => searchRef.current() },
    },
    view: { total: tasks.length, shown: tasks.length },
  });

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
        <input placeholder="Department" value={filters.department ?? ""} onChange={(e) => setFilter("department", e.target.value)} />
        <select value={filters.status ?? ""} onChange={(e) => setFilter("status", e.target.value)}>
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filters.assigneeId ?? ""} onChange={(e) => setFilter("assigneeId", e.target.value)}>
          <option value="">Any assignee</option>
          {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input placeholder="Reservation ID" value={filters.reservationId ?? ""} onChange={(e) => setFilter("reservationId", e.target.value)} />
        <select
          aria-label="Sort by"
          value={sort[0]?.column ?? ""}
          onChange={(e) => {
            const column = e.target.value as (typeof SORT_COLUMNS)[number] | "";
            setTable((t) => ({ ...t, sort: column ? [{ column, direction: t.sort[0]?.direction ?? "asc" }] : [] }));
          }}
        >
          <option value="">Default order</option>
          {SORT_COLUMNS.map((c) => <option key={c} value={c}>Sort: {SORT_LABELS[c]}</option>)}
        </select>
        <select
          aria-label="Sort direction"
          value={sort[0]?.direction ?? "asc"}
          disabled={!sort[0]}
          onChange={(e) => {
            const direction = e.target.value as "asc" | "desc";
            setTable((t) => ({ ...t, sort: t.sort[0] ? [{ ...t.sort[0], direction }] : [] }));
          }}
        >
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
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
                {t.reservationId && (
                  <span className="badge" style={{ marginLeft: 8, background: "#e0f2fe", color: "#0369a1" }}>
                    {t.reservationId}
                  </span>
                )}
                {t.lastModifiedBy
                  ? <ProvenanceBadge p={t.lastModifiedBy} verb="Updated by" />
                  : <ProvenanceBadge p={t.createdBy} />}
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
