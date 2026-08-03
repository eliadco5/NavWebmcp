import { z } from "zod";
import { defineOperation } from "./types";
import { hostVipGuestOrchestration } from "@/lib/core/hostVipGuest";
import { makeDispatch } from "./dispatch";

export const hostVipGuestOp = defineOperation({
  name: "hostVipGuest",
  title: "Host VIP Guest",
  description:
    "Host a VIP guest's visit in ONE step: reads their preferences and loyalty status, " +
    "seats them, awards loyalty points for the visit, and logs a visit note. Prefer this over " +
    "calling getGuestPreferences + getLoyaltyStatus + getOccupancy + checkInGuest + " +
    "getCheckinStatus + addLoyaltyPoints + logCommunication separately.",
  permission: "write",
  roles: ["support", "admin"],
  module: "frontoffice.checkin",
  tags: ["checkin", "frontoffice", "crm"],
  inputSchema: {
    reservationId: z.string().describe("Reservation ID to check in"),
    guestId: z.string().describe("The unique guest identifier"),
    pointsToAward: z.number().int().positive().describe("Loyalty points to award for this visit"),
    visitNote: z.string().min(1).describe("Note describing the visit, used for both the loyalty reason and the logged communication"),
  },
  async handler(input, ctx) {
    return hostVipGuestOrchestration(input, makeDispatch(ctx));
  },
});
