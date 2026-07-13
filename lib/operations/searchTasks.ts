import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";

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

declare global {
  var __tasksStore: Map<string, Task> | undefined;
}

const tasks = globalThis.__tasksStore ?? (globalThis.__tasksStore = new Map<string, Task>([
  ["task_001", { taskId: "task_001", title: "Clean Room 205", department: "housekeeping", priority: "high", status: "open", assigneeId: "support_01", createdAt: "2026-07-08T08:00:00Z", updatedAt: "2026-07-08T08:00:00Z" }],
  ["task_002", { taskId: "task_002", title: "Fix AC in Room 312", department: "maintenance", priority: "high", status: "in_progress", assigneeId: "support_02", createdAt: "2026-07-08T09:00:00Z", updatedAt: "2026-07-08T09:30:00Z" }],
  ["task_003", { taskId: "task_003", title: "Restock minibar Room 101", department: "housekeeping", priority: "low", status: "open", createdAt: "2026-07-08T10:00:00Z", updatedAt: "2026-07-08T10:00:00Z" }],
  ["task_004", { taskId: "task_004", title: "VIP guest arrival preparation", department: "concierge", priority: "medium", status: "open", assigneeId: "support_01", createdAt: "2026-07-08T11:00:00Z", updatedAt: "2026-07-08T11:00:00Z" }],
  ["task_005", { taskId: "task_005", title: "Replace broken lamp Room 418", department: "maintenance", priority: "medium", status: "completed", assigneeId: "support_02", createdAt: "2026-07-07T14:00:00Z", updatedAt: "2026-07-08T07:00:00Z" }],
]));

export const searchTasks = defineOperation({
  name: "searchTasks",
  title: "Search Tasks",
  description: "Search open tasks by department, status, or assignee.",
  permission: "read",
  roles: ["support", "admin"],
  module: "tasks.management",
  inputSchema: {
    department: z.string().optional().describe("Filter by department"),
    status: z.enum(["open", "in_progress", "completed", "cancelled"]).optional().describe("Filter by task status"),
    assigneeId: z.string().optional().describe("Filter by assigned user ID"),
  },
  async handler({ department, status, assigneeId }, _ctx) {
    const results = [...tasks.values()].filter((t) => {
      if (department !== undefined && t.department !== department) return false;
      if (status !== undefined && t.status !== status) return false;
      if (assigneeId !== undefined && t.assigneeId !== assigneeId) return false;
      return true;
    });
    return ok({ tasks: results, total: results.length });
  },
});
