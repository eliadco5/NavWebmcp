import { cookies } from "next/headers";
import { listUsers } from "@/lib/auth";
import { getOrProvisionUser } from "@/lib/auth-tokens";

// Read-only roster. Role changes now happen via /api/switch-role (client-side,
// cookie-scoped) rather than a PATCH here — updateUserRole used to mutate a
// module-level USERS constant in place, which cannot work across serverless
// instances and is gone from lib/auth.ts along with this route's old PATCH handler.
export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const { user: caller } = getOrProvisionUser(cookieStore);
  if (!caller) return Response.json({ success: false, error: { code: "UNAUTHENTICATED" } }, { status: 401 });
  if (caller.role !== "admin") return Response.json({ success: false, error: { code: "FORBIDDEN" } }, { status: 403 });

  return Response.json({ success: true, users: listUsers() });
}
