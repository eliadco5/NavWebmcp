import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { housekeepingInspections } from "@/lib/seed";

const inspections = housekeepingInspections();

export const listInspections = defineOperation({
  name: "listInspections",
  title: "List Inspections",
  description: "List recent inspection logs with results and inspector notes.",
  permission: "read",
  roles: ["admin"],
  module: "housekeeping.inspections",
  inputSchema: {
    tableId: z.string().optional().describe("Filter inspections by table ID. Omit to return all."),
    result: z.enum(["pass", "fail"]).optional().describe("Filter by inspection result."),
  },
  async handler({ tableId, result }, _ctx) {
    let records = [...inspections];
    if (tableId) records = records.filter((r) => r.tableId === tableId);
    if (result) records = records.filter((r) => r.result === result);
    records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return ok({ inspections: records, total: records.length });
  },
});
