import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";

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

export const updateTask = defineOperation({
  name: "updateTask",
  title: "Update Task",
  description: "Update the status, priority, or assignee of an existing task.",
  permission: "write",
  roles: ["support", "admin"],
  module: "tasks.management",
  inputSchema: {
    taskId: z.string().describe("ID of the task to update"),
    status: z.enum(["open", "in_progress", "completed", "cancelled"]).optional().describe("New task status"),
    priority: z.enum(["low", "medium", "high"]).optional().describe("New task priority"),
    assigneeId: z.string().optional().describe("User ID to reassign the task to"),
  },
  async handler({ taskId, status, priority, assigneeId }, _ctx) {
    const task = tasks.get(taskId);
    if (!task) return fail("NOT_FOUND", `Task ${taskId} not found`);

    const updated: Task = {
      ...task,
      ...(status !== undefined && { status }),
      ...(priority !== undefined && { priority }),
      ...(assigneeId !== undefined && { assigneeId }),
      updatedAt: new Date().toISOString(),
    };
    tasks.set(taskId, updated);
    return ok({ task: updated });
  },
});
