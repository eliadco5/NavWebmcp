"use client";

import { serverCall } from "@/app/providers";
import { seatGuestOrchestration } from "@/lib/core/seatGuest";

export type { SeatGuestInput, SeatGuestResult } from "@/lib/core/seatGuest";

export function seatGuest(input: Parameters<typeof seatGuestOrchestration>[0]) {
  return seatGuestOrchestration(input, serverCall);
}
