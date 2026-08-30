import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { financeAdjustments, type Adjustment } from "@/lib/seed";

const adjustments = financeAdjustments();

export const applyNoShowFee = defineOperation({
  name: "applyNoShowFee",
  title: "Apply No-Show Fee",
  description: "Apply a no-show fee to a reservation. Requires confirmation. Admin only.",
  permission: "write",
  requiresConfirmation: true,
  roles: ["admin"],
  module: "finance.adjustments",
  inputSchema: {
    reservationId: z.string().describe("Reservation ID to charge the no-show fee against"),
    feeAmount: z.number().positive().describe("Fee amount to charge in the property currency"),
    reason: z.string().min(5).describe("Reason for the no-show fee (e.g. guest did not call to cancel)"),
  },
  async handler({ reservationId, feeAmount, reason }, ctx) {
    const existing = [...adjustments.values()].find(
      (a) => a.type === "no_show_fee" && a.reservationId === reservationId
    );
    if (existing) {
      return fail(
        "FEE_ALREADY_APPLIED",
        `A no-show fee has already been applied for reservation ${reservationId} (${existing.adjustmentId})`
      );
    }

    const adjustmentId = `adj_${Date.now()}`;
    const timestamp = new Date().toISOString();

    const adjustment: Adjustment = {
      adjustmentId,
      type: "no_show_fee",
      paymentId: null,
      reservationId,
      amount: feeAmount,
      reason,
      reasonCode: "NO_SHOW",
      adminId: ctx.userId,
      timestamp,
    };

    adjustments.set(adjustmentId, adjustment);

    return ok({ adjustmentId, reservationId, feeAmount, timestamp });
  },
});
