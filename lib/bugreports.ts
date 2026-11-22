import { singleton } from "@/lib/seed/store";
import type { BugReport } from "@/lib/bugreport/types";

// Newest first. Persisted through lib/shared-state like every other store, so
// it's capped hard. Binary attachments live outside it (lib/bugreport/attachments.ts).
export const MAX_BUG_REPORTS = 20;

const KEY = "__bugReports";

export function bugReports(): BugReport[] {
  return singleton<BugReport[]>(KEY, () => []);
}

/** Adds newest-first; returns the reports evicted by the cap so the caller can
 *  drop their attachments. */
export function addBugReport(report: BugReport): BugReport[] {
  const arr = bugReports();
  arr.unshift(report);
  return arr.length > MAX_BUG_REPORTS ? arr.splice(MAX_BUG_REPORTS) : [];
}

export function findBugReport(id: string): BugReport | undefined {
  return bugReports().find((r) => r.id === id);
}
