import { stamp } from "@/lib/provenance";
import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { crmGuests, type Guest } from "@/lib/seed";
import { ShortText, GuestSchema } from "./schemas";

const guestsMap = crmGuests();

export const createGuest = defineOperation({
  name: "createGuest",
  title: "Create Guest",
  description: "Create a new guest profile with name, email, and phone.",
  permission: "write",
  roles: ["support", "admin"],
  module: "crm.guests",
  inputSchema: {
    name: ShortText(100).min(1).describe("Full name of the guest"),
    email: ShortText(254).email().describe("Guest email address"),
    phone: ShortText(32).min(1).describe("Guest phone number"),
  },
  outputSchema: { guest: GuestSchema },
  async handler({ name, email, phone }, ctx) {
    const existing = Array.from(guestsMap.values()).find((g) => g.email === email);
    if (existing) return fail("CONFLICT", `A guest with email ${email} already exists`);
    const guestId = `g_${String(guestsMap.size + 1).padStart(3, "0")}`;
    const createdAt = new Date().toISOString();
    const guest: Guest = { guestId, name, email, phone, createdAt, createdBy: stamp(ctx, createdAt) };
    guestsMap.set(guestId, guest);
    return ok({ guest });
  },
});
