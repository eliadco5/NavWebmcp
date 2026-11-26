// Small helpers the operations' preview() functions share (NavWebMcp 2.6.0).
import type { Reservation } from "@/lib/store";

/** " on 2026-07-07 at 19:00", or "" when the reservation has no slot. */
export function whenOf(r: Pick<Reservation, "date" | "time">): string {
  if (r.date && r.time) return ` on ${r.date} at ${r.time}`;
  if (r.date) return ` on ${r.date}`;
  return "";
}
