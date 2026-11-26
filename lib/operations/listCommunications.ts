import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { crmCommunications } from "@/lib/seed";
import { Id, CommunicationSchema } from "./schemas";

const communications = crmCommunications();

export const listCommunications = defineOperation({
  name: "listCommunications",
  title: "List Communications",
  description: "List all logged communications (calls, emails, notes) for a guest.",
  permission: "read",
  roles: ["support", "admin"],
  module: "crm.communications",
  list: { key: "communications", id: "commId" },
  inputSchema: {
    guestId: Id().describe("The unique guest identifier"),
    type: z.enum(["call", "email", "note"]).optional().describe("Filter by communication type"),
  },
  outputSchema: {
    communications: z.array(CommunicationSchema).describe("Newest first"),
    total: z.number().int(),
  },
  untrustedOutput: true,
  async handler({ guestId, type }, ctx) {
    let results = communications.filter((c) => c.guestId === guestId);
    if (type !== undefined) results = results.filter((c) => c.type === type);
    results = [...results].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return ok({ communications: results, total: results.length });
  },
});
