import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { store } from "@/lib/store";
import { today } from "@/lib/seed/store";

export const listFrontDeskReservations = defineOperation({
  name: "listFrontDeskReservations",
  title: "List Front Desk Reservations",
  description: "List today's front-desk reservations with their check-in status, for choosing who to seat or check out.",
  permission: "read",
  roles: ["support", "admin"],
  module: "frontoffice.checkin",
  inputSchema: {},
  async handler(_input, _ctx) {
    // Front-desk-seeded reservations have no date (they're not tied to slot
    // inventory); a booking made via the Reservations tab always has one. Only
    // show today's — otherwise every booking ever made, including next week's,
    // would clutter the check-in queue.
    const todayDate = today();
    const reservations = store
      .getAllReservations()
      .filter((r) => r.date === undefined || r.date === todayDate)
      .map((r) => ({
        reservationId: r.id,
        guestName: r.name,
        partySize: r.partySize,
        status: r.status,
        tableId: r.tableId ?? null,
      }));
    return ok({ reservations });
  },
});
