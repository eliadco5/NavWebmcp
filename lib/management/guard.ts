// The one access check for /api/admin/*. Today it's "role is admin"; the
// planned fine-grained authorization (docs/authorization-implementation-guide.md,
// can("manageAccess")) replaces the single `isAllowed` line below.
//
// Denials are audited: someone probing admin endpoints is exactly what an
// auditor wants to see (SOC2 CC6.1 / CC7.2).
import { cookies } from "next/headers";
import type { User } from "@/lib/auth";
import { auditAdmin, humanActor } from "@/lib/audit";
import type { Actor } from "@/lib/operations/types";
import { authenticateSession, requestInfo, type RequestInfo } from "./auth";

export interface AdminContext {
  user: User;
  sid: string;
  actor: Actor;
  info: RequestInfo;
}

function deny(status: 401 | 403, code: string, message: string): Response {
  return Response.json({ success: false, error: { code, message } }, { status });
}

/** Either the admin's context, or the Response to send back. */
export async function requireAdmin(req: Request, action: string): Promise<AdminContext | Response> {
  const info = requestInfo(req.headers);
  const auth = await authenticateSession(await cookies(), info);
  if (!auth.user) return deny(401, "UNAUTHENTICATED", "Login required.");

  const actor = humanActor(auth.user, auth.sid);
  const isAllowed = auth.user.role === "admin";
  if (!isAllowed) {
    await auditAdmin({ action, outcome: "denied", errorCode: "FORBIDDEN", actor, ...info });
    return deny(403, "FORBIDDEN", "Admin access required.");
  }
  return { user: auth.user, sid: auth.sid, actor, info };
}

export function isResponse(x: unknown): x is Response {
  return x instanceof Response;
}
