import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { store } from "@/lib/store";
import { Id, ReservationStatus } from "./schemas";

export const getCheckinStatus = defineOperation({
  name: "getCheckinStatus",
  title: "Get Check-In Status",
  description: "Check whether a reservation has been checked in.",
  permission: "read",
  roles: ["support", "admin"],
  module: "frontoffice.checkin",
  inputSchema: {
    reservationId: Id().describe("Reservation ID to look up"),
  },
  outputSchema: {
    reservationId: z.string(),
    guestName: z.string(),
    guestId: z.string().optional().describe("Linked CRM guest, if any"),
    partySize: z.number().int(),
    status: ReservationStatus,
    tableId: z.string().nullable(),
    seatedAt: z.string().nullable(),
    minutesSeated: z.number().int().nullable(),
  },
  async handler({ reservationId }, _ctx) {
    const reservation = store.getReservationById(reservationId);
    if (!reservation) return fail("NOT_FOUND", `Reservation ${reservationId} not found`);

    const tableInfo = reservation.tableId ? store.tables.get(reservation.tableId) ?? null : null;
    const minutesSeated = tableInfo?.seatedAt
      ? Math.floor((Date.now() - new Date(tableInfo.seatedAt).getTime()) / 60000)
      : null;

    return ok({
      reservationId,
      guestName: reservation.name,
      guestId: reservation.guestId,
      partySize: reservation.partySize,
      status: reservation.status,
      tableId: reservation.tableId ?? null,
      seatedAt: tableInfo?.seatedAt ?? null,
      minutesSeated,
    });
  },
});
