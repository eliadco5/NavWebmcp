import { beforeEach, vi } from "vitest";

const SINGLETON_KEYS = [
  "__bookingStore",
  "__auditLog",
  "__loadedToolsStore",
  "__crmGuests",
  "__crmPreferences",
  "__crmLoyalty",
  "__crmCommunications",
  "__tasksStore",
  "__tasksSeq",
  "__frontofficeStore",
  "__financePayments",
  "__financeAdjustments",
  "__housekeepingTableStatus",
  "__housekeepingScheduleItems",
  "__housekeepingInspections",
  "__bugReports",
  "__bugAttachments",
  "__featureIntroSeen",
  "__uiRelay",
  "__uiRelayPort",
  "__uiComponentRegistry",
  "__mgmtRecords",
  "__mgmtTouched",
  "__mgmtSoftware",
  "__auditStore",
  "__auditRecorder",
] as const;

beforeEach(() => {
  for (const key of SINGLETON_KEYS) {
    delete (globalThis as Record<string, unknown>)[key];
  }
  vi.resetModules();
});
