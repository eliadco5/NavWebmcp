import { NextRequest } from "next/server";
import { withSharedState } from "@/lib/shared-state";
import { finalizeBugReport } from "@/lib/bugreport/submit";
import { errorResponse } from "@/lib/bugreport/http";

export const dynamic = "force-dynamic";

/** Called by the browser after its attachment uploads settle: runs the
 *  "finalize" sinks (Jira, …) so they get the complete bundle. Idempotent. */
export const POST = withSharedState(async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const outcome = await finalizeBugReport(id, req.headers.get("x-upload-token"));
  if (!outcome.ok) return errorResponse(outcome.status, outcome.code, outcome.message);
  return Response.json({ success: true, data: { id, sinks: outcome.report.sinks } });
});
