import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { tasksStore, type Task } from "@/lib/seed";
import { Id, TaskStatus, TaskPriority, TaskSchema } from "./schemas";

const tasks = tasksStore();

export const updateTask = defineOperation({
  name: "updateTask",
  title: "Update Task",
  description: "Update the status, priority, or assignee of an existing task.",
  permission: "write",
  roles: ["support", "admin"],
  module: "tasks.management",
  inputSchema: {
    taskId: Id().describe("ID of the task to update"),
    status: TaskStatus.optional().describe("New task status"),
    priority: TaskPriority.optional().describe("New task priority"),
    assigneeId: Id().optional().describe("User ID to reassign the task to"),
  },
  outputSchema: { task: TaskSchema },
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
