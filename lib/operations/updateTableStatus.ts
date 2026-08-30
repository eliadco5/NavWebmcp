import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { housekeepingTableStatus } from "@/lib/seed";

const tableStatusMap = housekeepingTableStatus();

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
