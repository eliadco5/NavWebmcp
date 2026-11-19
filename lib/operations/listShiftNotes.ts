import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { shiftNotes } from "@/lib/seed/frontoffice";
import { IsoDate, ShiftNoteSchema } from "./schemas";

export const listShiftNotes = defineOperation({
  name: "listShiftNotes",
  title: "List Shift Notes",
  description: "List shift handover notes for today or a given date.",
  permission: "read",
  roles: ["support", "admin"],
  module: "frontoffice.shifts",
  inputSchema: {
    date: IsoDate().optional().describe("ISO date (YYYY-MM-DD) to filter notes; defaults to today"),
  },
  outputSchema: {
    date: z.string().describe("The date the notes were filtered by"),
    count: z.number().int(),
    notes: z.array(ShiftNoteSchema),
  },
  untrustedOutput: true,
  async handler({ date }, _ctx) {
    const targetDate = date ?? new Date().toISOString().slice(0, 10);
    const notes = shiftNotes().filter((n) => n.date === targetDate);
    return ok({ date: targetDate, count: notes.length, notes });
  },
});
