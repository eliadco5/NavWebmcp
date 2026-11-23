import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import "@/lib/operations"; // populates the registry
import { executeDetailed, requestMeta, SURFACE_CODES } from "@/lib/operations/execute";
import type { ExecuteStage } from "@/lib/operations/execute";
import { authenticateSession, requestInfo } from "@/lib/management/auth";
import { withSharedState } from "@/lib/shared-state";
// Installs the UI relay for ui_* ops reached through invoke (lib/ui-relay/port.ts).
import "@/lib/ui-relay/store";
// Turns on the SOC2 audit trail for every call execute() runs (lib/audit/port.ts).
import "@/lib/audit";
// ...and usage metrics / OpenTelemetry export (lib/telemetry/port.ts).
import "@/lib/telemetry";
// ...and the management service behind the admin.* operations (lib/management/port.ts).
import "@/lib/management/service";
import type { Actor } from "@/lib/operations/types";
import { AGENT_HEADER, CHANNEL_HEADER } from "@/lib/constants";

export const dynamic = "force-dynamic";


const STATUS: Partial<Record<ExecuteStage, number>> = { lookup: 404, rbac: 403 };

export const POST = withSharedState(async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const { user, sid } = await authenticateSession(cookieStore, requestInfo(req.headers));
  if (!user) {
    return Response.json(
      { success: false, error: { code: "UNAUTHENTICATED", message: "Login required." } },
      { status: 401 }
    );
  }

  const { name, params } = await req.json();

  const isAgent = req.headers.get(CHANNEL_HEADER) === "webmcp";
  // Client-supplied: cap it so it can't bloat audit entries.
  const agentName = req.headers.get(AGENT_HEADER)?.slice(0, 100) || undefined;
  const actor: Actor = isAgent
    ? {
        type: "agent",
        userId: user.id,
        role: user.role,
        assurance: "asserted",
        sessionId: sid,
        // One in-page agent per browser session.
        agent: { clientId: `webmcp-${sid}`, name: agentName, sessionId: sid },
      }
    : { type: "human", userId: user.id, role: user.role, assurance: "asserted", sessionId: sid };

  const { result, stage } = await executeDetailed(
    name,
    params ?? {},
    { userId: user.id, role: user.role, token: "", actor, meta: requestMeta(isAgent ? "webmcp" : "ui", req.headers) },
    { codes: SURFACE_CODES }
  );

  // Only gate failures change the HTTP status, as before; a handler's own
  // NOT_FOUND (e.g. unknown reservation id) is a normal 200 Result.
  return Response.json(result, { status: STATUS[stage] ?? 200 });
});
