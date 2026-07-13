import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";

type TableStatusRecord = {
  tableId: string;
  status: "clean" | "dirty" | "in-progress";
  lastUpdated: string;
  updatedBy: string;
};

declare global {
  var __housekeepingTableStatus: Map<string, TableStatusRecord> | undefined;
}

const tableStatusMap =
  globalThis.__housekeepingTableStatus ??
  (globalThis.__housekeepingTableStatus = new Map([
    ["t_01", { tableId: "t_01", status: "clean", lastUpdated: "2026-07-08T08:00:00Z", updatedBy: "staff_maria" }],
    ["t_02", { tableId: "t_02", status: "dirty", lastUpdated: "2026-07-08T09:15:00Z", updatedBy: "staff_jose" }],
    ["t_03", { tableId: "t_03", status: "in-progress", lastUpdated: "2026-07-08T09:30:00Z", updatedBy: "staff_maria" }],
    ["t_04", { tableId: "t_04", status: "clean", lastUpdated: "2026-07-08T07:45:00Z", updatedBy: "staff_carlos" }],
    ["t_05", { tableId: "t_05", status: "dirty", lastUpdated: "2026-07-08T09:00:00Z", updatedBy: "staff_jose" }],
  ]));

export const getTableCleaningStatus = defineOperation({
  name: "getTableCleaningStatus",
  title: "Get Table Cleaning Status",
  description: "Get the cleaning status of all tables (clean, dirty, in-progress).",
  permission: "read",
  roles: ["support", "admin"],
  module: "housekeeping.status",
  inputSchema: {},
  async handler(_input, _ctx) {
    const tables = Array.from(tableStatusMap.values());
    const summary = {
      clean: tables.filter((t) => t.status === "clean").length,
      dirty: tables.filter((t) => t.status === "dirty").length,
      inProgress: tables.filter((t) => t.status === "in-progress").length,
    };
    return ok({ tables, summary });
  },
});
