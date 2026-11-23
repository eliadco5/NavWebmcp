import { cookies } from "next/headers";
import { authenticateSession } from "@/lib/management/auth";
import { readAuditEntries } from "@/lib/shared-state";
import { scopeFeed } from "@/lib/auditlog";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const { user } = await authenticateSession(cookieStore);
  if (!user) {
    return Response.json(
      { success: false, error: { code: "UNAUTHENTICATED", message: "Login required." } },
      { status: 401 }
    );
  }
  // Deliberately bypasses withSharedState/the state lock — this route is polled
  // every 4s per open tab (app/providers.tsx), so it must not contend with
  // writers or restore() over a concurrent write. See readAuditEntries().
  // Scoped: non-admins see only their own calls in full (lib/auditlog.ts).
  return Response.json(scopeFeed(await readAuditEntries(), user));
}
