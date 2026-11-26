import { stamp } from "@/lib/provenance";
import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { financeAdjustments, type Adjustment } from "@/lib/seed";
import { Id, Money, LongText, Confirm } from "./schemas";

const adjustments = financeAdjustments();

export const applyNoShowFee = defineOperation({
  name: "applyNoShowFee",
  title: "Apply No-Show Fee",
  description:
    "Apply a no-show fee to a reservation. Admin only. Destructive: call without confirm first to get a preview " +
    "and a confirmationToken.",
  permission: "write",
  requiresConfirmation: true,
  roles: ["admin"],
  module: "finance.adjustments",
  inputSchema: {
    reservationId: Id().describe("Reservation ID to charge the no-show fee against"),
    feeAmount: Money().describe("Fee amount to charge in the property currency"),
    reason: LongText().min(5).describe("Reason for the no-show fee (e.g. guest did not call to cancel)"),
    confirm: Confirm(),
  },
  outputSchema: {
    adjustmentId: z.string(),
    reservationId: z.string(),
    feeAmount: z.number(),
    timestamp: z.string(),
  },
  async preview({ reservationId, feeAmount, reason }) {
    const existing = [...adjustments.values()].find((a) => a.type === "no_show_fee" && a.reservationId === reservationId);
    if (existing) {
      return fail("FEE_ALREADY_APPLIED", `A no-show fee has already been applied for reservation ${reservationId} (${existing.adjustmentId})`);
    }
    return ok({ summary: `Charge a no-show fee of ${feeAmount} on reservation ${reservationId} ("${reason}").`, data: { reservationId, feeAmount, reason } });
  },
  async handler({ reservationId, feeAmount, reason, confirm }, ctx) {
    if (!confirm) {
      return fail("CONFIRMATION_REQUIRED", "Pass confirm: true to confirm applying this no-show fee.");
    }

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
      createdBy: stamp(ctx, timestamp),
    };

    adjustments.set(adjustmentId, adjustment);

    return ok({ adjustmentId, reservationId, feeAmount, timestamp });
  },
});
