import { cookies } from "next/headers";
import { getOrProvisionUser, issueToken } from "@/lib/auth-tokens";

// 401 when there's no valid session (the client then goes to /login). In demo
// mode getOrProvisionUser mints an alice/customer session instead. Sessions are
// stateless HMAC-signed cookies, so a cookie minted on one serverless instance
// verifies on every other — the old cross-instance /login loop can't recur.
export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const { user } = getOrProvisionUser(cookieStore);
  if (!user) {
    return Response.json(
      { success: false, error: { code: "UNAUTHENTICATED", message: "Not logged in." } },
      { status: 401 }
    );
  }
  const agentToken = issueToken(user);
  return Response.json({
    success: true,
    user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
    agentToken,
  });
}
