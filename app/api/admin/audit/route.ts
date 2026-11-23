import { NextRequest } from "next/server";
import { managementService } from "@/lib/management/service";
import { requireAdmin, isResponse } from "@/lib/management/guard";
import { AuditQuerySchema, issues, paramsToObject } from "@/lib/management/queries";

export const dynamic = "force-dynamic";

// GET /api/admin/audit?actorType=agent&targetType=reservation&limit=50&beforeSeq=…
// Newest first; `nextBeforeSeq` is the cursor for the next page.
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req, "admin.audit_query");
  if (isResponse(admin)) return admin;
  const parsed = AuditQuerySchema.safeParse(paramsToObject(req.nextUrl.searchParams, ["beforeSeq", "limit"]));
  if (!parsed.success) {
    return Response.json({ success: false, error: { code: "INVALID_INPUT", message: issues(parsed.error) } }, { status: 400 });
  }
  return Response.json({ success: true, data: await managementService.queryAudit(parsed.data) });
}
