import { NextRequest } from "next/server";
import { z } from "zod";
import { managementService } from "@/lib/management/service";
import { requireAdmin, isResponse } from "@/lib/management/guard";

export const dynamic = "force-dynamic";

// GET    /api/admin/clients[?userId=]   — every user's agent clients (connected agents)
// DELETE /api/admin/clients { clientId } — revoke: its token is rejected from the next call
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req, "admin.clients_list");
  if (isResponse(admin)) return admin;
  const userId = req.nextUrl.searchParams.get("userId") ?? undefined;
  return Response.json({ success: true, data: { clients: await managementService.listClients({ userId }) } });
}

const Revoke = z.object({ clientId: z.string().min(1).max(100) });

export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req, "admin.agent_client_revoked");
  if (isResponse(admin)) return admin;
  const parsed = Revoke.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ success: false, error: { code: "INVALID_INPUT", message: "clientId is required." } }, { status: 400 });
  }
  const r = await managementService.revokeClient(parsed.data.clientId, admin.actor, admin.info);
  if (!r.found) return Response.json({ success: false, error: { code: "NOT_FOUND", message: "No such agent client." } }, { status: 404 });
  return Response.json({ success: true, data: r });
}
