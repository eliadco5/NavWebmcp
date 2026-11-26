import { stamp } from "@/lib/provenance";
import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { financePayments, financeAdjustments, type Adjustment } from "@/lib/seed";
import { Id, Money, LongText, Confirm } from "./schemas";

const payments = financePayments();
const adjustments = financeAdjustments();

export const issueRefund = defineOperation({
  name: "issueRefund",
  title: "Issue Refund",
  description:
    "Issue a refund for a payment. Admin only. Destructive: call without confirm first to get a preview and a " +
    "confirmationToken.",
  permission: "write",
  requiresConfirmation: true,
  roles: ["admin"],
  module: "finance.adjustments",
  inputSchema: {
    paymentId: Id().describe("ID of the payment to refund"),
    reason: LongText().min(5).describe("Reason for the refund"),
    amount: Money()
      .optional()
      .describe("Partial refund amount; omit to refund the full payment amount"),
    confirm: Confirm(),
  },
  outputSchema: {
    adjustmentId: z.string(),
    paymentId: z.string(),
    refundAmount: z.number(),
    isPartial: z.boolean(),
    timestamp: z.string(),
  },
  async preview({ paymentId, reason, amount }) {
    const payment = payments.get(paymentId);
    if (!payment) return fail("NOT_FOUND", `No payment found with ID ${paymentId}`);
    if (payment.status === "refunded") return fail("ALREADY_REFUNDED", `Payment ${paymentId} has already been fully refunded`);
    const refundAmount = amount ?? payment.amount;
    if (refundAmount > payment.amount) {
      return fail("AMOUNT_EXCEEDS_PAYMENT", `Refund amount ${refundAmount} exceeds original payment amount ${payment.amount}`);
    }
    const isPartial = refundAmount < payment.amount;
    return ok({
      summary: `Refund ${refundAmount} of ${payment.amount} on payment ${paymentId}${isPartial ? " (partial)" : " (in full)"}: "${reason}".`,
      data: { paymentId, paymentAmount: payment.amount, refundAmount, isPartial, reason },
    });
  },
  async handler({ paymentId, reason, amount, confirm }, ctx) {
    if (!confirm) {
      return fail("CONFIRMATION_REQUIRED", "Pass confirm: true to confirm issuing this refund.");
    }

    const payment = payments.get(paymentId);
    if (!payment) {
      return fail("NOT_FOUND", `No payment found with ID ${paymentId}`);
    }
    if (payment.status === "refunded") {
      return fail("ALREADY_REFUNDED", `Payment ${paymentId} has already been fully refunded`);
    }

    const refundAmount = amount ?? payment.amount;
    if (refundAmount > payment.amount) {
      return fail(
        "AMOUNT_EXCEEDS_PAYMENT",
        `Refund amount ${refundAmount} exceeds original payment amount ${payment.amount}`
      );
    }

    const isPartial = refundAmount < payment.amount;
    const adjustmentId = `adj_${Date.now()}`;
    const timestamp = new Date().toISOString();

    const adjustment: Adjustment = {
      adjustmentId,
      type: "refund",
      paymentId,
      reservationId: payment.reservationId,
      amount: -refundAmount,
      reason,
      reasonCode: "REFUND",
      adminId: ctx.userId,
      timestamp,
      createdBy: stamp(ctx, timestamp),
    };

    adjustments.set(adjustmentId, adjustment);
    payments.set(paymentId, {
      ...payment,
      status: isPartial ? "partial_refund" : "refunded",
      lastModifiedBy: stamp(ctx, timestamp),
    });

    return ok({ adjustmentId, paymentId, refundAmount, isPartial, timestamp });
  },
});
