import { singleton } from "./store";

export type FrontofficeTable = {
  id: string;
  status: "available" | "occupied" | "reserved";
  capacity: number;
  reservationId?: string;
  seatedAt?: string;
  guestId?: string;
};

export type FrontofficeReservation = {
  id: string;
  guestId: string;
  guestName: string;
  partySize: number;
  tableId?: string;
  status: "pending" | "checked-in" | "checked-out" | "cancelled";
};

export type FrontofficeBill = {
  reservationId: string;
  tableId: string;
  items: { name: string; qty: number; price: number }[];
  total: number;
  generatedAt: string;
};

export type ShiftNote = { id: string; note: string; author: string; createdAt: string; date: string };

export interface FrontofficeState {
  tables: Map<string, FrontofficeTable>;
  reservations: Map<string, FrontofficeReservation>;
  bills: Map<string, FrontofficeBill>;
  shiftNotes: ShiftNote[];
}

function seedFrontofficeState(): FrontofficeState {
  return {
    tables: new Map([
      ["t_01", { id: "t_01", status: "available", capacity: 2 }],
      ["t_02", { id: "t_02", status: "occupied", capacity: 4, reservationId: "res_001", seatedAt: new Date(Date.now() - 45 * 60000).toISOString(), guestId: "g_001" }],
      ["t_03", { id: "t_03", status: "available", capacity: 4 }],
      ["t_04", { id: "t_04", status: "reserved", capacity: 6, reservationId: "res_002" }],
      ["t_05", { id: "t_05", status: "available", capacity: 2 }],
    ]),
    reservations: new Map([
      ["res_001", { id: "res_001", guestId: "g_001", guestName: "Alice Martin", partySize: 2, tableId: "t_02", status: "checked-in" }],
      ["res_002", { id: "res_002", guestId: "g_002", guestName: "Bob Chen", partySize: 5, status: "pending" }],
      ["res_003", { id: "res_003", guestId: "g_003", guestName: "Carol Diaz", partySize: 3, status: "pending" }],
    ]),
    bills: new Map(),
    shiftNotes: [
      { id: "sn_001", note: "VIP guest at t_02, allergic to nuts.", author: "support_jane", createdAt: new Date(Date.now() - 2 * 3600000).toISOString(), date: new Date().toISOString().slice(0, 10) },
      { id: "sn_002", note: "POS terminal 3 rebooted, all clear.", author: "support_mike", createdAt: new Date(Date.now() - 1 * 3600000).toISOString(), date: new Date().toISOString().slice(0, 10) },
    ],
  };
}

// Already relative to Date.now() rather than a fixed date, so — unlike crm/tasks/
// housekeeping/finance — this one didn't need re-dating, just de-duplicating out
// of the 9 op files that each declared an identical copy of this literal.
export function frontofficeStore(): FrontofficeState {
  return singleton<FrontofficeState>("__frontofficeStore", seedFrontofficeState);
}

/** Reset IN PLACE — every frontoffice op file bound `frontofficeStore()`'s
 *  return value at module load time, so replacing the globalThis object here
 *  would leave those files pointed at stale data instead of the reset one. */
export function resetFrontofficeStore(): void {
  const g = globalThis as unknown as { __frontofficeStore?: FrontofficeState };
  const existing = g.__frontofficeStore;
  if (!existing) return;
  const fresh = seedFrontofficeState();
  existing.tables.clear();
  for (const [k, v] of fresh.tables) existing.tables.set(k, v);
  existing.reservations.clear();
  for (const [k, v] of fresh.reservations) existing.reservations.set(k, v);
  existing.bills.clear();
  existing.shiftNotes.length = 0;
  existing.shiftNotes.push(...fresh.shiftNotes);
}
