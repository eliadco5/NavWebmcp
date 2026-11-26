import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { financePayments } from "@/lib/seed";
import { IsoDate, PaymentMethodSchema, PaymentSchema } from "./schemas";

const payments = financePayments();

export const listPayments = defineOperation({
  name: "listPayments",
  title: "List Payments",
  description: "List all payment records for a given date, optionally filtered by method.",
  permission: "read",
  roles: ["admin"],
  module: "finance.payments",
  list: { key: "payments", id: "paymentId" },
  inputSchema: {
    date: IsoDate().describe("Date in YYYY-MM-DD format"),
    method: PaymentMethodSchema
      .optional()
      .describe("Filter by payment method"),
  },
  outputSchema: {
    date: z.string(),
    method: PaymentMethodSchema.nullable().describe("The filter applied, or null for all methods"),
    count: z.number().int(),
    total: z.number().describe("Sum of non-refunded payments"),
    payments: z.array(PaymentSchema).describe("Oldest first"),
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
