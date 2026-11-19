import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok, fail } from "@/lib/result";
import { Id, ShortText, ReservationSchema } from "./schemas";

export const createReservation = defineOperation({
  name: "createReservation",
  title: "Create Reservation",
  description:
    "Book a specific available slot. Requires a slotId from searchAvailability, the guest name, and party size.",
  permission: "write",
  roles: ["customer", "support", "admin"],
  module: "reservation.booking",
  tags: ["booking", "reservation"],
  inputSchema: {
    slotId: Id().describe("ID of the slot to book, from searchAvailability"),
    name: ShortText(100).min(1).describe("Guest name for the reservation"),
    partySize: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe("Number of people in the party"),
  },
  outputSchema: { reservation: ReservationSchema },
  async handler({ slotId, name, partySize }, ctx) {
    const slot = store.getSlot(slotId);
    if (!slot) return fail("NOT_FOUND", `Slot ${slotId} not found`);
    if (!slot.available) return fail("SLOT_UNAVAILABLE", "This slot is no longer available");
    if (slot.capacity < partySize)
      return fail(
        "CAPACITY_EXCEEDED",
        `Slot capacity is ${slot.capacity}, requested ${partySize}`
      );

    const reservation = store.createReservation(slotId, name, partySize, ctx.userId);
    if (!reservation) return fail("CREATE_FAILED", "Failed to create reservation");

    return ok({ reservation });
  },
});
