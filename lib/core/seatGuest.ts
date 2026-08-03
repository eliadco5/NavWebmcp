import { ok, fail } from "@/lib/result";
import type { Result } from "@/lib/result";

export interface SeatGuestInput {
  reservationId: string;
  tableId?: string;
}

export interface CheckinInfo {
  reservationId: string;
  tableId: string;
  guestName: string;
  partySize: number;
  seatedAt: string;
}

export interface SeatGuestResult {
  checkin: CheckinInfo;
  validated: boolean;
}

export async function seatGuestOrchestration(
  input: SeatGuestInput,
  call: (name: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<Result<SeatGuestResult>> {
  const { reservationId, tableId } = input;

  // 1. OCCUPANCY — make sure a fitting table is available before attempting check-in
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
  const hasAvailableTable = tableId
    ? occupancyResult.data?.tables.some((t) => t.tableId === tableId && t.status === "available")
    : occupancyResult.data?.tables.some((t) => t.status === "available");
  if (!hasAvailableTable) {
    return fail("NO_TABLE_AVAILABLE", "No available table right now.");
  }

  // 2. CHECK-IN — assign the table and seat the guest
  const checkinResult = (await call("checkInGuest", { reservationId, tableId })) as {
    success: boolean;
    data?: CheckinInfo;
    error?: { code: string; message: string };
  };
  if (!checkinResult.success) {
    return fail(
      checkinResult.error?.code ?? "CHECKIN_FAILED",
      checkinResult.error?.message ?? "Failed to check in guest"
    );
  }
  const checkin = checkinResult.data!;

  // 3. VALIDATE — post-condition: status is checked-in and the table now shows occupied
  const [statusRes, recheckOccupancy] = await Promise.all([
    call("getCheckinStatus", { reservationId }) as Promise<{
      success: boolean;
      data?: { status: string };
    }>,
    call("getOccupancy", {}) as Promise<{
      success: boolean;
      data?: { tables: { tableId: string; status: string }[] };
    }>,
  ]);

  const checkedIn = statusRes.success && statusRes.data?.status === "checked-in";
  const tableOccupied =
    recheckOccupancy.data?.tables.some(
      (t) => t.tableId === checkin.tableId && t.status === "occupied"
    ) ?? false;

  if (!checkedIn || !tableOccupied) {
    await call("checkOutGuest", { reservationId });
    return fail("VALIDATION_FAILED", "Check-in could not be validated (inconsistent state). Please try again.");
  }

  return ok({ checkin, validated: true });
}
