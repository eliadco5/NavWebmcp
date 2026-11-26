import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok, fail } from "@/lib/result";
import { Id, Confirm } from "./schemas";
import { whenOf } from "./previews";

export const cancelAnyReservation = defineOperation({
  name: "cancelAnyReservation",
  title: "Cancel Any Reservation",
  description:
    "Cancel any reservation regardless of owner. Admin role only. " +
    "Destructive: call without confirm first to get a preview and a confirmationToken.",
  permission: "write",
  roles: ["admin"],
  requiresConfirmation: true,
  module: "reservation.admin",
  tags: ["booking", "reservation", "admin"],
  inputSchema: {
    reservationId: Id().describe("ID of the reservation to cancel"),
    confirm: Confirm(),
  },
  outputSchema: {
    cancelled: z.literal(true),
    reservationId: z.string(),
  },
  async preview({ reservationId }) {
    const r = store.getReservationById(reservationId);
    if (!r) return fail("NOT_FOUND", `Reservation ${reservationId} not found`);
    return ok({ summary: `Cancel reservation ${r.id} for ${r.name}, party of ${r.partySize}${whenOf(r)} (any owner).`, data: { reservation: r } });
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
