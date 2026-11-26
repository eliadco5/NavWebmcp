import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { tasksStore, type Task } from "@/lib/seed";
import { Id, ShortText, TaskStatus, TaskSchema } from "./schemas";

const tasks = tasksStore();

export const TASK_SORT_COLUMNS = ["createdAt", "updatedAt", "priority", "title", "status"] as const;
export type TaskSortColumn = (typeof TASK_SORT_COLUMNS)[number];

// Rank, not alphabetical: "high" sorts above "medium" when descending.
const PRIORITY_RANK: Record<Task["priority"], number> = { low: 0, medium: 1, high: 2 };
// Workflow order, so "open" comes first when ascending.
const STATUS_RANK: Record<Task["status"], number> = { open: 0, in_progress: 1, completed: 2, cancelled: 3 };

function compareTasks(a: Task, b: Task, column: TaskSortColumn): number {
  switch (column) {
    case "priority": return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    case "status": return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    default: return a[column].localeCompare(b[column]);
  }
}

export const searchTasks = defineOperation({
  name: "searchTasks",
  title: "Search Tasks",
  description: "Search open tasks by department, status, assignee, or linked reservation. Optionally sort the results.",
  permission: "read",
  roles: ["support", "admin"],
  module: "tasks.management",
  list: { key: "tasks", id: "taskId" },
  inputSchema: {
    department: ShortText(100).optional().describe("Filter by department"),
    status: TaskStatus.optional().describe("Filter by task status"),
    assigneeId: Id().optional().describe("Filter by assigned user ID"),
    reservationId: Id().optional().describe("Filter by related reservation ID"),
    sortBy: z.enum(TASK_SORT_COLUMNS).optional()
      .describe("Sort column. priority sorts by rank (low < medium < high), status by workflow order. Omit for store order"),
    sortDir: z.enum(["asc", "desc"]).optional().describe("Sort direction; defaults to asc. Ignored without sortBy"),
  },
  outputSchema: {
    tasks: z.array(TaskSchema),
    total: z.number().int(),
  },
  untrustedOutput: true,
  async handler({ department, status, assigneeId, reservationId, sortBy, sortDir }, _ctx) {
    const results = [...tasks.values()].filter((t) => {
      if (department !== undefined && t.department !== department) return false;
      if (status !== undefined && t.status !== status) return false;
      if (assigneeId !== undefined && t.assigneeId !== assigneeId) return false;
      if (reservationId !== undefined && t.reservationId !== reservationId) return false;
      return true;
    });
    if (sortBy) {
      const sign = sortDir === "desc" ? -1 : 1;
      // Array.prototype.sort is stable, so ties keep store order.
      results.sort((a, b) => sign * compareTasks(a, b, sortBy));
    }
    return ok({ tasks: results, total: results.length });
  },
});
