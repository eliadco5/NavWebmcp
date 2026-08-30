import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { frontofficeStore } from "@/lib/seed";

const store = frontofficeStore();

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
