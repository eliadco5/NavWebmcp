import { BugReportInputSchema, callsFromNetwork, type BugReport } from "./types";
import { runSinks, type BugReportSink } from "./sinks";

export const MAX_BODY_BYTES = 1_500_000;

export interface Reporter { id: string; role: string; displayName: string }

export type SubmitOutcome =
  | { ok: true; report: BugReport }
  | { ok: false; status: number; code: string; message: string };

/** Transport-free core of POST /api/bug-report, so it's testable without Next. */
export async function submitBugReport(
  reporter: Reporter,
  rawBody: string,
  sinks?: BugReportSink[],
): Promise<SubmitOutcome> {
  if (rawBody.length > MAX_BODY_BYTES) {
    return { ok: false, status: 413, code: "TOO_LARGE", message: `Report exceeds ${MAX_BODY_BYTES} bytes — try without the screenshot.` };
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, code: "INVALID_INPUT", message: "Body is not valid JSON." };
  }
  const parsed = BugReportInputSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false, status: 400, code: "INVALID_INPUT",
      message: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  // id/createdAt/reporter/status are server-assigned — never taken from the body.
  const report: BugReport = {
    ...parsed.data,
    id: `bug_${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    reporter: { userId: reporter.id, role: reporter.role, displayName: reporter.displayName },
    status: "open",
    calls: callsFromNetwork(parsed.data.network),
    sinks: [],
  };
  report.sinks = await runSinks(report, sinks);
  return { ok: true, report };
}
