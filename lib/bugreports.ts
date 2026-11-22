import { singleton } from "@/lib/seed/store";
import type { BugReport } from "@/lib/bugreport/types";

// Newest first. Persisted through lib/shared-state like every other store, so
// it's capped hard — each report can carry a screenshot of a few hundred KB.
export const MAX_BUG_REPORTS = 20;

const KEY = "__bugReports";

export function bugReports(): BugReport[] {
  return singleton<BugReport[]>(KEY, () => []);
}

export function addBugReport(report: BugReport): void {
  const arr = bugReports();
  arr.unshift(report);
  if (arr.length > MAX_BUG_REPORTS) arr.length = MAX_BUG_REPORTS;
}

export function findBugReport(id: string): BugReport | undefined {
  return bugReports().find((r) => r.id === id);
}
