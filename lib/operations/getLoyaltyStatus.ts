import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { crmLoyalty } from "@/lib/seed";
import { Id, LoyaltySchema } from "./schemas";

const loyaltyMap = crmLoyalty();

export const getLoyaltyStatus = defineOperation({
  name: "getLoyaltyStatus",
  title: "Get Loyalty Status",
  description: "Get loyalty tier, point balance, and redemption history for a guest.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "crm.loyalty",
  inputSchema: {
    guestId: Id().describe("The unique guest identifier"),
  },
  outputSchema: { loyalty: LoyaltySchema },
  async handler({ guestId }, ctx) {
    const loyalty = loyaltyMap.get(guestId);
    if (!loyalty) return fail("NOT_FOUND", `No loyalty account found for guest ${guestId}`);
    return ok({ loyalty });
  },
});
