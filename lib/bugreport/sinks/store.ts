import { addBugReport } from "@/lib/bugreports";
import type { BugReportSink } from "./index";

/** Always-on: keeps the report in the app (admin "Bug reports" tab + the
 *  listBugReports/getBugReport ops over MCP/WebMCP). */
export const storeSink: BugReportSink = {
  name: "store",
  enabled: () => true,
  async send(report) {
    addBugReport(report);
    return { ref: report.id };
  },
};
