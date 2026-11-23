import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { issueToken, newClientId } from "@/lib/auth-tokens";
import { authenticateSession, requestInfo, revokeClient } from "@/lib/management/auth";
import { getClient, listClients, recordClient } from "@/lib/management/sessions";
import { auditAuth, humanActor } from "@/lib/audit";

// Self-service agent connections for the signed-in user:
//   GET    → the caller's own agent clients, with last-seen / revoked state
//   POST   { label } → mint a token for a NEW, separately-revocable agent client
//   DELETE { clientId } → revoke one of the caller's own clients
// Admin-wide views and revocation of anyone's clients belong to the
// management APIs, not here.
export const dynamic = "force-dynamic";

function unauthenticated() {
  return Response.json(
    { success: false, error: { code: "UNAUTHENTICATED", message: "Login required." } },
    { status: 401 }
  );
}

export async function GET(req: NextRequest) {
  const { user } = await authenticateSession(await cookies(), requestInfo(req.headers));
  if (!user) return unauthenticated();
  return Response.json({ success: true, clients: await listClients({ userId: user.id }) });
}

const CreateBody = z.object({ label: z.string().trim().min(1).max(60) });

export async function POST(req: NextRequest) {
  const { user, sid } = await authenticateSession(await cookies(), requestInfo(req.headers));
  if (!user) return unauthenticated();
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json(
      { success: false, error: { code: "INVALID_INPUT", message: "label must be 1-60 characters." } },
      { status: 400 }
    );
  }
  const clientId = newClientId();
  await recordClient({
    clientId,
    userId: user.id,
    role: user.role,
    kind: "connected",
    label: parsed.data.label,
    sid,
    createdAt: new Date().toISOString(),
  });
  await auditAuth({
    action: "auth.agent_client_created",
    outcome: "success",
    actor: humanActor(user, sid),
    ...requestInfo(req.headers),
    target: { type: "agentClient", id: clientId },
    detail: { label: parsed.data.label },
  });
  return Response.json({ success: true, clientId, agentToken: issueToken(user, { clientId, sid }) });
}

const RevokeBody = z.object({ clientId: z.string().min(1).max(100) });

export async function DELETE(req: NextRequest) {
  const { user, sid } = await authenticateSession(await cookies(), requestInfo(req.headers));
  if (!user) return unauthenticated();
  const parsed = RevokeBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json(
      { success: false, error: { code: "INVALID_INPUT", message: "clientId is required." } },
      { status: 400 }
    );
  }
  const client = await getClient(parsed.data.clientId);
  // Same answer for "doesn't exist" and "not yours", so ids can't be probed.
  if (!client || client.userId !== user.id) {
    return Response.json(
      { success: false, error: { code: "NOT_FOUND", message: "No such agent client." } },
      { status: 404 }
    );
  }
  await revokeClient(client.clientId, user.id);
  await auditAuth({
    action: "auth.agent_client_revoked",
    outcome: "success",
    actor: humanActor(user, sid),
    ...requestInfo(req.headers),
    target: { type: "agentClient", id: client.clientId },
  });
  return Response.json({ success: true });
}
