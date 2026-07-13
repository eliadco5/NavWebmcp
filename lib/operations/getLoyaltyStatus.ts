import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";

interface LoyaltyRedemption {
  date: string;
  pointsRedeemed: number;
  description: string;
}

interface LoyaltyAccount {
  guestId: string;
  tier: "bronze" | "silver" | "gold" | "platinum";
  pointBalance: number;
  lifetimePoints: number;
  redemptionHistory: LoyaltyRedemption[];
}

declare global {
  var __crmLoyalty: Map<string, LoyaltyAccount> | undefined;
}

const loyaltyMap = globalThis.__crmLoyalty ?? (globalThis.__crmLoyalty = new Map<string, LoyaltyAccount>([
  ["g_001", { guestId: "g_001", tier: "gold", pointBalance: 4200, lifetimePoints: 12500, redemptionHistory: [{ date: "2024-05-10", pointsRedeemed: 500, description: "Free dessert" }] }],
  ["g_002", { guestId: "g_002", tier: "silver", pointBalance: 1850, lifetimePoints: 4300, redemptionHistory: [] }],
  ["g_003", { guestId: "g_003", tier: "platinum", pointBalance: 9800, lifetimePoints: 35000, redemptionHistory: [{ date: "2024-04-22", pointsRedeemed: 2000, description: "Complimentary dinner for two" }] }],
  ["g_004", { guestId: "g_004", tier: "bronze", pointBalance: 320, lifetimePoints: 320, redemptionHistory: [] }],
  ["g_005", { guestId: "g_005", tier: "silver", pointBalance: 2100, lifetimePoints: 5800, redemptionHistory: [{ date: "2024-03-15", pointsRedeemed: 300, description: "Complimentary appetizer" }] }],
]));

export const getLoyaltyStatus = defineOperation({
  name: "getLoyaltyStatus",
  title: "Get Loyalty Status",
  description: "Get loyalty tier, point balance, and redemption history for a guest.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "crm.loyalty",
  inputSchema: {
    guestId: z.string().describe("The unique guest identifier"),
  },
  async handler({ guestId }, ctx) {
    const loyalty = loyaltyMap.get(guestId);
    if (!loyalty) return fail("NOT_FOUND", `No loyalty account found for guest ${guestId}`);
    return ok({ loyalty });
  },
});
