import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { crmCommunications } from "@/lib/seed";

const communications = crmCommunications();

export const listCommunications = defineOperation({
  name: "listCommunications",
  title: "List Communications",
  description: "List all logged communications (calls, emails, notes) for a guest.",
  permission: "read",
  roles: ["support", "admin"],
  module: "crm.communications",
  inputSchema: {
    guestId: z.string().describe("The unique guest identifier"),
    type: z.enum(["call", "email", "note"]).optional().describe("Filter by communication type"),
  },
  async handler({ guestId, type }, ctx) {
    let results = communications.filter((c) => c.guestId === guestId);
    if (type !== undefined) results = results.filter((c) => c.type === type);
    results = [...results].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return ok({ communications: results, total: results.length });
  },
});
