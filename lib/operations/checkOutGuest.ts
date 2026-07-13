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

const MOCK_MENU_ITEMS = [
  { name: "Grilled Salmon", price: 28.5 },
  { name: "Caesar Salad", price: 14.0 },
  { name: "Ribeye Steak", price: 42.0 },
  { name: "Sparkling Water", price: 5.0 },
  { name: "House Wine (glass)", price: 12.0 },
  { name: "Tiramisu", price: 9.5 },
];

function generateMockBillItems(partySize: number) {
  const items: { name: string; qty: number; price: number }[] = [];
  const count = partySize + Math.floor(Math.random() * 2);
  for (let i = 0; i < count; i++) {
    const menuItem = MOCK_MENU_ITEMS[i % MOCK_MENU_ITEMS.length];
    items.push({ name: menuItem.name, qty: 1, price: menuItem.price });
  }
  return items;
}

export const checkOutGuest = defineOperation({
  name: "checkOutGuest",
  title: "Check Out Guest",
  description: "Close a table: generate bill summary and mark table as available.",
  permission: "write",
  requiresConfirmation: true,
  roles: ["support", "admin"],
  module: "frontoffice.checkout",
  inputSchema: {
    reservationId: z.string().describe("Reservation ID to check out"),
  },
  async handler({ reservationId }, _ctx) {
    const reservation = store.reservations.get(reservationId);
    if (!reservation) return fail("NOT_FOUND", `Reservation ${reservationId} not found`);
    if (reservation.status !== "checked-in") return fail("INVALID_STATE", `Reservation must be checked-in to check out; current status: ${reservation.status}`);
    if (!reservation.tableId) return fail("INVALID_STATE", "Reservation has no assigned table");

    const table = store.tables.get(reservation.tableId);
    if (!table) return fail("NOT_FOUND", `Table ${reservation.tableId} not found`);

    const items = generateMockBillItems(reservation.partySize);
    const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
    const tax = Math.round(subtotal * 0.1 * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;
    const generatedAt = new Date().toISOString();

    const bill = { reservationId, tableId: reservation.tableId, items, subtotal, tax, total, generatedAt };
    store.bills.set(reservationId, { reservationId, tableId: reservation.tableId, items, total, generatedAt });

    store.tables.set(reservation.tableId, {
      id: reservation.tableId,
      status: "available",
      capacity: table.capacity,
    });
    store.reservations.set(reservationId, { ...reservation, status: "checked-out" as never });

    return ok(bill);
  },
});
