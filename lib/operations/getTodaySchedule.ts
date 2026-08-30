import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { housekeepingScheduleItems } from "@/lib/seed";

const scheduleItems = housekeepingScheduleItems();

export const getTodaySchedule = defineOperation({
  name: "getTodaySchedule",
  title: "Get Today's Cleaning Schedule",
  description: "Get today's cleaning schedule with times and assignees.",
  permission: "read",
  roles: ["support", "admin"],
  module: "housekeeping.schedule",
  inputSchema: {},
  async handler(_input, _ctx) {
    const total = scheduleItems.length;
    const completed = scheduleItems.filter((s) => s.done).length;
    return ok({ scheduleItems, total, completed, pending: total - completed });
  },
});
