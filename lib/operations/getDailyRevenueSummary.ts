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

const adjustments: Map<string, Adjustment> =
  globalThis.__financeAdjustments ??
  (globalThis.__financeAdjustments = (() => {
    const m = new Map<string, Adjustment>();
    m.set("adj_001", { adjustmentId: "adj_001", type: "refund", paymentId: "pay_003", reservationId: null, amount: -210.0, reason: "Guest complaint - order not delivered", reasonCode: "UNDELIVERED", adminId: "admin_001", timestamp: "2026-07-07T21:00:00Z" });
    return m;
  })());

export const getDailyRevenueSummary = defineOperation({
  name: "getDailyRevenueSummary",
  title: "Get Daily Revenue Summary",
  description: "Get daily revenue breakdown by cover count, category, and payment method.",
  permission: "read",
  roles: ["admin"],
  module: "finance.revenue",
  inputSchema: {
    date: z.string().describe("Date in YYYY-MM-DD format"),
  },
  async handler({ date }, _ctx) {
    const dayPayments = [...payments.values()].filter((p) => p.date === date);
    const activePayments = dayPayments.filter((p) => p.status !== "refunded");

    const byCategory: Record<string, number> = {};
    const byMethod: Record<string, number> = {};
    let totalRevenue = 0;
    let totalCovers = 0;

    for (const p of activePayments) {
      totalRevenue += p.amount;
      totalCovers += p.covers;
      byCategory[p.category] = (byCategory[p.category] ?? 0) + p.amount;
      byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
    }

    const dayAdjustments = [...adjustments.values()].filter((a) =>
      a.timestamp.startsWith(date)
    );
    const adjustmentTotal = dayAdjustments.reduce((sum, a) => sum + a.amount, 0);

    const round = (n: number) => Math.round(n * 100) / 100;

    return ok({
      date,
      totalRevenue: round(totalRevenue),
      totalCovers,
      transactionCount: activePayments.length,
      adjustmentTotal: round(adjustmentTotal),
      netRevenue: round(totalRevenue + adjustmentTotal),
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([k, v]) => [k, round(v)])
      ),
      byMethod: Object.fromEntries(
        Object.entries(byMethod).map(([k, v]) => [k, round(v)])
      ),
    });
  },
});
