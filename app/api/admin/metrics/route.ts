import { NextRequest } from "next/server";
import { managementService } from "@/lib/management/service";
import { requireAdmin, isResponse } from "@/lib/management/guard";
import { UsageQuerySchema, issues, paramsToObject } from "@/lib/management/queries";

export const dynamic = "force-dynamic";

// GET /api/admin/metrics?from=…&to=…&topOperations=20 — usage summary
// (lib/telemetry/summary.ts): adoption, human vs agent usage, latency vs SLO.
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req, "admin.metrics");
  if (isResponse(admin)) return admin;
  const parsed = UsageQuerySchema.safeParse(paramsToObject(req.nextUrl.searchParams, ["topOperations"]));
  if (!parsed.success) {
    return Response.json({ success: false, error: { code: "INVALID_INPUT", message: issues(parsed.error) } }, { status: 400 });
  }
  return Response.json({ success: true, data: await managementService.usageSummary(parsed.data) });
}
