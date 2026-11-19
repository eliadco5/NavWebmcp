import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { tasksStore } from "@/lib/seed";
import { Id, ShortText, TaskStatus, TaskSchema } from "./schemas";

const tasks = tasksStore();

export const searchTasks = defineOperation({
  name: "searchTasks",
  title: "Search Tasks",
  description: "Search open tasks by department, status, assignee, or linked reservation.",
  permission: "read",
  roles: ["support", "admin"],
  module: "tasks.management",
  inputSchema: {
    department: ShortText(100).optional().describe("Filter by department"),
    status: TaskStatus.optional().describe("Filter by task status"),
    assigneeId: Id().optional().describe("Filter by assigned user ID"),
    reservationId: Id().optional().describe("Filter by related reservation ID"),
  },
  outputSchema: {
    tasks: z.array(TaskSchema),
    total: z.number().int(),
  },
  untrustedOutput: true,
  async handler({ department, status, assigneeId, reservationId }, _ctx) {
    const results = [...tasks.values()].filter((t) => {
      if (department !== undefined && t.department !== department) return false;
      if (status !== undefined && t.status !== status) return false;
      if (assigneeId !== undefined && t.assigneeId !== assigneeId) return false;
      if (reservationId !== undefined && t.reservationId !== reservationId) return false;
      return true;
    });
    return ok({ tasks: results, total: results.length });
  },
});
