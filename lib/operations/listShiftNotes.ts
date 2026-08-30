import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { frontofficeStore } from "@/lib/seed";

const store = frontofficeStore();

export const listShiftNotes = defineOperation({
  name: "listShiftNotes",
  title: "List Shift Notes",
  description: "List shift handover notes for today or a given date.",
  permission: "read",
  roles: ["support", "admin"],
  module: "frontoffice.shifts",
  inputSchema: {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) to filter notes; defaults to today"),
  },
  async handler({ date }, _ctx) {
    const targetDate = date ?? new Date().toISOString().slice(0, 10);
    const notes = store.shiftNotes.filter((n) => n.date === targetDate);
    return ok({ date: targetDate, count: notes.length, notes });
  },
});
