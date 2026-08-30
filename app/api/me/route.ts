import { cookies } from "next/headers";
import { getOrProvisionUser, issueToken } from "@/lib/auth-tokens";

// No auth failure path here anymore: getOrProvisionUser mints an alice/customer
// session on the spot if the caller has none. That's the fix for the login loop —
// this route used to 401 whenever the session cookie wasn't recognised by *this*
// serverless instance, which sent the client back to /login in an endless cycle.
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
