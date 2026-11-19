import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { crmLoyalty, computeLoyaltyTier, type LoyaltyAccount } from "@/lib/seed";
import { Id, Points, LongText, LoyaltySchema, LoyaltyTier } from "./schemas";

const loyaltyMap = crmLoyalty();

export const addLoyaltyPoints = defineOperation({
  name: "addLoyaltyPoints",
  title: "Add Loyalty Points",
  description: "Add loyalty points to a guest account after a qualifying visit.",
  permission: "write",
  roles: ["support", "admin"],
  module: "crm.loyalty",
  inputSchema: {
    guestId: Id().describe("The unique guest identifier"),
    points: Points().describe("Number of points to add"),
    reason: LongText().min(1).describe("Reason for awarding points (e.g. visit date or event description)"),
  },
  outputSchema: {
    loyalty: LoyaltySchema.describe("The updated loyalty account"),
    pointsAdded: z.number().int(),
    previousTier: LoyaltyTier,
    currentTier: LoyaltyTier,
    tierUpgrade: z.boolean().describe("True when this award moved the guest to a higher tier"),
  },
  async handler({ guestId, points, reason }, ctx) {
    const account = loyaltyMap.get(guestId);
    if (!account) return fail("NOT_FOUND", `No loyalty account found for guest ${guestId}`);
    const newBalance = account.pointBalance + points;
    const newLifetime = account.lifetimePoints + points;
    const previousTier = account.tier;
    const currentTier = computeLoyaltyTier(newLifetime);
    const updated: LoyaltyAccount = { ...account, pointBalance: newBalance, lifetimePoints: newLifetime, tier: currentTier };
    loyaltyMap.set(guestId, updated);
    return ok({ loyalty: updated, pointsAdded: points, previousTier, currentTier, tierUpgrade: previousTier !== currentTier });
  },
});
