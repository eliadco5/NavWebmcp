import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";

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

export const logInspection = defineOperation({
  name: "logInspection",
  title: "Log Inspection",
  description: "Log a new inspection result for a table or room area.",
  permission: "write",
  roles: ["admin"],
  module: "housekeeping.inspections",
  inputSchema: {
    tableId: z.string().describe("The ID of the table or area being inspected (e.g. t_03)."),
    inspector: z.string().describe("Staff ID of the inspector logging the result."),
    result: z.enum(["pass", "fail"]).describe("Outcome of the inspection."),
    notes: z.string().describe("Inspector notes describing findings or confirmation of cleanliness."),
  },
  async handler({ tableId, inspector, result, notes }, _ctx) {
    if (!tableId.trim()) {
      return fail("INVALID_INPUT", "tableId must not be empty.");
    }
    const id = `insp_${String(inspections.length + 1).padStart(3, "0")}`;
    const record: InspectionRecord = {
      id,
      tableId,
      inspector,
      result,
      notes,
      timestamp: new Date().toISOString(),
    };
    inspections.push(record);
    return ok({ inspection: record });
  },
});
