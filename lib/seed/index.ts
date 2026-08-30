// Barrel for every demo data store. Each op file used to own its own copy of a
// `declare global` + seed literal (duplicated 2-9x depending on the store); now
// there's exactly one factory per store, imported wherever it's needed.
export * from "./store";
export * from "./crm";
export * from "./tasks";
export * from "./housekeeping";
export * from "./finance";
export * from "./frontoffice";

import { resetCrmGuests, resetCrmPreferences, resetCrmLoyalty, resetCrmCommunications } from "./crm";
import { resetTasksStore } from "./tasks";
import { resetHousekeepingTableStatus, resetHousekeepingSchedule, resetHousekeepingInspections } from "./housekeeping";
import { resetFinancePayments, resetFinanceAdjustments } from "./finance";
import { resetShiftNotes } from "./frontoffice";
import { store } from "@/lib/store";

/** Re-seed every operations store that has actually been touched this request
 *  lifetime, in place. Used by POST /api/bench/reset ("Reset demo data" in the
 *  Agent tab) — recovery for a judge who, say, checks every guest out and is
 *  left staring at an empty Front Desk panel with no way back. */
export function resetAllSeedStores(): void {
  resetCrmGuests();
  resetCrmPreferences();
  resetCrmLoyalty();
  resetCrmCommunications();
  resetTasksStore();
  resetHousekeepingTableStatus();
  resetHousekeepingSchedule();
  resetHousekeepingInspections();
  resetFinancePayments();
  resetFinanceAdjustments();
  resetShiftNotes();
  store.resetFrontDeskSeed();
}
