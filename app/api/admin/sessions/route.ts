import { readJsonOrEmpty } from "@/lib/http-limits";
import { NextRequest } from "next/server";
import { z } from "zod";
import { managementService } from "@/lib/management/service";
import { requireAdmin, isResponse } from "@/lib/management/guard";

export const dynamic = "force-dynamic";

// GET    /api/admin/sessions[?userId=]  — human sign-in sessions, newest activity first
// DELETE /api/admin/sessions { sid }    — revoke: the session stops working on its next
//                                         request, and so do agent tokens it authorised
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req, "admin.sessions_list");
  if (isResponse(admin)) return admin;
  const userId = req.nextUrl.searchParams.get("userId") ?? undefined;
  return Response.json({ success: true, data: { sessions: await managementService.listSessions({ userId }) } });
}

const Revoke = z.object({ sid: z.string().min(1).max(64) });

export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req, "admin.session_revoked");
  if (isResponse(admin)) return admin;
  const parsed = Revoke.safeParse((await readJsonOrEmpty(req)) as unknown);
  if (!parsed.success) {
    return Response.json({ success: false, error: { code: "INVALID_INPUT", message: "sid is required." } }, { status: 400 });
  }
  const r = await managementService.revokeSession(parsed.data.sid, admin.actor, admin.info);
  if (!r.found) return Response.json({ success: false, error: { code: "NOT_FOUND", message: "No such session." } }, { status: 404 });
  return Response.json({ success: true, data: r });
}
