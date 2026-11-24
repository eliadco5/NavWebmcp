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
// ...and credit metering for every top-level call (lib/credits/port.ts).
import "@/lib/credits";
import type { Actor } from "@/lib/operations/types";
import type { CreditInfo } from "@/lib/result";
import { AGENT_HEADER, CHANNEL_HEADER, CREDIT_HEADERS } from "@/lib/constants";
import { readJsonCapped } from "@/lib/http-limits";

export const dynamic = "force-dynamic";


const STATUS: Partial<Record<ExecuteStage, number>> = { lookup: 404, rbac: 403, credits: 429 };

/** NavWebMcp credits over HTTP (docs/credits.md): always as headers; in the
 *  body only when the Result carries a hint. */
function creditHeaders(c: CreditInfo | undefined): Record<string, string> {
  if (!c) return {};
  const h: Record<string, string> = {
    [CREDIT_HEADERS.balance]: String(c.balance),
    [CREDIT_HEADERS.window]: String(c.window),
    [CREDIT_HEADERS.charged]: String(c.charged),
    [CREDIT_HEADERS.granted]: String(c.granted),
  };
  if (c.retryAfterMs !== undefined) h["Retry-After"] = String(Math.max(1, Math.ceil(c.retryAfterMs / 1000)));
  return h;
}

export const POST = withSharedState(async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const { user, sid } = await authenticateSession(cookieStore, requestInfo(req.headers));
  if (!user) {
    return Response.json(
      { success: false, error: { code: "UNAUTHENTICATED", message: "Login required." } },
      { status: 401 }
    );
  }

  const body = await readJsonCapped(req);
  if (body instanceof Response) return body;
  const { name, params } = (body ?? {}) as { name?: unknown; params?: unknown };

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

  const requested = Number(req.headers.get(CREDIT_HEADERS.request));
  const meta = {
    ...requestMeta(isAgent ? "webmcp" : "ui", req.headers),
    ...(req.headers.has(CREDIT_HEADERS.request) && Number.isFinite(requested) && requested >= 0 && { creditRequest: Math.min(requested, 1024) }),
  };

  const { result, stage, credits } = await executeDetailed(
    typeof name === "string" ? name : "",
    params && typeof params === "object" ? (params as Record<string, unknown>) : {},
    { userId: user.id, role: user.role, token: "", actor, meta },
    { codes: SURFACE_CODES }
  );

  // Only gate failures change the HTTP status, as before; a handler's own
  // NOT_FOUND (e.g. unknown reservation id) is a normal 200 Result.
  return Response.json(result, { status: STATUS[stage] ?? 200, headers: creditHeaders(credits) });
});
