import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { verifyCredentials, SESSION_COOKIE } from "@/lib/auth";
import { createSession, issueToken, COOKIE_OPTS } from "@/lib/auth-tokens";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  const user = verifyCredentials(String(username ?? ""), String(password ?? ""));
  if (!user) {
    return Response.json(
      { success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid username or password." } },
      { status: 401 }
    );
  }

  const sessionId = createSession(user);
  const agentToken = issueToken(user);

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, sessionId, COOKIE_OPTS);

  return Response.json({
    success: true,
    user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
    agentToken,
  });
}
