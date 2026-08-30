import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { housekeepingScheduleItems } from "@/lib/seed";

const scheduleItems = housekeepingScheduleItems();

export const markScheduleItemDone = defineOperation({
  name: "markScheduleItemDone",
  title: "Mark Schedule Item Done",
  description: "Mark a scheduled cleaning item as completed.",
  permission: "write",
  roles: ["support", "admin"],
  module: "housekeeping.schedule",
  inputSchema: {
    scheduleId: z.string().describe("The ID of the schedule item to mark as done (e.g. sched_002)."),
  },
  async handler({ scheduleId }, _ctx) {
    const item = scheduleItems.find((s) => s.id === scheduleId);
    if (!item) {
      return fail("NOT_FOUND", `Schedule item ${scheduleId} does not exist.`);
    }
    if (item.done) {
      return fail("ALREADY_DONE", `Schedule item ${scheduleId} is already marked as completed.`);
    }
    item.done = true;
    item.completedAt = new Date().toISOString();
    return ok({ scheduleItem: item });
  },
});
