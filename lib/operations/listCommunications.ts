import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";

interface CommunicationEntry {
  commId: string;
  guestId: string;
  type: "call" | "email" | "note";
  subject: string;
  body: string;
  agentId: string;
  createdAt: string;
}

declare global {
  var __crmCommunications: CommunicationEntry[] | undefined;
}

const communications = globalThis.__crmCommunications ?? (globalThis.__crmCommunications = [
  { commId: "comm_001", guestId: "g_001", type: "call", subject: "Reservation inquiry", body: "Guest called to ask about weekend availability for a party of six.", agentId: "staff_01", createdAt: "2024-06-10T14:00:00Z" },
  { commId: "comm_002", guestId: "g_001", type: "email", subject: "Birthday dinner confirmation", body: "Sent confirmation email for birthday dinner on June 20. Cake arranged with kitchen.", agentId: "staff_02", createdAt: "2024-06-11T09:30:00Z" },
  { commId: "comm_003", guestId: "g_002", type: "note", subject: "Vegan menu follow-up", body: "Confirmed vegan tasting menu availability with kitchen for upcoming Friday visit.", agentId: "staff_01", createdAt: "2024-06-12T11:00:00Z" },
  { commId: "comm_004", guestId: "g_003", type: "call", subject: "Complaint — cold food", body: "Guest reported food was served cold during last visit. Apologised and offered complimentary appetizer on next visit.", agentId: "staff_03", createdAt: "2024-06-13T16:45:00Z" },
  { commId: "comm_005", guestId: "g_004", type: "email", subject: "Welcome email sent", body: "Sent onboarding welcome email with loyalty programme details.", agentId: "staff_02", createdAt: "2024-06-14T08:00:00Z" },
]);

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
