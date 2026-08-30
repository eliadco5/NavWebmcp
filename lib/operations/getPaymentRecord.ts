import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { financePayments, financeAdjustments } from "@/lib/seed";

const payments = financePayments();
const adjustments = financeAdjustments();

export const getPaymentRecord = defineOperation({
  name: "getPaymentRecord",
  title: "Get Payment Record",
  description: "Look up a payment record by payment ID.",
  permission: "read",
  roles: ["admin"],
  module: "finance.payments",
  inputSchema: {
    paymentId: z.string().describe("The payment ID to look up (e.g. pay_001)"),
  },
  async handler({ paymentId }, _ctx) {
    const payment = payments.get(paymentId);
    if (!payment) {
      return fail("NOT_FOUND", `No payment found with ID ${paymentId}`);
    }

    const relatedAdjustments = [...adjustments.values()].filter(
      (a) => a.paymentId === paymentId
    );

    return ok({ payment, adjustments: relatedAdjustments });
  },
});
