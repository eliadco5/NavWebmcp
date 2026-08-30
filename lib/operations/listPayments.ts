import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { financePayments } from "@/lib/seed";

const payments = financePayments();

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
