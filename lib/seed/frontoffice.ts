import { singleton, resetArray } from "./store";

// Table/reservation/bill state moved to lib/store.ts when the customer-booking
// store and the front-desk store were merged into one (a booking made via
// createReservation used to be invisible to checkInGuest and vice versa). Shift
// notes have no guestId/reservationId at all — they're generic handover notes,
// not tied to any single reservation — so they stayed here, unaffected.

export type ShiftNote = { id: string; note: string; author: string; createdAt: string; date: string };

const SHIFT_NOTES_KEY = "__frontofficeStore";
function buildShiftNotes(): ShiftNote[] {
  return [
    { id: "sn_001", note: "VIP guest at t_02, allergic to nuts.", author: "support_jane", createdAt: new Date(Date.now() - 2 * 3600000).toISOString(), date: new Date().toISOString().slice(0, 10) },
    { id: "sn_002", note: "POS terminal 3 rebooted, all clear.", author: "support_mike", createdAt: new Date(Date.now() - 1 * 3600000).toISOString(), date: new Date().toISOString().slice(0, 10) },
  ];
}

export function shiftNotes(): ShiftNote[] {
  return singleton(SHIFT_NOTES_KEY, buildShiftNotes);
}

export function resetShiftNotes(): void {
  resetArray(SHIFT_NOTES_KEY, buildShiftNotes);
}
