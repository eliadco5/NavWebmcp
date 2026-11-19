import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok, fail } from "@/lib/result";
import { Id } from "./schemas";

export const cancelAnyReservation = defineOperation({
  name: "cancelAnyReservation",
  title: "Cancel Any Reservation",
  description:
    "Cancel any reservation regardless of owner. Admin role only. " +
    "This is a destructive action — pass confirm: true to proceed.",
  permission: "write",
  roles: ["admin"],
  requiresConfirmation: true,
  module: "reservation.admin",
  tags: ["booking", "reservation", "admin"],
  inputSchema: {
    reservationId: Id().describe("ID of the reservation to cancel"),
    confirm: z.boolean().describe("Must be true to confirm cancellation."),
  },
  outputSchema: {
    cancelled: z.literal(true),
    reservationId: z.string(),
  },
  async handler({ reservationId, confirm }, _ctx) {
    if (!confirm) {
      return fail("CONFIRMATION_REQUIRED", "Pass confirm: true to confirm cancellation.");
    }
    const result = store.cancelReservationAsAdmin(reservationId);
    if (result === "not_found") return fail("NOT_FOUND", `Reservation ${reservationId} not found`);
    return ok({ cancelled: true as const, reservationId });
  },
});
