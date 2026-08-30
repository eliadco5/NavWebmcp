import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { financePayments, financeAdjustments, type Adjustment } from "@/lib/seed";

const payments = financePayments();
const adjustments = financeAdjustments();

export const logManualAdjustment = defineOperation({
  name: "logManualAdjustment",
  title: "Log Manual Adjustment",
  description: "Log a manual revenue adjustment with reason code and amount.",
  permission: "write",
  roles: ["admin"],
  module: "finance.adjustments",
  inputSchema: {
    amount: z
      .number()
      .refine((v) => v !== 0, { message: "Amount must be non-zero" })
      .describe("Adjustment amount (positive to add revenue, negative to deduct)"),
    reason: z.string().min(5).describe("Human-readable reason for the adjustment"),
    reasonCode: z
      .enum(["COMP", "DISCOUNT", "ERROR_CORRECTION", "PROMOTION", "SPOILAGE", "OTHER"])
      .describe("Standardized reason code for reporting"),
    paymentId: z
      .string()
      .optional()
      .describe("Related payment ID if applicable"),
    reservationId: z
      .string()
      .optional()
      .describe("Related reservation ID if applicable"),
  },
  async handler({ amount, reason, reasonCode, paymentId, reservationId }, ctx) {
    if (paymentId && !payments.has(paymentId)) {
      return fail("PAYMENT_NOT_FOUND", `No payment found with ID ${paymentId}`);
    }

    const adjustmentId = `adj_${Date.now()}`;
    const timestamp = new Date().toISOString();

    const adjustment: Adjustment = {
      adjustmentId,
      type: "manual",
      paymentId: paymentId ?? null,
      reservationId: reservationId ?? null,
      amount,
      reason,
      reasonCode,
      adminId: ctx.userId,
      timestamp,
    };

    adjustments.set(adjustmentId, adjustment);

    return ok({ adjustmentId, amount, reasonCode, timestamp });
  },
});
