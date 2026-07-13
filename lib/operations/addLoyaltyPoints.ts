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

function computeTier(lifetimePoints: number): LoyaltyAccount["tier"] {
  if (lifetimePoints >= 20000) return "platinum";
  if (lifetimePoints >= 8000) return "gold";
  if (lifetimePoints >= 2000) return "silver";
  return "bronze";
}

export const addLoyaltyPoints = defineOperation({
  name: "addLoyaltyPoints",
  title: "Add Loyalty Points",
  description: "Add loyalty points to a guest account after a qualifying visit.",
  permission: "write",
  roles: ["support", "admin"],
  module: "crm.loyalty",
  inputSchema: {
    guestId: z.string().describe("The unique guest identifier"),
    points: z.number().int().positive().describe("Number of points to add"),
    reason: z.string().min(1).describe("Reason for awarding points (e.g. visit date or event description)"),
  },
  async handler({ guestId, points, reason }, ctx) {
    const account = loyaltyMap.get(guestId);
    if (!account) return fail("NOT_FOUND", `No loyalty account found for guest ${guestId}`);
    const newBalance = account.pointBalance + points;
    const newLifetime = account.lifetimePoints + points;
    const previousTier = account.tier;
    const currentTier = computeTier(newLifetime);
    const updated: LoyaltyAccount = { ...account, pointBalance: newBalance, lifetimePoints: newLifetime, tier: currentTier };
    loyaltyMap.set(guestId, updated);
    return ok({ loyalty: updated, pointsAdded: points, previousTier, currentTier, tierUpgrade: previousTier !== currentTier });
  },
});
