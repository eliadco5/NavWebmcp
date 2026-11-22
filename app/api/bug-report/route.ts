import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getOrProvisionUser } from "@/lib/auth-tokens";
import { withSharedState } from "@/lib/shared-state";
import { submitBugReport } from "@/lib/bugreport/submit";
import { findBugReport } from "@/lib/bugreports";

export const dynamic = "force-dynamic";

// Separate from /api/call on purpose: a report bundle is large (console,
// network, DOM, screenshot) and must not be copied into the audit log, which
// /api/call records every input of. Triage goes through the listBugReports /
// getBugReport ops instead, which ARE normal registry ops.

/** Submit a report — any signed-in role. */
export const POST = withSharedState(async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const { user } = getOrProvisionUser(cookieStore);
  if (!user) {
    return Response.json({ success: false, error: { code: "UNAUTHENTICATED", message: "Login required." } }, { status: 401 });
  }
  const outcome = await submitBugReport(user, await req.text());
  if (!outcome.ok) {
    return Response.json({ success: false, error: { code: outcome.code, message: outcome.message } }, { status: outcome.status });
  }
  const { id, sinks } = outcome.report;
  return Response.json({ success: true, data: { id, sinks } });
});

/** Screenshot for one report — admin only. Kept out of getBugReport's output
 *  so an agent reading a report doesn't pay for a base64 image in tokens. */
export const GET = withSharedState(async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const { user } = getOrProvisionUser(cookieStore);
  if (!user || user.role !== "admin") {
    return Response.json({ success: false, error: { code: "FORBIDDEN", message: "Admin only." } }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const report = findBugReport(id);
  if (!report?.screenshot) {
    return Response.json({ success: false, error: { code: "NOT_FOUND", message: "No screenshot for that report." } }, { status: 404 });
  }
  const [meta, b64] = report.screenshot.split(",", 2);
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? "image/jpeg";
  return new Response(Buffer.from(b64, "base64"), { headers: { "Content-Type": mime, "Cache-Control": "private, max-age=300" } });
});
