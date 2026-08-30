import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { frontofficeStore } from "@/lib/seed";

const store = frontofficeStore();

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
