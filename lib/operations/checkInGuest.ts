import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";

declare global {
  var __frontofficeStore:
    | {
        tables: Map<string, { id: string; status: "available" | "occupied" | "reserved"; capacity: number; reservationId?: string; seatedAt?: string; guestId?: string }>;
        reservations: Map<string, { id: string; guestId: string; guestName: string; partySize: number; tableId?: string; status: "pending" | "checked-in" | "checked-out" | "cancelled" }>;
        bills: Map<string, { reservationId: string; tableId: string; items: { name: string; qty: number; price: number }[]; total: number; generatedAt: string }>;
        shiftNotes: { id: string; note: string; author: string; createdAt: string; date: string }[];
      }
    | undefined;
}

const store = globalThis.__frontofficeStore ?? (globalThis.__frontofficeStore = {
  tables: new Map([
    ["t_01", { id: "t_01", status: "available", capacity: 2 }],
    ["t_02", { id: "t_02", status: "occupied", capacity: 4, reservationId: "res_001", seatedAt: new Date(Date.now() - 45 * 60000).toISOString(), guestId: "g_001" }],
    ["t_03", { id: "t_03", status: "available", capacity: 4 }],
    ["t_04", { id: "t_04", status: "reserved", capacity: 6, reservationId: "res_002" }],
    ["t_05", { id: "t_05", status: "available", capacity: 2 }],
  ]),
  reservations: new Map([
    ["res_001", { id: "res_001", guestId: "g_001", guestName: "Alice Martin", partySize: 2, tableId: "t_02", status: "checked-in" }],
    ["res_002", { id: "res_002", guestId: "g_002", guestName: "Bob Chen", partySize: 5, status: "pending" }],
    ["res_003", { id: "res_003", guestId: "g_003", guestName: "Carol Diaz", partySize: 3, status: "pending" }],
  ]),
  bills: new Map(),
  shiftNotes: [
    { id: "sn_001", note: "VIP guest at t_02, allergic to nuts.", author: "support_jane", createdAt: new Date(Date.now() - 2 * 3600000).toISOString(), date: new Date().toISOString().slice(0, 10) },
    { id: "sn_002", note: "POS terminal 3 rebooted, all clear.", author: "support_mike", createdAt: new Date(Date.now() - 1 * 3600000).toISOString(), date: new Date().toISOString().slice(0, 10) },
  ],
});

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
