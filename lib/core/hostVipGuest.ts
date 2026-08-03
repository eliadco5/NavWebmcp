import { ok, fail } from "@/lib/result";
import type { Result } from "@/lib/result";

export interface HostVipGuestInput {
  reservationId: string;
  guestId: string;
  pointsToAward: number;
  visitNote: string;
}

export interface GuestPreferences {
  guestId: string;
  dietaryRestrictions: string[];
  seatingPreference: string;
  specialNotes: string;
  updatedAt: string | null;
}

export interface LoyaltyAccount {
  guestId: string;
  tier: "bronze" | "silver" | "gold" | "platinum";
  pointBalance: number;
  lifetimePoints: number;
}

export interface HostVipGuestResult {
  preferences: GuestPreferences;
  loyaltyBefore: LoyaltyAccount;
  loyaltyAfter: LoyaltyAccount;
  tierUpgrade: boolean;
  validated: boolean;
}

export async function hostVipGuestOrchestration(
  input: HostVipGuestInput,
  call: (name: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<Result<HostVipGuestResult>> {
  const { reservationId, guestId, pointsToAward, visitNote } = input;

  // 1. PREFERENCES — read dietary/seating notes so the host knows how to seat them
  const preferencesResult = (await call("getGuestPreferences", { guestId })) as {
    success: boolean;
    data?: { preferences: GuestPreferences };
    error?: { code: string; message: string };
  };
  if (!preferencesResult.success) {
    return fail(
      preferencesResult.error?.code ?? "PREFERENCES_ERROR",
      preferencesResult.error?.message ?? "Failed to read guest preferences"
    );
  }
  const preferences = preferencesResult.data!.preferences;

  // 2. LOYALTY (before) — read tier ahead of the visit
  const loyaltyBeforeResult = (await call("getLoyaltyStatus", { guestId })) as {
    success: boolean;
    data?: { loyalty: LoyaltyAccount };
    error?: { code: string; message: string };
  };
  if (!loyaltyBeforeResult.success) {
    return fail(
      loyaltyBeforeResult.error?.code ?? "LOYALTY_ERROR",
      loyaltyBeforeResult.error?.message ?? "Failed to read loyalty status"
    );
  }
  const loyaltyBefore = loyaltyBeforeResult.data!.loyalty;

  // 3. OCCUPANCY — make sure a fitting table is available before attempting check-in
  const occupancyResult = (await call("getOccupancy", {})) as {
    success: boolean;
    data?: { tables: { tableId: string; status: string }[] };
    error?: { code: string; message: string };
  };
  if (!occupancyResult.success) {
    return fail(
      occupancyResult.error?.code ?? "OCCUPANCY_ERROR",
      occupancyResult.error?.message ?? "Failed to check table occupancy"
    );
  }
  const hasAvailableTable = occupancyResult.data?.tables.some((t) => t.status === "available");
  if (!hasAvailableTable) {
    return fail("NO_TABLE_AVAILABLE", "No available table right now.");
  }

  // 4. CHECK-IN — seat the guest
  const checkinResult = (await call("checkInGuest", { reservationId })) as {
    success: boolean;
    data?: { tableId: string };
    error?: { code: string; message: string };
  };
  if (!checkinResult.success) {
    return fail(
      checkinResult.error?.code ?? "CHECKIN_FAILED",
      checkinResult.error?.message ?? "Failed to check in guest"
    );
  }

  // 5. VALIDATE — post-condition: status is checked-in
  const statusResult = (await call("getCheckinStatus", { reservationId })) as {
    success: boolean;
    data?: { status: string };
  };
  if (!statusResult.success || statusResult.data?.status !== "checked-in") {
    await call("checkOutGuest", { reservationId });
    return fail("VALIDATION_FAILED", "Check-in could not be validated (inconsistent state). Please try again.");
  }

  // 6. LOYALTY (award) — points for the visit
  const loyaltyAfterResult = (await call("addLoyaltyPoints", {
    guestId,
    points: pointsToAward,
    reason: visitNote,
  })) as {
    success: boolean;
    data?: { loyalty: LoyaltyAccount; tierUpgrade: boolean };
    error?: { code: string; message: string };
  };
  if (!loyaltyAfterResult.success) {
    return fail(
      loyaltyAfterResult.error?.code ?? "LOYALTY_AWARD_FAILED",
      loyaltyAfterResult.error?.message ?? "Failed to award loyalty points"
    );
  }
  const loyaltyAfter = loyaltyAfterResult.data!.loyalty;
  const tierUpgrade = loyaltyAfterResult.data!.tierUpgrade;

  // 7. LOG — record the visit
  const logResult = (await call("logCommunication", {
    guestId,
    type: "note",
    subject: "VIP visit hosted",
    body: visitNote,
  })) as { success: boolean; error?: { code: string; message: string } };
  if (!logResult.success) {
    return fail(
      logResult.error?.code ?? "LOG_FAILED",
      logResult.error?.message ?? "Failed to log the visit"
    );
  }

  return ok({ preferences, loyaltyBefore, loyaltyAfter, tierUpgrade, validated: true });
}
