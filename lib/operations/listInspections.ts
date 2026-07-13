import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";

type InspectionRecord = {
  id: string;
  tableId: string;
  inspector: string;
  result: "pass" | "fail";
  notes: string;
  timestamp: string;
};

declare global {
  var __housekeepingInspections: InspectionRecord[] | undefined;
}

const inspections: InspectionRecord[] =
  globalThis.__housekeepingInspections ??
  (globalThis.__housekeepingInspections = [
    { id: "insp_001", tableId: "t_01", inspector: "admin_paula", result: "pass", notes: "Surface clean, no residue.", timestamp: "2026-07-08T08:20:00Z" },
    { id: "insp_002", tableId: "t_02", inspector: "admin_paula", result: "fail", notes: "Sticky residue under edge, needs re-clean.", timestamp: "2026-07-08T09:05:00Z" },
    { id: "insp_003", tableId: "t_04", inspector: "admin_raj", result: "pass", notes: "All clear, ready for service.", timestamp: "2026-07-08T08:00:00Z" },
  ]);

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
