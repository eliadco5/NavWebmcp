import type { BugReport, SinkResult } from "@/lib/bugreport/types";
import { storeSink } from "./store";
import { jiraSink } from "./jira";
import { chatSink } from "./chat";

/** A destination a submitted bug report is delivered to. Add a new one by
 *  implementing this and appending it to SINKS. */
export interface BugReportSink {
  name: string;
  /** Checked per submit, so env changes (or tests) take effect without a restart. */
  enabled(): boolean;
  send(report: BugReport): Promise<{ ref?: string; url?: string }>;
}

export const SINKS: BugReportSink[] = [storeSink, jiraSink, chatSink];

/** Runs every enabled sink. A failing sink is recorded, never thrown — the
 *  user's report must not be lost because Jira is down. */
export async function runSinks(report: BugReport, sinks: BugReportSink[] = SINKS): Promise<SinkResult[]> {
  const results: SinkResult[] = [];
  for (const sink of sinks) {
    if (!sink.enabled()) continue;
    try {
      const { ref, url } = await sink.send(report);
      results.push({ sink: sink.name, ok: true, ref, url });
    } catch (err) {
      results.push({ sink: sink.name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
