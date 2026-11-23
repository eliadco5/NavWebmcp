import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { authenticateSession } from "@/lib/management/auth";
import { withSharedState } from "@/lib/shared-state";
import { addAttachment } from "@/lib/bugreport/submit";
import { attachmentResponse, errorResponse } from "@/lib/bugreport/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; kind: string }> };

/** Upload one attachment (raw body) — authorized by the x-upload-token the
 *  submit returned, so the reporter needs no admin rights. */
export const PUT = withSharedState(async function PUT(req: NextRequest, ctx: Ctx) {
  const { id, kind } = await ctx.params;
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > 4_500_000) return errorResponse(413, "TOO_LARGE", "Attachment too large.");
  const data = Buffer.from(await req.arrayBuffer());
  const outcome = await addAttachment(id, kind, req.headers.get("x-upload-token"), req.headers.get("content-type") ?? "", data);
  if (!outcome.ok) return errorResponse(outcome.status, outcome.code, outcome.message);
  return Response.json({ success: true, data: { kind, bytes: outcome.bytes } });
});

/** Download one attachment — admin only. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const cookieStore = await cookies();
  const { user } = await authenticateSession(cookieStore);
  if (!user || user.role !== "admin") return errorResponse(403, "FORBIDDEN", "Admin only.");
  const { id, kind } = await ctx.params;
  return attachmentResponse(id, kind);
}
