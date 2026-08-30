import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";

// Sessions are stateless (HMAC-signed, not looked up), so there's nothing to
// invalidate server-side — deleting the cookie IS the logout.
export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  return Response.json({ success: true });
}
