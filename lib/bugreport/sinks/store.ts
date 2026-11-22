import { addBugReport } from "@/lib/bugreports";
import { deleteAttachments } from "@/lib/bugreport/attachments";
import { ATTACHMENT_KINDS } from "@/lib/bugreport/types";
import type { BugReportSink } from "./index";

/** Always-on, runs at submit: keeps the report in the app (admin "Bug reports"
 *  tab + the listBugReports/getBugReport ops over MCP/WebMCP). */
export const storeSink: BugReportSink = {
  name: "store",
  phase: "submit",
  enabled: () => true,
  async send(report) {
    const evicted = addBugReport(report);
    for (const old of evicted) await deleteAttachments(old.id, ATTACHMENT_KINDS);
    return { ref: report.id };
  },
};
