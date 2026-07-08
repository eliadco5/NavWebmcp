import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok, fail } from "@/lib/result";

export const cancelReservation = defineOperation({
  name: "cancelReservation",
  title: "Cancel Reservation",
  description:
    "Cancel an existing reservation by ID. This is a destructive action — confirmation is required. " +
    "When calling via MCP, you MUST pass confirm: true to acknowledge the cancellation.",
  permission: "write",
  requiresConfirmation: true,
  tags: ["booking", "reservation"],
  inputSchema: {
    reservationId: z.string().describe("ID of the reservation to cancel"),
    confirm: z
      .boolean()
      .describe(
        "Must be true to confirm cancellation. Pass confirm: true to proceed."
      ),
  },
  async handler({ reservationId, confirm }) {
    if (!confirm) {
      return fail(
        "CONFIRMATION_REQUIRED",
        "Pass confirm: true to confirm cancellation of this reservation."
      );
    }

    const reservation = store.getReservation(reservationId);
    if (!reservation) return fail("NOT_FOUND", `Reservation ${reservationId} not found`);

    const cancelled = store.cancelReservation(reservationId);
    if (!cancelled) return fail("CANCEL_FAILED", "Failed to cancel reservation");

    return ok({ cancelled: true, reservationId });
  },
});
