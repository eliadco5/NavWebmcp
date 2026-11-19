import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok, fail } from "@/lib/result";
import { Id, ReservationSchema } from "./schemas";

export const getReservation = defineOperation({
  name: "getReservation",
  title: "Get Reservation",
  description: "Look up a specific reservation by ID.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "reservation.search",
  tags: ["booking", "reservation"],
  inputSchema: {
    reservationId: Id().describe("ID of the reservation to retrieve"),
  },
  outputSchema: { reservation: ReservationSchema },
  async handler({ reservationId }, ctx) {
    const reservation = store.getReservation(reservationId, ctx.userId);
    if (!reservation) return fail("NOT_FOUND", `Reservation ${reservationId} not found`);
    return ok({ reservation });
  },
});
