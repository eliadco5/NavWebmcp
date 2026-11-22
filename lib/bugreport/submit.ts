import { BugReportInputSchema, callsFromNetwork, AttachmentKind, type BugReport } from "./types";
import { runSinks, type BugReportSink } from "./sinks";
import { buildRepro } from "./repro";
import { checkAttachment, putAttachment } from "./attachments";
import { findBugReport } from "@/lib/bugreports";
import { signUploadToken, verifyUploadToken } from "@/lib/auth-tokens";

export const MAX_BODY_BYTES = 1_500_000;

export interface Reporter { id: string; role: string; displayName: string }

type Fail = { ok: false; status: number; code: string; message: string };
const fail = (status: number, code: string, message: string): Fail => ({ ok: false, status, code, message });

export type SubmitOutcome = { ok: true; report: BugReport; uploadToken: string } | Fail;

/** Transport-free core of POST /api/bug-report, so it's testable without Next.
 *  Runs "submit"-phase sinks (the store); attachments and "finalize"-phase
 *  sinks (Jira, …) follow via addAttachment / finalizeBugReport. */
export async function submitBugReport(
  reporter: Reporter,
  rawBody: string,
  sinks?: BugReportSink[],
): Promise<SubmitOutcome> {
  if (rawBody.length > MAX_BODY_BYTES) {
    return fail(413, "TOO_LARGE", `Report exceeds ${MAX_BODY_BYTES} bytes — try without the screenshot.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return fail(400, "INVALID_INPUT", "Body is not valid JSON.");
  }
  const parsed = BugReportInputSchema.safeParse(json);
  if (!parsed.success) {
    return fail(400, "INVALID_INPUT", parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }

  const { screenshot, ...input } = parsed.data;
  // id/createdAt/reporter/status are server-assigned — never taken from the body.
  const report: BugReport = {
    ...input,
    id: `bug_${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    reporter: { userId: reporter.id, role: reporter.role, displayName: reporter.displayName },
    status: "open",
    calls: callsFromNetwork(input.network),
    sinks: [],
    attachments: [],
    finalized: false,
    ...(input.scenario ? {
      repro: buildRepro(input.scenario, { expected: input.expected, actual: input.actual, description: input.description }),
    } : {}),
  };

  // Legacy inline screenshot → attachment, so every image is served the same way.
  if (screenshot) {
    const [meta, b64] = screenshot.split(",", 2);
    const mime = /data:([^;]+)/.exec(meta)?.[1] ?? "image/jpeg";
    const data = Buffer.from(b64, "base64");
    if (!checkAttachment("screenshot", mime, data.length)) {
      await putAttachment(report.id, "screenshot", { mime, data });
      report.attachments.push({ kind: "screenshot", mime, bytes: data.length });
    }
  }

  report.sinks = await runSinks(report, "submit", sinks);
  return { ok: true, report, uploadToken: signUploadToken(report.id) };
}

export type AttachOutcome = { ok: true; bytes: number } | Fail;

/** Core of PUT /api/bug-report/[id]/attachments/[kind]. */
export async function addAttachment(
  reportId: string, kindRaw: string, token: string | null, mime: string, data: Buffer,
): Promise<AttachOutcome> {
  if (!token || !verifyUploadToken(token, reportId)) return fail(403, "FORBIDDEN", "Missing or expired upload token.");
  const kind = AttachmentKind.safeParse(kindRaw);
  if (!kind.success) return fail(400, "INVALID_INPUT", `Unknown attachment kind ${kindRaw}.`);
  const report = findBugReport(reportId);
  if (!report) return fail(404, "NOT_FOUND", `Bug report ${reportId} not found.`);
  if (report.finalized) return fail(409, "FINALIZED", "Report is already finalized.");
  const cleanMime = mime.split(";")[0].trim().toLowerCase();
  const problem = checkAttachment(kind.data, cleanMime, data.length);
  if (problem) return fail(problem.startsWith("Unsupported") ? 415 : 413, "INVALID_ATTACHMENT", problem);

  await putAttachment(reportId, kind.data, { mime: cleanMime, data });
  report.attachments = [...report.attachments.filter((a) => a.kind !== kind.data), { kind: kind.data, mime: cleanMime, bytes: data.length }];
  return { ok: true, bytes: data.length };
}

export type FinalizeOutcome = { ok: true; report: BugReport } | Fail;

/** Core of POST /api/bug-report/[id]/finalize. Idempotent. */
export async function finalizeBugReport(reportId: string, token: string | null, sinks?: BugReportSink[]): Promise<FinalizeOutcome> {
  if (!token || !verifyUploadToken(token, reportId)) return fail(403, "FORBIDDEN", "Missing or expired upload token.");
  const report = findBugReport(reportId);
  if (!report) return fail(404, "NOT_FOUND", `Bug report ${reportId} not found.`);
  if (!report.finalized) {
    report.finalized = true;
    report.sinks = [...report.sinks, ...(await runSinks(report, "finalize", sinks))];
  }
  return { ok: true, report };
}
