import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { housekeepingInspections, type InspectionRecord } from "@/lib/seed";

const inspections = housekeepingInspections();

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
