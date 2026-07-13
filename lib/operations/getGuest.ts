import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";

interface Guest {
  guestId: string;
  name: string;
  email: string;
  phone: string;
  createdAt: string;
}

declare global {
  var __crmGuests: Map<string, Guest> | undefined;
}

const guestsMap = globalThis.__crmGuests ?? (globalThis.__crmGuests = new Map<string, Guest>([
  ["g_001", { guestId: "g_001", name: "Alice Hartman", email: "alice.hartman@email.com", phone: "+1-555-0101", createdAt: "2024-01-15T10:00:00Z" }],
  ["g_002", { guestId: "g_002", name: "Brian Torres", email: "brian.torres@email.com", phone: "+1-555-0202", createdAt: "2024-02-20T14:30:00Z" }],
  ["g_003", { guestId: "g_003", name: "Catherine Wu", email: "catherine.wu@email.com", phone: "+1-555-0303", createdAt: "2024-03-05T09:15:00Z" }],
  ["g_004", { guestId: "g_004", name: "David Okafor", email: "david.okafor@email.com", phone: "+1-555-0404", createdAt: "2024-04-10T11:45:00Z" }],
  ["g_005", { guestId: "g_005", name: "Elena Rossi", email: "elena.rossi@email.com", phone: "+1-555-0505", createdAt: "2024-05-22T16:00:00Z" }],
]));

export const getGuest = defineOperation({
  name: "getGuest",
  title: "Get Guest",
  description: "Retrieve a guest profile by guest ID.",
  permission: "read",
  roles: ["support", "admin"],
  module: "crm.guests",
  inputSchema: {
    guestId: z.string().describe("The unique guest identifier"),
  },
  async handler({ guestId }, ctx) {
    const guest = guestsMap.get(guestId);
    if (!guest) return fail("NOT_FOUND", `Guest ${guestId} not found`);
    return ok({ guest });
  },
});
