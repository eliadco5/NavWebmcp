import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { tasksStore } from "@/lib/seed";

const tasks = tasksStore();

export const deleteTask = defineOperation({
  name: "deleteTask",
  title: "Delete Task",
  description: "Permanently delete a task. Admin only. Requires confirmation.",
  permission: "write",
  roles: ["admin"],
  module: "tasks.management",
  requiresConfirmation: true,
  inputSchema: {
    taskId: z.string().describe("ID of the task to permanently delete"),
  },
  async handler({ taskId }, _ctx) {
    if (!tasks.has(taskId)) return fail("NOT_FOUND", `Task ${taskId} not found`);
    tasks.delete(taskId);
    return ok({ deleted: true, taskId });
  },
});
