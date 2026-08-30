import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { frontofficeStore } from "@/lib/seed";

const store = frontofficeStore();

export const getCheckinStatus = defineOperation({
  name: "getCheckinStatus",
  title: "Get Check-In Status",
  description: "Check whether a reservation has been checked in.",
  permission: "read",
  roles: ["support", "admin"],
  module: "frontoffice.checkin",
  inputSchema: {
    reservationId: z.string().describe("Reservation ID to look up"),
  },
  async handler({ reservationId }, _ctx) {
    const reservation = store.reservations.get(reservationId);
    if (!reservation) return fail("NOT_FOUND", `Reservation ${reservationId} not found`);

    const tableInfo = reservation.tableId ? store.tables.get(reservation.tableId) ?? null : null;
    const minutesSeated = tableInfo?.seatedAt
      ? Math.floor((Date.now() - new Date(tableInfo.seatedAt).getTime()) / 60000)
      : null;

    return ok({
      reservationId,
      guestName: reservation.guestName,
      guestId: reservation.guestId,
      partySize: reservation.partySize,
      status: reservation.status,
      tableId: reservation.tableId ?? null,
      seatedAt: tableInfo?.seatedAt ?? null,
      minutesSeated,
    });
  },
});
