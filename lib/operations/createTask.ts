import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { tasksStore, type Task } from "@/lib/seed";

// __tasksSeq is a plain working counter (not seed data), so it stays local —
// every other global store lives in lib/seed/*.ts now.
declare global {
  var __tasksSeq: number | undefined;
}

const tasks = tasksStore();

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
