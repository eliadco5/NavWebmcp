import { z } from "zod";
import { defineOperation } from "./types";
import { hostVipGuestOrchestration } from "@/lib/core/hostVipGuest";
import { makeDispatch } from "./dispatch";
import { Id, Points, LongText, PreferencesSchema, LoyaltySchema } from "./schemas";

export const hostVipGuestOp = defineOperation({
  name: "hostVipGuest",
  title: "Host VIP Guest",
  description:
    "Host a VIP guest's visit in ONE step: reads their preferences and loyalty status, " +
    "seats them, awards loyalty points for the visit, and logs a visit note. Prefer this over " +
    "calling getGuestPreferences + getLoyaltyStatus + getOccupancy + checkInGuest + " +
    "getCheckinStatus + addLoyaltyPoints + logCommunication separately.",
  permission: "write",
  credits: { weight: 7 }, // runs 7 operations (lib/core/hostVipGuest.ts)
  roles: ["support", "admin"],
  module: "frontoffice.checkin",
  tags: ["checkin", "frontoffice", "crm"],
  inputSchema: {
    reservationId: Id().describe("Reservation ID to check in"),
    guestId: Id().describe("The unique guest identifier"),
    pointsToAward: Points().describe("Loyalty points to award for this visit"),
    visitNote: LongText().min(1).describe("Note describing the visit, used for both the loyalty reason and the logged communication"),
  },
  outputSchema: {
    preferences: PreferencesSchema,
    loyaltyBefore: LoyaltySchema.describe("Loyalty account before the award"),
    loyaltyAfter: LoyaltySchema.describe("Loyalty account after the award"),
    tierUpgrade: z.boolean(),
    validated: z.boolean(),
  },
  untrustedOutput: true,
  async handler(input, ctx) {
    return hostVipGuestOrchestration(input, makeDispatch(ctx));
  },
});
