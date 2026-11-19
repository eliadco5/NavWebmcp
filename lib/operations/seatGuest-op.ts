import { z } from "zod";
import { defineOperation } from "./types";
import { seatGuestOrchestration } from "@/lib/core/seatGuest";
import { makeDispatch } from "./dispatch";
import { Id, CheckinSchema } from "./schemas";

export const seatGuestOp = defineOperation({
  name: "seatGuest",
  title: "Seat Guest",
  description:
    "Seat a guest in ONE step: confirms a table is available, checks the reservation in, " +
    "and validates the seating. Prefer this over calling " +
    "getOccupancy + checkInGuest separately.",
  permission: "write",
  roles: ["support", "admin"],
  module: "frontoffice.checkin",
  tags: ["checkin", "frontoffice"],
  inputSchema: {
    reservationId: Id().describe("Reservation ID to check in"),
    tableId: Id().optional().describe("Table to assign; if omitted an available table with sufficient capacity is auto-assigned"),
  },
  outputSchema: {
    checkin: CheckinSchema,
    validated: z.boolean().describe("False when the post-check could not yet see the table as occupied (possibly a stale read); the guest is still checked in"),
  },
  async handler(input, ctx) {
    return seatGuestOrchestration(input, makeDispatch(ctx));
  },
});
