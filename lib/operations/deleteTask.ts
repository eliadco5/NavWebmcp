import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { tasksStore } from "@/lib/seed";
import { Id } from "./schemas";

const tasks = tasksStore();

export const deleteTask = defineOperation({
  name: "deleteTask",
  title: "Delete Task",
  description:
    "Permanently delete a task. Admin only. This is a destructive action — confirmation is required. " +
    "When calling via MCP, you MUST pass confirm: true to acknowledge the deletion.",
  permission: "write",
  roles: ["admin"],
  module: "tasks.management",
  requiresConfirmation: true,
  inputSchema: {
    taskId: Id().describe("ID of the task to permanently delete"),
    confirm: z.boolean().describe("Must be true to confirm deletion. Pass confirm: true to proceed."),
  },
  outputSchema: {
    deleted: z.literal(true),
    taskId: z.string(),
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
