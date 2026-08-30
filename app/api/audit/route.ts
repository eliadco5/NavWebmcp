import { cookies } from "next/headers";
import { auditLog } from "@/lib/auditlog";
import { getOrProvisionUser } from "@/lib/auth-tokens";

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
  return Response.json(auditLog.getEntries());
}
