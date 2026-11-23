import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { verifyCredentials, SESSION_COOKIE } from "@/lib/auth";
import { createSession, issueToken, newSessionId, COOKIE_OPTS } from "@/lib/auth-tokens";
import { requestInfo, startSession } from "@/lib/management/auth";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  const user = verifyCredentials(String(username ?? ""), String(password ?? ""));
  if (!user) {
    return Response.json(
      { success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid username or password." } },
      { status: 401 }
    );
  }

  // Each sign-in is its own session: monitored, and revocable on its own.
  const sid = newSessionId();
  await startSession(sid, user, requestInfo(req.headers));
  const agentToken = issueToken(user, { sid });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, createSession(user, sid), COOKIE_OPTS);

  return Response.json({
    success: true,
    user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
    agentToken,
  });
}
