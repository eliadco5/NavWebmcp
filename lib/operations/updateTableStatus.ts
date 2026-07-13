import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";

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

export const updateTableStatus = defineOperation({
  name: "updateTableStatus",
  title: "Update Table Status",
  description: "Update the cleaning status of a specific table.",
  permission: "write",
  roles: ["support", "admin"],
  module: "housekeeping.status",
  inputSchema: {
    tableId: z.string().describe("The ID of the table to update (e.g. t_01)."),
    status: z.enum(["clean", "dirty", "in-progress"]).describe("New cleaning status for the table."),
    updatedBy: z.string().describe("Staff member ID making the update."),
  },
  async handler({ tableId, status, updatedBy }, _ctx) {
    if (!tableStatusMap.has(tableId)) {
      return fail("NOT_FOUND", `Table ${tableId} does not exist.`);
    }
    const existing = tableStatusMap.get(tableId)!;
    const updated: typeof existing = {
      ...existing,
      status,
      updatedBy,
      lastUpdated: new Date().toISOString(),
    };
    tableStatusMap.set(tableId, updated);
    return ok({ table: updated });
  },
});
