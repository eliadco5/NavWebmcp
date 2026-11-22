import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { findBugReport } from "@/lib/bugreports";
import { BugReportSchema } from "@/lib/bugreport/types";
import { Id } from "./schemas";

const ReportOut = BugReportSchema.omit({ screenshot: true }).extend({
  hasScreenshot: z.boolean().describe("A screenshot attachment exists"),
});

export const getBugReport = defineOperation({
  name: "getBugReport",
  title: "Get Bug Report",
  description:
    "Full bug report: user's description and expected/actual values, the picked element (selector, " +
    "React component, styles, text), data provenance (which op + field the value came from, and what " +
    "the API actually returned vs. what the UI showed), console log, network log, and `calls` — the " +
    "user's business calls in order. Recorded scenarios add `scenario.steps` (each UI step with the ops it " +
    "triggered and their results) and `repro`: pass `repro.invoke` as invoke({ calls: repro.invoke }) " +
    "to reproduce the data end state, `repro.playwright` a draft UI test. Binary attachments (screenshots, " +
    "DOM replay, video) are listed in `attachments` and served to admins at " +
    "GET /api/bug-report/<id>/attachments/<kind>.",
  permission: "read",
  roles: ["admin"],
  module: "support.bugs",
  inputSchema: {
    id: Id().describe("Bug report id (bug_…)"),
  },
  outputSchema: { report: ReportOut },
  untrustedOutput: true,
  async handler({ id }, _ctx) {
    const found = findBugReport(id);
    if (!found) return fail("NOT_FOUND", `Bug report ${id} not found`);
    const { screenshot, ...rest } = found;
    return ok({ report: { ...rest, hasScreenshot: Boolean(screenshot) || rest.attachments.some((a) => a.kind === "screenshot") } });
  },
});
