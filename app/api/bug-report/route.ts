import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { authenticateSession } from "@/lib/management/auth";
import { withSharedState } from "@/lib/shared-state";
import { submitBugReport, MAX_BODY_BYTES } from "@/lib/bugreport/submit";
import { readTextCapped } from "@/lib/http-limits";
import { attachmentResponse } from "@/lib/bugreport/http";

export const dynamic = "force-dynamic";

// Separate from /api/call on purpose: a report bundle is large (console,
// network, DOM, screenshot) and must not be copied into the audit log, which
// /api/call records every input of. Triage goes through the listBugReports /
// getBugReport ops instead, which ARE normal registry ops.

/** Submit a report — any signed-in role. */
export const POST = withSharedState(async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const { user } = await authenticateSession(cookieStore);
  if (!user) {
    return Response.json({ success: false, error: { code: "UNAUTHENTICATED", message: "Login required." } }, { status: 401 });
  }
  // Stop reading at the cap (lib/bugreport/submit.ts checks the same limit).
  const raw = await readTextCapped(req, MAX_BODY_BYTES);
  if (raw instanceof Response) return raw;
  const outcome = await submitBugReport(user, raw);
  if (!outcome.ok) {
    return Response.json({ success: false, error: { code: outcome.code, message: outcome.message } }, { status: outcome.status });
  }
  const { id, sinks } = outcome.report;
  // uploadToken lets this browser PUT attachments to /api/bug-report/<id>/attachments/<kind>
  // and then POST /api/bug-report/<id>/finalize — see lib/bugreport/submit.ts.
  return Response.json({ success: true, data: { id, sinks, uploadToken: outcome.uploadToken } });
});

/** Legacy alias for GET /api/bug-report/<id>/attachments/screenshot — admin only. */
export const GET = withSharedState(async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const { user } = await authenticateSession(cookieStore);
  if (!user || user.role !== "admin") {
    return Response.json({ success: false, error: { code: "FORBIDDEN", message: "Admin only." } }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id") ?? "";
  return attachmentResponse(id, "screenshot");
});
