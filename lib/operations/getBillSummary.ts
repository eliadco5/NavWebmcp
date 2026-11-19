import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { store } from "@/lib/store";
import { Id, BillItemSchema } from "./schemas";

export const getBillSummary = defineOperation({
  name: "getBillSummary",
  title: "Get Bill Summary",
  description: "Get the bill summary for a seated reservation.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "frontoffice.checkout",
  inputSchema: {
    reservationId: Id().describe("Reservation ID to retrieve bill for"),
  },
  outputSchema: {
    reservationId: z.string(),
    status: z.enum(["open", "closed"]).describe("open = guest still seated (running preview); closed = bill generated at checkout"),
    guestName: z.string(),
    items: z.array(BillItemSchema),
    total: z.number(),
    note: z.string().optional().describe("Present when status is open"),
    tableId: z.string().optional().describe("Present when status is closed"),
    generatedAt: z.string().optional().describe("Present when status is closed"),
  },
  async handler({ reservationId }, ctx) {
    const reservation = store.getReservationById(reservationId);
    if (!reservation) return fail("NOT_FOUND", `Reservation ${reservationId} not found`);

    // Customers may only view their own reservation's bill — a reservation can
    // be owned via userId (booked through the Reservations tab) or guestId
    // (linked to a CRM profile via the front desk), so check both.
    if (
      ctx.role === "customer" &&
      reservation.userId !== ctx.userId &&
      reservation.guestId !== ctx.userId
    ) {
      return fail("FORBIDDEN", "You may only view your own bill");
    }

    const bill = store.bills.get(reservationId);

    if (!bill) {
      // Reservation is still open — return a running preview (no items in mock)
      if (reservation.status !== "checked-in") {
        return fail("NOT_FOUND", "No bill found for this reservation");
      }
      return ok({ reservationId, status: "open" as const, guestName: reservation.name, items: [], total: 0, note: "Bill will be generated at checkout" });
    }

    return ok({
      reservationId,
      status: "closed" as const,
      guestName: reservation.name,
      tableId: bill.tableId,
      items: bill.items,
      total: bill.total,
      generatedAt: bill.generatedAt,
    });
  },
});
