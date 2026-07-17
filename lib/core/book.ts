import { ok, fail } from "@/lib/result";
import type { Result } from "@/lib/result";
import type { Slot, Reservation } from "@/lib/store";

export interface BookInput {
  date: string;
  time: string;
  partySize: number;
  name: string;
}

export interface BookResult {
  reservation: Reservation;
  validated: boolean;
}

export async function bookOrchestration(
  input: BookInput,
  call: (name: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<Result<BookResult>> {
  const { date, time, partySize, name } = input;

  // 1. AVAILABILITY — find the slot matching date/time/partySize
  const availResult = await call("searchAvailability", { date, partySize }) as {
    success: boolean;
    data?: { slots: Slot[] };
    error?: { code: string; message: string };
  };
  if (!availResult.success) {
    return fail(
      availResult.error?.code ?? "AVAILABILITY_ERROR",
      availResult.error?.message ?? "Failed to check availability"
    );
  }
  const slot = availResult.data?.slots.find((s) => s.time === time);
  if (!slot) {
    return fail("NO_AVAILABILITY", `No available slot on ${date} at ${time} for ${partySize} guest(s).`);
  }

  // 2. RESERVATION — create the booking
  const createResult = await call("createReservation", {
    slotId: slot.id,
    name,
    partySize,
  }) as {
    success: boolean;
    data?: { reservation: Reservation };
    error?: { code: string; message: string };
  };
  if (!createResult.success) {
    return fail(
      createResult.error?.code ?? "CREATE_FAILED",
      createResult.error?.message ?? "Failed to create reservation"
    );
  }
  const reservation = createResult.data!.reservation;

  // 3. VALIDATE — post-condition: reservation exists and slot is no longer available
  const [verifyRes, recheck] = await Promise.all([
    call("getReservation", { reservationId: reservation.id }) as Promise<{
      success: boolean;
      data?: { reservation: Reservation };
    }>,
    call("searchAvailability", { date, partySize }) as Promise<{
      success: boolean;
      data?: { slots: Slot[] };
    }>,
  ]);

  const reservationExists = verifyRes.success && !!verifyRes.data?.reservation;
  const slotStillOpen = recheck.data?.slots.some((s) => s.id === slot.id) ?? false;

  if (!reservationExists || slotStillOpen) {
    await call("cancelReservation", { reservationId: reservation.id, confirm: true });
    return fail("VALIDATION_FAILED", "Booking could not be validated (inconsistent state). Please try again.");
  }

  return ok({ reservation, validated: true });
}
