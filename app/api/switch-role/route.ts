import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { SESSION_COOKIE } from "@/lib/auth";
import { getOrProvisionUser, createSession, issueToken, COOKIE_OPTS } from "@/lib/auth-tokens";

// Deliberately unauthenticated privilege escalation. This exists solely so a judge
// evaluating the demo can reach every role in one tap with no credentials to type
// or remember. Re-mints the cookie with the SAME userId and a new role — not a
// re-login as carol/bob, because that would swap userId and every reservation the
// judge just made (filtered by userId) would appear to vanish.
//
// Set DEMO_MODE=false to disable this in any deployment that isn't a public demo.
export const dynamic = "force-dynamic";

const Body = z.object({ role: z.enum(["customer", "support", "admin"]) });

export async function POST(req: NextRequest) {
  if (process.env.DEMO_MODE === "false") {
    return Response.json(
      { success: false, error: { code: "FORBIDDEN", message: "Role switching is disabled." } },
      { status: 403 }
    );
  }

  const cookieStore = await cookies();
  const { user } = getOrProvisionUser(cookieStore);

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!user || !parsed.success) {
    return Response.json(
      { success: false, error: { code: "INVALID_INPUT", message: "role must be customer, support, or admin." } },
      { status: 400 }
    );
  }

  const switched = { ...user, role: parsed.data.role };
  cookieStore.set(SESSION_COOKIE, createSession(switched), COOKIE_OPTS);

  return Response.json({
    success: true,
    user: { id: switched.id, username: switched.username, displayName: switched.displayName, role: switched.role },
    agentToken: issueToken(switched),
  });
}
