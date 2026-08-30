import { cookies } from "next/headers";
import { getOrProvisionUser } from "@/lib/auth-tokens";
import { readAuditEntries } from "@/lib/shared-state";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const { user } = getOrProvisionUser(cookieStore);
  if (!user) {
    return Response.json(
      { success: false, error: { code: "UNAUTHENTICATED", message: "Login required." } },
      { status: 401 }
    );
  }
  // Deliberately bypasses withSharedState/the state lock — this route is polled
  // every 4s per open tab (app/providers.tsx), so it must not contend with
  // writers or restore() over a concurrent write. See readAuditEntries().
  return Response.json(await readAuditEntries());
}
