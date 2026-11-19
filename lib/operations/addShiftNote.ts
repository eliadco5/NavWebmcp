import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { shiftNotes } from "@/lib/seed/frontoffice";
import { ShortText, LongText, ShiftNoteSchema } from "./schemas";

export const addShiftNote = defineOperation({
  name: "addShiftNote",
  title: "Add Shift Note",
  description: "Add a handover note for the current shift.",
  permission: "write",
  roles: ["support", "admin"],
  module: "frontoffice.shifts",
  inputSchema: {
    note: LongText().min(1).max(1000).describe("Handover note content"),
    author: ShortText(100).min(1).describe("Name or ID of the staff member adding the note"),
  },
  outputSchema: ShiftNoteSchema.shape,
  async handler({ note, author }, _ctx) {
    const notes = shiftNotes();
    const id = `sn_${String(notes.length + 1).padStart(3, "0")}`;
    const createdAt = new Date().toISOString();
    const date = createdAt.slice(0, 10);
    const entry = { id, note, author, createdAt, date };
    notes.push(entry);
    return ok(entry);
  },
});
