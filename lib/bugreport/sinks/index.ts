import type { BugReport, SinkResult } from "@/lib/bugreport/types";
import { storeSink } from "./store";
import { jiraSink } from "./jira";
import { chatSink } from "./chat";

/** A destination a submitted bug report is delivered to. Add a new one by
 *  implementing this and appending it to SINKS.
 *
 *  phase "submit" runs when the JSON report arrives; "finalize" runs once the
 *  browser has finished uploading attachments (screenshots, replay, video),
 *  so external systems get the complete bundle. */
export interface BugReportSink {
  name: string;
  phase: "submit" | "finalize";
  /** Checked per run, so env changes (or tests) take effect without a restart. */
  enabled(): boolean;
  send(report: BugReport): Promise<{ ref?: string; url?: string }>;
}

export const SINKS: BugReportSink[] = [storeSink, jiraSink, chatSink];

/** Runs every enabled sink of `phase`. A failing sink is recorded, never
 *  thrown — the user's report must not be lost because Jira is down. */
export async function runSinks(
  report: BugReport,
  phase: BugReportSink["phase"],
  sinks: BugReportSink[] = SINKS,
): Promise<SinkResult[]> {
  const results: SinkResult[] = [];
  for (const sink of sinks) {
    if (sink.phase !== phase || !sink.enabled()) continue;
    try {
      const { ref, url } = await sink.send(report);
      results.push({ sink: sink.name, ok: true, ref, url });
    } catch (err) {
      results.push({ sink: sink.name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
