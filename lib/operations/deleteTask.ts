import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { tasksStore } from "@/lib/seed";
import { Id, Confirm } from "./schemas";

const tasks = tasksStore();

export const deleteTask = defineOperation({
  name: "deleteTask",
  title: "Delete Task",
  description:
    "Permanently delete a task. Admin only. Destructive: call without confirm first to get a preview and a " +
    "confirmationToken.",
  permission: "write",
  roles: ["admin"],
  module: "tasks.management",
  requiresConfirmation: true,
  inputSchema: {
    taskId: Id().describe("ID of the task to permanently delete"),
    confirm: Confirm(),
  },
  outputSchema: {
    deleted: z.literal(true),
    taskId: z.string(),
  },
  async preview({ taskId }) {
    const t = tasks.get(taskId);
    if (!t) return fail("NOT_FOUND", `Task ${taskId} not found`);
    return ok({ summary: `Permanently delete task ${t.taskId} "${t.title}" (${t.department}, ${t.status}).`, data: { task: t } });
  },
  async handler({ taskId, confirm }, _ctx) {
    if (!confirm) {
      return fail("CONFIRMATION_REQUIRED", "Pass confirm: true to confirm deleting this task.");
    }
    if (!tasks.has(taskId)) return fail("NOT_FOUND", `Task ${taskId} not found`);
    tasks.delete(taskId);
    return ok({ deleted: true as const, taskId });
  },
});
