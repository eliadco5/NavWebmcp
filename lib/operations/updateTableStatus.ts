import { stamp } from "@/lib/provenance";
import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { housekeepingTableStatus } from "@/lib/seed";
import { Id, TableCleaningSchema } from "./schemas";

const tableStatusMap = housekeepingTableStatus();

export const updateTableStatus = defineOperation({
  name: "updateTableStatus",
  title: "Update Table Status",
  description: "Update the cleaning status of a specific table.",
  permission: "write",
  roles: ["support", "admin"],
  module: "housekeeping.status",
  inputSchema: {
    tableId: Id().describe("The ID of the table to update (e.g. t_01)."),
    status: z.enum(["clean", "dirty", "in-progress"]).describe("New cleaning status for the table."),
    updatedBy: Id().describe("Staff member ID making the update."),
  },
  outputSchema: { table: TableCleaningSchema },
  async handler({ tableId, status, updatedBy }, ctx) {
    if (!tableStatusMap.has(tableId)) {
      return fail("NOT_FOUND", `Table ${tableId} does not exist.`);
    }
    const existing = tableStatusMap.get(tableId)!;
    const lastUpdated = new Date().toISOString();
    const updated: typeof existing = {
      ...existing,
      status,
      // `updatedBy` is the caller-supplied name; lastModifiedBy is who did it.
      updatedBy,
      lastUpdated,
      lastModifiedBy: stamp(ctx, lastUpdated),
    };
    tableStatusMap.set(tableId, updated);
    return ok({ table: updated });
  },
});
