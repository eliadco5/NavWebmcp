import { NextRequest } from "next/server";
import { managementService } from "@/lib/management/service";
import { requireAdmin, isResponse } from "@/lib/management/guard";

export const dynamic = "force-dynamic";

// GET /api/admin/audit/verify — recompute the hash chain over everything retained.
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req, "admin.audit_verify");
  if (isResponse(admin)) return admin;
  return Response.json({ success: true, data: await managementService.verifyAudit() });
}
