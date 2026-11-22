import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { findBugReport } from "@/lib/bugreports";
import { BugStatus } from "@/lib/bugreport/types";
import { Id } from "./schemas";

export const updateBugReportStatus = defineOperation({
  name: "updateBugReportStatus",
  title: "Update Bug Report Status",
  description: "Move a bug report through triage: open → triaged → fixed.",
  permission: "write",
  roles: ["admin"],
  module: "support.bugs",
  inputSchema: {
    id: Id().describe("Bug report id (bug_…)"),
    status: BugStatus.describe("New status"),
  },
  outputSchema: { id: z.string(), status: BugStatus },
  async handler({ id, status }, _ctx) {
    const report = findBugReport(id);
    if (!report) return fail("NOT_FOUND", `Bug report ${id} not found`);
    report.status = status;
    return ok({ id, status });
  },
});
