import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";

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

function summarizeDay(date: string) {
  const dayPayments = [...payments.values()].filter(
    (p) => p.date === date && p.status !== "refunded"
  );
  const totalRevenue = dayPayments.reduce((s, p) => s + p.amount, 0);
  const totalCovers = dayPayments.reduce((s, p) => s + p.covers, 0);
  const adjustmentTotal = [...adjustments.values()]
    .filter((a) => a.timestamp.startsWith(date))
    .reduce((s, a) => s + a.amount, 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    date,
    totalRevenue: round(totalRevenue),
    totalCovers,
    transactionCount: dayPayments.length,
    adjustmentTotal: round(adjustmentTotal),
    netRevenue: round(totalRevenue + adjustmentTotal),
  };
}

export const getWeeklyRevenueSummary = defineOperation({
  name: "getWeeklyRevenueSummary",
  title: "Get Weekly Revenue Summary",
  description: "Get weekly revenue summary with day-by-day breakdown.",
  permission: "read",
  roles: ["admin"],
  module: "finance.revenue",
  inputSchema: {
    weekStartDate: z.string().describe("First day of the week in YYYY-MM-DD format"),
  },
  async handler({ weekStartDate }, _ctx) {
    const start = new Date(weekStartDate);
    if (isNaN(start.getTime())) {
      return fail("INVALID_DATE", "weekStartDate must be a valid YYYY-MM-DD date");
    }

    const days: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      days.push(d.toISOString().slice(0, 10));
    }

    const dailySummaries = days.map(summarizeDay);

    const round = (n: number) => Math.round(n * 100) / 100;
    const weekTotalRevenue = dailySummaries.reduce((s, d) => s + d.totalRevenue, 0);
    const weekNetRevenue = dailySummaries.reduce((s, d) => s + d.netRevenue, 0);
    const weekTotalCovers = dailySummaries.reduce((s, d) => s + d.totalCovers, 0);
    const weekTransactions = dailySummaries.reduce((s, d) => s + d.transactionCount, 0);

    return ok({
      weekStartDate,
      weekEndDate: days[6],
      totalRevenue: round(weekTotalRevenue),
      netRevenue: round(weekNetRevenue),
      totalCovers: weekTotalCovers,
      totalTransactions: weekTransactions,
      days: dailySummaries,
    });
  },
});
