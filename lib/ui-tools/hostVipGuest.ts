"use client";

import { serverCall } from "@/app/providers";
import { hostVipGuestOrchestration } from "@/lib/core/hostVipGuest";

export type { HostVipGuestInput, HostVipGuestResult } from "@/lib/core/hostVipGuest";

export function hostVipGuest(input: Parameters<typeof hostVipGuestOrchestration>[0]) {
  return hostVipGuestOrchestration(input, serverCall);
}
