import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { tasksStore, type Task } from "@/lib/seed";

const tasks = tasksStore();

export const completeTask = defineOperation({
  name: "completeTask",
  title: "Complete Task",
  description: "Mark a task assigned to the current user as completed.",
  permission: "write",
  roles: ["customer", "support", "admin"],
  module: "tasks.assignments",
  inputSchema: {
    taskId: z.string().describe("ID of the task to mark as completed"),
  },
  async handler({ taskId }, ctx) {
    const task = tasks.get(taskId);
    if (!task) return fail("NOT_FOUND", `Task ${taskId} not found`);

    // customers may only complete tasks assigned to themselves; support/admin may complete any
    if (ctx.role === "customer" && task.assigneeId !== ctx.userId) {
      return fail("FORBIDDEN", "You can only complete tasks assigned to you");
    }

    if (task.status === "completed") return fail("CONFLICT", "Task is already completed");
    if (task.status === "cancelled") return fail("CONFLICT", "Cannot complete a cancelled task");

    const updated: Task = { ...task, status: "completed", updatedAt: new Date().toISOString() };
    tasks.set(taskId, updated);
    return ok({ task: updated });
  },
});
