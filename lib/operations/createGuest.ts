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

export const createGuest = defineOperation({
  name: "createGuest",
  title: "Create Guest",
  description: "Create a new guest profile with name, email, and phone.",
  permission: "write",
  roles: ["support", "admin"],
  module: "crm.guests",
  inputSchema: {
    name: z.string().min(1).describe("Full name of the guest"),
    email: z.string().email().describe("Guest email address"),
    phone: z.string().min(1).describe("Guest phone number"),
  },
  async handler({ name, email, phone }, ctx) {
    const existing = Array.from(guestsMap.values()).find((g) => g.email === email);
    if (existing) return fail("CONFLICT", `A guest with email ${email} already exists`);
    const guestId = `g_${String(guestsMap.size + 1).padStart(3, "0")}`;
    const guest: Guest = { guestId, name, email, phone, createdAt: new Date().toISOString() };
    guestsMap.set(guestId, guest);
    return ok({ guest });
  },
});
