import { NextRequest } from "next/server";
import { z } from "zod";
import { managementService } from "@/lib/management/service";
import { requireAdmin, isResponse } from "@/lib/management/guard";
import { readJsonCapped } from "@/lib/http-limits";

export const dynamic = "force-dynamic";

// GET  /api/admin/credits[?kind=agent|human] — every caller's credit ledger (lib/credits)
// POST /api/admin/credits { kind, id, maxWindow?, refillPerSec?, frozen?, reset? } — override one caller
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req, "admin.credits_list");
  if (isResponse(admin)) return admin;
  const k = req.nextUrl.searchParams.get("kind");
  const kind = k === "agent" || k === "human" ? k : undefined;
  return Response.json({ success: true, data: { ledgers: await managementService.listCreditLedgers({ kind }) } });
}

const Change = z.object({
  kind: z.enum(["agent", "human"]),
  id: z.string().min(1).max(100),
  maxWindow: z.number().int().min(1).max(4096).optional(),
  refillPerSec: z.number().min(0).max(1000).optional(),
  frozen: z.boolean().optional(),
  reset: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req, "admin.credit_policy_set");
  if (isResponse(admin)) return admin;
  const body = await readJsonCapped(req);
  if (body instanceof Response) return body;
  const parsed = Change.safeParse(body ?? {});
  if (!parsed.success) {
    return Response.json({ success: false, error: { code: "INVALID_INPUT", message: parsed.error.issues.map((i) => i.message).join("; ") } }, { status: 400 });
  }
  const { kind, id, ...change } = parsed.data;
  const override = await managementService.setCreditPolicy({ kind, id }, change, admin.actor, admin.info);
  return Response.json({ success: true, data: { override } });
}
