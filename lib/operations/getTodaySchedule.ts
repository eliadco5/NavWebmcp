import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";

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
