import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { tasksStore } from "@/lib/seed";

const tasks = tasksStore();

export const searchTasks = defineOperation({
  name: "searchTasks",
  title: "Search Tasks",
  description: "Search open tasks by department, status, assignee, or linked reservation.",
  permission: "read",
  roles: ["support", "admin"],
  module: "tasks.management",
  inputSchema: {
    department: z.string().optional().describe("Filter by department"),
    status: z.enum(["open", "in_progress", "completed", "cancelled"]).optional().describe("Filter by task status"),
    assigneeId: z.string().optional().describe("Filter by assigned user ID"),
    reservationId: z.string().optional().describe("Filter by related reservation ID"),
  },
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
