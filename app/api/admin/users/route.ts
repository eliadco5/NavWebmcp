import { listUsers } from "@/lib/auth";
import { requireAdmin, isResponse } from "@/lib/management/guard";

// Read-only roster. Role changes now happen via /api/switch-role (client-side,
// cookie-scoped) rather than a PATCH here — updateUserRole used to mutate a
// module-level USERS constant in place, which cannot work across serverless
// instances and is gone from lib/auth.ts along with this route's old PATCH handler.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const admin = await requireAdmin(req, "admin.users_list");
  if (isResponse(admin)) return admin;
  return Response.json({ success: true, users: listUsers() });
}
