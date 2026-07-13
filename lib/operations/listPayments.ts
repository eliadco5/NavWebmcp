import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";

type PaymentMethod = "cash" | "credit_card" | "debit_card" | "digital_wallet";
type Category = "food" | "beverage" | "room_service" | "event" | "other";
type PaymentStatus = "completed" | "refunded" | "partial_refund";

interface Payment {
  paymentId: string;
  date: string;
  amount: number;
  method: PaymentMethod;
  category: Category;
  reservationId: string | null;
  guestId: string | null;
  covers: number;
  status: PaymentStatus;
  timestamp: string;
}

interface Adjustment {
  adjustmentId: string;
  type: "refund" | "no_show_fee" | "manual";
  paymentId: string | null;
  reservationId: string | null;
  amount: number;
  reason: string;
  reasonCode: string | null;
  adminId: string;
  timestamp: string;
}

declare global {
  var __financePayments: Map<string, Payment> | undefined;
  var __financeAdjustments: Map<string, Adjustment> | undefined;
}

const payments: Map<string, Payment> =
  globalThis.__financePayments ??
  (globalThis.__financePayments = (() => {
    const m = new Map<string, Payment>();
    m.set("pay_001", { paymentId: "pay_001", date: "2026-07-07", amount: 120.5, method: "credit_card", category: "food", reservationId: "res_001", guestId: "g_001", covers: 2, status: "completed", timestamp: "2026-07-07T12:30:00Z" });
    m.set("pay_002", { paymentId: "pay_002", date: "2026-07-07", amount: 85.0, method: "cash", category: "beverage", reservationId: "res_002", guestId: "g_002", covers: 3, status: "completed", timestamp: "2026-07-07T14:15:00Z" });
    m.set("pay_003", { paymentId: "pay_003", date: "2026-07-07", amount: 210.0, method: "digital_wallet", category: "room_service", reservationId: null, guestId: "g_003", covers: 1, status: "refunded", timestamp: "2026-07-07T19:45:00Z" });
    m.set("pay_004", { paymentId: "pay_004", date: "2026-07-08", amount: 150.0, method: "credit_card", category: "food", reservationId: "res_003", guestId: "g_004", covers: 4, status: "completed", timestamp: "2026-07-08T13:00:00Z" });
    m.set("pay_005", { paymentId: "pay_005", date: "2026-07-08", amount: 95.0, method: "debit_card", category: "beverage", reservationId: "res_004", guestId: "g_005", covers: 2, status: "completed", timestamp: "2026-07-08T18:30:00Z" });
    return m;
  })());

globalThis.__financeAdjustments ??
  (globalThis.__financeAdjustments = (() => {
    const m = new Map<string, Adjustment>();
    m.set("adj_001", { adjustmentId: "adj_001", type: "refund", paymentId: "pay_003", reservationId: null, amount: -210.0, reason: "Guest complaint - order not delivered", reasonCode: "UNDELIVERED", adminId: "admin_001", timestamp: "2026-07-07T21:00:00Z" });
    return m;
  })());

export const listPayments = defineOperation({
  name: "listPayments",
  title: "List Payments",
  description: "List all payment records for a given date, optionally filtered by method.",
  permission: "read",
  roles: ["admin"],
  module: "finance.payments",
  inputSchema: {
    date: z.string().describe("Date in YYYY-MM-DD format"),
    method: z
      .enum(["cash", "credit_card", "debit_card", "digital_wallet"])
      .optional()
      .describe("Filter by payment method"),
  },
  async handler({ date, method }, _ctx) {
    let results = [...payments.values()].filter((p) => p.date === date);
    if (method) {
      results = results.filter((p) => p.method === method);
    }
    results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const total = results
      .filter((p) => p.status !== "refunded")
      .reduce((s, p) => s + p.amount, 0);

    return ok({
      date,
      method: method ?? null,
      count: results.length,
      total: Math.round(total * 100) / 100,
      payments: results,
    });
  },
});
