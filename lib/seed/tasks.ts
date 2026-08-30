import { singletonMap, resetMap, isoAt } from "./store";

export interface Task {
  taskId: string;
  title: string;
  department: string;
  priority: "low" | "medium" | "high";
  status: "open" | "in_progress" | "completed" | "cancelled";
  assigneeId?: string;
  /** Front-desk reservation this task relates to, if it was created from one. */
  reservationId?: string;
  createdAt: string;
  updatedAt: string;
}

const TASKS_STORE_KEY = "__tasksStore";

// Original seed assigned tasks to "support_01"/"support_02", which match no
// actual demo user id (u_alice/u_carol/u_bob) — getMyTasks filters by
// `assigneeId === ctx.userId`, so every demo user's My Tasks panel was empty.
// Re-assigned across all three so every role has something to see immediately.
function buildTasksStore(): [string, Task][] {
  return [
    ["task_001", { taskId: "task_001", title: "Clean Room 205", department: "housekeeping", priority: "high", status: "open", assigneeId: "u_carol", createdAt: isoAt(1, 8), updatedAt: isoAt(1, 8) }],
    ["task_002", { taskId: "task_002", title: "Fix AC in Room 312", department: "maintenance", priority: "high", status: "in_progress", assigneeId: "u_bob", createdAt: isoAt(1, 9), updatedAt: isoAt(1, 9, 30) }],
    ["task_003", { taskId: "task_003", title: "Restock minibar Room 101", department: "housekeeping", priority: "low", status: "open", createdAt: isoAt(1, 10), updatedAt: isoAt(1, 10) }],
    ["task_004", { taskId: "task_004", title: "VIP guest arrival preparation", department: "concierge", priority: "medium", status: "open", assigneeId: "u_alice", createdAt: isoAt(1, 11), updatedAt: isoAt(1, 11) }],
    ["task_005", { taskId: "task_005", title: "Replace broken lamp Room 418", department: "maintenance", priority: "medium", status: "completed", assigneeId: "u_carol", createdAt: isoAt(2, 14), updatedAt: isoAt(1, 7) }],
  ];
}
export function tasksStore(): Map<string, Task> { return singletonMap(TASKS_STORE_KEY, buildTasksStore); }
export function resetTasksStore(): void {
  resetMap(TASKS_STORE_KEY, buildTasksStore);
  delete (globalThis as Record<string, unknown>).__tasksSeq;
}
