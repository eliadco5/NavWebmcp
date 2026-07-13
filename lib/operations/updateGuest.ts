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

export const updateGuest = defineOperation({
  name: "updateGuest",
  title: "Update Guest",
  description: "Update contact details on an existing guest profile.",
  permission: "write",
  roles: ["support", "admin"],
  module: "crm.guests",
  inputSchema: {
    guestId: z.string().describe("The unique guest identifier"),
    name: z.string().min(1).optional().describe("Updated full name"),
    email: z.string().email().optional().describe("Updated email address"),
    phone: z.string().min(1).optional().describe("Updated phone number"),
  },
  async handler({ guestId, name, email, phone }, ctx) {
    const guest = guestsMap.get(guestId);
    if (!guest) return fail("NOT_FOUND", `Guest ${guestId} not found`);
    if (email !== undefined && email !== guest.email) {
      const conflict = Array.from(guestsMap.values()).find((g) => g.email === email);
      if (conflict) return fail("CONFLICT", `Email ${email} is already in use`);
    }
    const updated: Guest = {
      ...guest,
      ...(name !== undefined && { name }),
      ...(email !== undefined && { email }),
      ...(phone !== undefined && { phone }),
    };
    guestsMap.set(guestId, updated);
    return ok({ guest: updated });
  },
});
