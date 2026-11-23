import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { verifyCredentials, SESSION_COOKIE } from "@/lib/auth";
import { createSession, issueToken, newSessionId, COOKIE_OPTS } from "@/lib/auth-tokens";
import { requestInfo, startSession } from "@/lib/management/auth";
import { auditAuth, humanActor } from "@/lib/audit";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  const user = verifyCredentials(String(username ?? ""), String(password ?? ""));
  const info = requestInfo(req.headers);
  if (!user) {
    // Failed sign-ins are what brute-force monitoring looks for (SOC2 CC7.2).
    await auditAuth({
      action: "auth.login",
      outcome: "denied",
      errorCode: "INVALID_CREDENTIALS",
      actor: { type: "human", userId: "anonymous", role: "customer", assurance: "asserted" },
      ...info,
      detail: { username: String(username ?? "").slice(0, 64) },
    });
    return Response.json(
      { success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid username or password." } },
      { status: 401 }
    );
  }

  // Each sign-in is its own session: monitored, and revocable on its own.
  const sid = newSessionId();
  await startSession(sid, user, info);
  const agentToken = issueToken(user, { sid });
  await auditAuth({
    action: "auth.login",
    outcome: "success",
    actor: humanActor(user, sid),
    ...info,
    target: { type: "session", id: sid },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, createSession(user, sid), COOKIE_OPTS);

  return Response.json({
    success: true,
    user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
    agentToken,
  });
}
