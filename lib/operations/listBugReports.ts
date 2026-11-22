import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { bugReports } from "@/lib/bugreports";
import { BugCategory, BugStatus } from "@/lib/bugreport/types";

export const listBugReports = defineOperation({
  name: "listBugReports",
  title: "List Bug Reports",
  description:
    "List bug reports users submitted from the in-app 'Report a bug' inspector, newest first. " +
    "Each summary names the operation/field the reported UI element was bound to, when known. " +
    "Use getBugReport for the full bundle.",
  permission: "read",
  roles: ["admin"],
  module: "support.bugs",
  inputSchema: {
    status: BugStatus.optional().describe("Only reports with this status"),
  },
  outputSchema: {
    count: z.number().int(),
    reports: z.array(z.object({
      id: z.string(),
      createdAt: z.string(),
      category: BugCategory,
      status: BugStatus,
      description: z.string(),
      reporterRole: z.string(),
      op: z.string().optional().describe("Operation the reported element's data came from"),
      field: z.string().optional(),
    })),
  },
  untrustedOutput: true,
  async handler({ status }, _ctx) {
    const reports = bugReports()
      .filter((r) => !status || r.status === status)
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        category: r.category,
        status: r.status,
        description: r.description.slice(0, 300),
        reporterRole: r.reporter.role,
        ...(r.element?.provenance?.op ? { op: r.element.provenance.op } : {}),
        ...(r.element?.provenance?.field ? { field: r.element.provenance.field } : {}),
      }));
    return ok({ count: reports.length, reports });
  },
});
