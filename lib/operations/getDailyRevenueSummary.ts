import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { financePayments, financeAdjustments } from "@/lib/seed";

const payments = financePayments();
const adjustments = financeAdjustments();

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
