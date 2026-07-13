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

if (!globalThis.__financePayments) {
  const m = new Map<string, Payment>();
  m.set("pay_001", { paymentId: "pay_001", date: "2026-07-07", amount: 120.5, method: "credit_card", category: "food", reservationId: "res_001", guestId: "g_001", covers: 2, status: "completed", timestamp: "2026-07-07T12:30:00Z" });
  m.set("pay_002", { paymentId: "pay_002", date: "2026-07-07", amount: 85.0, method: "cash", category: "beverage", reservationId: "res_002", guestId: "g_002", covers: 3, status: "completed", timestamp: "2026-07-07T14:15:00Z" });
  m.set("pay_003", { paymentId: "pay_003", date: "2026-07-07", amount: 210.0, method: "digital_wallet", category: "room_service", reservationId: null, guestId: "g_003", covers: 1, status: "refunded", timestamp: "2026-07-07T19:45:00Z" });
  m.set("pay_004", { paymentId: "pay_004", date: "2026-07-08", amount: 150.0, method: "credit_card", category: "food", reservationId: "res_003", guestId: "g_004", covers: 4, status: "completed", timestamp: "2026-07-08T13:00:00Z" });
  m.set("pay_005", { paymentId: "pay_005", date: "2026-07-08", amount: 95.0, method: "debit_card", category: "beverage", reservationId: "res_004", guestId: "g_005", covers: 2, status: "completed", timestamp: "2026-07-08T18:30:00Z" });
  globalThis.__financePayments = m;
}

const adjustments: Map<string, Adjustment> =
  globalThis.__financeAdjustments ??
  (globalThis.__financeAdjustments = (() => {
    const m = new Map<string, Adjustment>();
    m.set("adj_001", { adjustmentId: "adj_001", type: "refund", paymentId: "pay_003", reservationId: null, amount: -210.0, reason: "Guest complaint - order not delivered", reasonCode: "UNDELIVERED", adminId: "admin_001", timestamp: "2026-07-07T21:00:00Z" });
    return m;
  })());

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
    if (paymentId && !globalThis.__financePayments?.has(paymentId)) {
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
