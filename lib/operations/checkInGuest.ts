import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { frontofficeStore } from "@/lib/seed";

const store = frontofficeStore();

export const checkInGuest = defineOperation({
  name: "checkInGuest",
  title: "Check In Guest",
  description: "Process guest arrival: confirm reservation, assign table, mark as seated.",
  permission: "write",
  roles: ["support", "admin"],
  module: "frontoffice.checkin",
  inputSchema: {
    reservationId: z.string().describe("Reservation ID to check in"),
    tableId: z.string().optional().describe("Table to assign; if omitted an available table with sufficient capacity is auto-assigned"),
  },
  async handler({ reservationId, tableId }, _ctx) {
    const reservation = store.reservations.get(reservationId);
    if (!reservation) return fail("NOT_FOUND", `Reservation ${reservationId} not found`);
    if (reservation.status === "checked-in") return fail("ALREADY_CHECKED_IN", "Guest is already checked in");
    if (reservation.status === "checked-out") return fail("INVALID_STATE", "Reservation has already been checked out");
    if (reservation.status === "cancelled") return fail("INVALID_STATE", "Reservation is cancelled");

    let targetTableId = tableId;

    if (targetTableId) {
      const table = store.tables.get(targetTableId);
      if (!table) return fail("NOT_FOUND", `Table ${targetTableId} not found`);
      if (table.status === "occupied") return fail("TABLE_OCCUPIED", `Table ${targetTableId} is already occupied`);
      if (table.capacity < reservation.partySize) return fail("INSUFFICIENT_CAPACITY", `Table ${targetTableId} capacity (${table.capacity}) is less than party size (${reservation.partySize})`);
    } else {
      // Auto-assign: find first available table with sufficient capacity
      for (const [id, table] of store.tables) {
        if (table.status === "available" && table.capacity >= reservation.partySize) {
          targetTableId = id;
          break;
        }
      }
      if (!targetTableId) return fail("NO_TABLE_AVAILABLE", "No available table with sufficient capacity");
    }

    const seatedAt = new Date().toISOString();
    store.tables.set(targetTableId, {
      ...store.tables.get(targetTableId)!,
      status: "occupied",
      reservationId,
      seatedAt,
      guestId: reservation.guestId,
    });
    store.reservations.set(reservationId, { ...reservation, tableId: targetTableId, status: "checked-in" });

    return ok({ reservationId, tableId: targetTableId, guestName: reservation.guestName, partySize: reservation.partySize, seatedAt });
  },
});
