import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";

type ScheduleItem = {
  id: string;
  tableId: string;
  scheduledTime: string;
  assignee: string;
  task: string;
  done: boolean;
  completedAt?: string;
};

declare global {
  var __housekeepingScheduleItems: ScheduleItem[] | undefined;
}

const scheduleItems: ScheduleItem[] =
  globalThis.__housekeepingScheduleItems ??
  (globalThis.__housekeepingScheduleItems = [
    { id: "sched_001", tableId: "t_01", scheduledTime: "08:00", assignee: "staff_maria", task: "Full sanitize", done: true, completedAt: "2026-07-08T08:12:00Z" },
    { id: "sched_002", tableId: "t_02", scheduledTime: "09:00", assignee: "staff_jose", task: "Wipe and reset", done: false },
    { id: "sched_003", tableId: "t_03", scheduledTime: "09:30", assignee: "staff_maria", task: "Deep clean", done: false },
    { id: "sched_004", tableId: "t_04", scheduledTime: "10:00", assignee: "staff_carlos", task: "Standard clean", done: false },
    { id: "sched_005", tableId: "t_05", scheduledTime: "10:30", assignee: "staff_jose", task: "Wipe and reset", done: false },
  ]);

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
