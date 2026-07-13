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
  var __tasksSeq: number | undefined;
}

const tasks = globalThis.__tasksStore ?? (globalThis.__tasksStore = new Map<string, Task>([
  ["task_001", { taskId: "task_001", title: "Clean Room 205", department: "housekeeping", priority: "high", status: "open", assigneeId: "support_01", createdAt: "2026-07-08T08:00:00Z", updatedAt: "2026-07-08T08:00:00Z" }],
  ["task_002", { taskId: "task_002", title: "Fix AC in Room 312", department: "maintenance", priority: "high", status: "in_progress", assigneeId: "support_02", createdAt: "2026-07-08T09:00:00Z", updatedAt: "2026-07-08T09:30:00Z" }],
  ["task_003", { taskId: "task_003", title: "Restock minibar Room 101", department: "housekeeping", priority: "low", status: "open", createdAt: "2026-07-08T10:00:00Z", updatedAt: "2026-07-08T10:00:00Z" }],
  ["task_004", { taskId: "task_004", title: "VIP guest arrival preparation", department: "concierge", priority: "medium", status: "open", assigneeId: "support_01", createdAt: "2026-07-08T11:00:00Z", updatedAt: "2026-07-08T11:00:00Z" }],
  ["task_005", { taskId: "task_005", title: "Replace broken lamp Room 418", department: "maintenance", priority: "medium", status: "completed", assigneeId: "support_02", createdAt: "2026-07-07T14:00:00Z", updatedAt: "2026-07-08T07:00:00Z" }],
]));

export const createTask = defineOperation({
  name: "createTask",
  title: "Create Task",
  description: "Create an operational task with title, department, priority, and optional assignee.",
  permission: "write",
  roles: ["support", "admin"],
  module: "tasks.management",
  inputSchema: {
    title: z.string().describe("Task title"),
    department: z.string().describe("Department responsible for the task"),
    priority: z.enum(["low", "medium", "high"]).describe("Task priority level"),
    assigneeId: z.string().optional().describe("User ID to assign the task to"),
  },
  async handler({ title, department, priority, assigneeId }, _ctx) {
    globalThis.__tasksSeq = (globalThis.__tasksSeq ?? tasks.size) + 1;
    const taskId = `task_${String(globalThis.__tasksSeq).padStart(3, "0")}`;
    const now = new Date().toISOString();
    const task: Task = {
      taskId,
      title,
      department,
      priority,
      status: "open",
      assigneeId,
      createdAt: now,
      updatedAt: now,
    };
    tasks.set(taskId, task);
    return ok({ task });
  },
});
