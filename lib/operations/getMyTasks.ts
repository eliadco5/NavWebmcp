import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { tasksStore } from "@/lib/seed";

const tasks = tasksStore();

export const getMyTasks = defineOperation({
  name: "getMyTasks",
  title: "Get My Tasks",
  description: "List all tasks assigned to the current user.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "tasks.assignments",
  inputSchema: {},
  async handler(_input, ctx) {
    const myTasks = [...tasks.values()].filter((t) => t.assigneeId === ctx.userId);
    return ok({ tasks: myTasks, total: myTasks.length });
  },
});
