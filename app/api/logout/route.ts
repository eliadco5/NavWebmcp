import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { sessionForCookie } from "@/lib/auth-tokens";
import { endSession, requestInfo } from "@/lib/management/auth";
import { auditAuth, humanActor } from "@/lib/audit";

// The cookie is stateless (HMAC-signed), so deleting it alone wouldn't stop a
// copy of it from working. The session is also ended server-side, which
// lib/management/auth.ts enforces on every later request. Agents the user
// connected keep working: logging out of the browser doesn't disconnect them
// (revoke them individually, or an admin can revoke the whole session).
export async function POST(req: Request) {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = raw ? sessionForCookie(raw) : null;
  if (session) {
    await endSession(session.sid, "logout", session.user.id);
    await auditAuth({
      action: "auth.logout",
      outcome: "success",
      actor: humanActor(session.user, session.sid),
      ...requestInfo(req?.headers),
      target: { type: "session", id: session.sid },
    });
  }
  cookieStore.delete(SESSION_COOKIE);
  return Response.json({ success: true });
}
