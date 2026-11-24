import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { financePayments, financeAdjustments } from "@/lib/seed";
import { IsoDate } from "./schemas";

const payments = financePayments();
const adjustments = financeAdjustments();

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
    weekStartDate: IsoDate().describe("First day of the week in YYYY-MM-DD format"),
  },
  outputSchema: {
    weekStartDate: z.string(),
    weekEndDate: z.string(),
    totalRevenue: z.number(),
    netRevenue: z.number(),
    totalCovers: z.number().int(),
    totalTransactions: z.number().int(),
    days: z.array(z.object({
      date: z.string(),
      totalRevenue: z.number(),
      totalCovers: z.number().int(),
      transactionCount: z.number().int(),
      adjustmentTotal: z.number(),
      netRevenue: z.number(),
    })).describe("Seven entries, one per day"),
  },
  async handler({ weekStartDate }, _ctx) {
    const start = new Date(weekStartDate);
    if (isNaN(start.getTime())) {
      return fail("INVALID_INPUT", "weekStartDate: must be a real calendar date (YYYY-MM-DD)", {
        details: [{ path: "weekStartDate", message: "Must be a real calendar date (YYYY-MM-DD)" }],
      });
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
