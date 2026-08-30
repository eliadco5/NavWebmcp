import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { frontofficeStore } from "@/lib/seed";

const store = frontofficeStore();

export const listFrontDeskReservations = defineOperation({
  name: "listFrontDeskReservations",
  title: "List Front Desk Reservations",
  description: "List today's front-desk reservations with their check-in status, for choosing who to seat or check out.",
  permission: "read",
  roles: ["support", "admin"],
  module: "frontoffice.checkin",
  inputSchema: {},
  async handler(_input, _ctx) {
    const reservations = Array.from(store.reservations.values()).map((r) => ({
      reservationId: r.id,
      guestName: r.guestName,
      partySize: r.partySize,
      status: r.status,
      tableId: r.tableId ?? null,
    }));
    return ok({ reservations });
  },
});
