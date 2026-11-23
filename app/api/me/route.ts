import { cookies } from "next/headers";
import { issueToken } from "@/lib/auth-tokens";
import { authenticateSession, requestInfo } from "@/lib/management/auth";

// 401 when there's no valid session (the client then goes to /login). In demo
// mode a visitor with none gets an alice/customer session instead. Sessions are
// stateless HMAC-signed cookies, so a cookie minted on one serverless instance
// verifies on every other — the old cross-instance /login loop can't recur.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateSession(await cookies(), requestInfo(req?.headers));
  if (!auth.user) {
    return Response.json(
      { success: false, error: { code: "UNAUTHENTICATED", message: "Not logged in." } },
      { status: 401 }
    );
  }
  const { user, sid } = auth;
  // The session's default agent client: stable for this session + role.
  const agentToken = issueToken(user, { sid });
  return Response.json({
    success: true,
    user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
    agentToken,
  });
}
