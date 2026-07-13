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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getBillSummary = defineOperation<any, any>({
  name: "getBillSummary",
  title: "Get Bill Summary",
  description: "Get the bill summary for a seated reservation.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "frontoffice.checkout",
  inputSchema: {
    reservationId: z.string().describe("Reservation ID to retrieve bill for"),
  },
  async handler({ reservationId }, ctx) {
    const reservation = store.reservations.get(reservationId);
    if (!reservation) return fail("NOT_FOUND", `Reservation ${reservationId} not found`);

    // Customers may only view their own reservation's bill
    if (ctx.role === "customer" && reservation.guestId !== ctx.userId) {
      return fail("FORBIDDEN", "You may only view your own bill");
    }

    const bill = store.bills.get(reservationId);

    if (!bill) {
      // Reservation is still open — return a running preview (no items in mock)
      if (reservation.status !== "checked-in") {
        return fail("NOT_FOUND", "No bill found for this reservation");
      }
      return ok({ reservationId, status: "open", guestName: reservation.guestName, items: [], total: 0, note: "Bill will be generated at checkout" });
    }

    return ok({
      reservationId,
      status: "closed",
      guestName: reservation.guestName,
      tableId: bill.tableId,
      items: bill.items,
      total: bill.total,
      generatedAt: bill.generatedAt,
    });
  },
});
