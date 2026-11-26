import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok, fail } from "@/lib/result";
import { Id, Confirm } from "./schemas";
import { whenOf } from "./previews";

export const cancelReservation = defineOperation({
  name: "cancelReservation",
  title: "Cancel Reservation",
  description:
    "Cancel an existing reservation by ID. Destructive: call without confirm first to get a preview and a " +
    "confirmationToken, show the preview to the user, then re-call with the token.",
  permission: "write",
  roles: ["customer", "support", "admin"],
  requiresConfirmation: true,
  module: "reservation.booking",
  tags: ["booking", "reservation"],
  inputSchema: {
    reservationId: Id().describe("ID of the reservation to cancel"),
    confirm: Confirm(),
  },
  outputSchema: {
    cancelled: z.literal(true),
    reservationId: z.string(),
  },
  async preview({ reservationId }, ctx) {
    const r = store.getReservationById(reservationId);
    if (!r) return fail("NOT_FOUND", `Reservation ${reservationId} not found`);
    if (r.userId !== ctx.userId) return fail("FORBIDDEN", "You do not own this reservation");
    return ok({ summary: `Cancel reservation ${r.id} for ${r.name}, party of ${r.partySize}${whenOf(r)}.`, data: { reservation: r } });
  },
  async handler({ reservationId, confirm }, ctx) {
    if (!confirm) {
      return fail(
        "CONFIRMATION_REQUIRED",
        "Pass confirm: true to confirm cancellation of this reservation."
      );
    }

    const result = store.cancelReservation(reservationId, ctx.userId);
    if (result === "not_found") return fail("NOT_FOUND", `Reservation ${reservationId} not found`);
    if (result === "forbidden") return fail("FORBIDDEN", "You do not own this reservation");

    return ok({ cancelled: true as const, reservationId });
  },
});
