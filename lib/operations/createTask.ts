import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { tasksStore, type Task } from "@/lib/seed";
import { Id, ShortText, TaskPriority, TaskSchema } from "./schemas";

// __tasksSeq is a plain working counter (not seed data), so it stays local —
// every other global store lives in lib/seed/*.ts now.
declare global {
  var __tasksSeq: number | undefined;
}

const tasks = tasksStore();

export const createTask = defineOperation({
  name: "createTask",
  title: "Create Task",
  description: "Create an operational task with title, department, priority, and optional assignee. Pass reservationId to link it to a front-desk reservation.",
  permission: "write",
  roles: ["support", "admin"],
  module: "tasks.management",
  inputSchema: {
    title: ShortText().min(1).describe("Task title"),
    department: ShortText(100).min(1).describe("Department responsible for the task"),
    priority: TaskPriority.describe("Task priority level"),
    assigneeId: Id().optional().describe("User ID to assign the task to"),
    reservationId: Id().optional().describe("Front-desk reservation this task relates to, if any"),
  },
  outputSchema: { task: TaskSchema },
  async handler({ title, department, priority, assigneeId, reservationId }, _ctx) {
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
      reservationId,
      createdAt: now,
      updatedAt: now,
    };
    tasks.set(taskId, task);
    return ok({ task });
  },
});
