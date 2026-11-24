import { readTextCapped } from "@/lib/http-limits";
import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import "@/lib/operations"; // populates the registry
import { getOpByName, requestMeta } from "@/lib/operations/execute";
import { roleSatisfies } from "@/lib/auth";
import { auditLog } from "@/lib/auditlog";
import { auditOperation } from "@/lib/audit";
import { observeCall } from "@/lib/telemetry";
import { authenticateSession, requestInfo } from "@/lib/management/auth";

// The in-page agent's ui_* writes run entirely in the browser (they act on the
// page's own components), so the server can't observe them. The page reports
// them here and they're recorded with reportedBy: "client" — the content is
// the browser's word, the WHO comes from the verified session cookie.
//
// Only operations that actually run in the page are accepted, so this can't
// be used to plant records of operations that would have gone through the
// server and been observed there.
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

const Body = z.object({
  operation: z.string().max(64),
  input: z.record(z.string(), z.unknown()).default({}),
  success: z.boolean(),
  errorCode: z.string().max(64).optional(),
});

export async function POST(req: NextRequest) {
  const { user, sid } = await authenticateSession(await cookies(), requestInfo(req.headers));
  if (!user) {
    return Response.json({ success: false, error: { code: "UNAUTHENTICATED", message: "Login required." } }, { status: 401 });
  }
  const text = await readTextCapped(req, MAX_BODY_BYTES);
  if (text instanceof Response) return text;
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ success: false, error: { code: "INVALID_INPUT", message: "Report too large." } }, { status: 413 });
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return Response.json({ success: false, error: { code: "INVALID_INPUT", message: "Malformed report." } }, { status: 400 });
  }
  const op = getOpByName().get(parsed.data.operation);
  if (!op?.runsInPage || !roleSatisfies(user.role, op.roles)) {
    return Response.json({ success: false, error: { code: "INVALID_INPUT", message: "Not an in-page operation." } }, { status: 400 });
  }

  const meta = { ...requestMeta("webmcp", req.headers), callId: crypto.randomUUID() };
  const call = {
    operation: op.name,
    input: parsed.data.input,
    success: parsed.data.success,
    errorCode: parsed.data.success ? undefined : parsed.data.errorCode ?? "UNKNOWN",
    actor: {
      type: "agent" as const,
      userId: user.id,
      role: user.role,
      assurance: "asserted" as const,
      sessionId: sid,
      agent: { clientId: `webmcp-${sid}`, sessionId: sid },
    },
    meta,
  };
  auditLog.recordCall(call);
  await Promise.all([
    auditOperation({ ...call, op, reportedBy: "client" }),
    // Ran in the browser, so its real duration isn't known here.
    observeCall({ ...call, permission: op.permission, durationMs: 0, startedAt: Date.now() }),
  ]);
  return Response.json({ success: true, data: {} });
}
