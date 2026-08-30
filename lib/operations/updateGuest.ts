import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { crmGuests, type Guest } from "@/lib/seed";

const guestsMap = crmGuests();

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
