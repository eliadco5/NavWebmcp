import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { authenticateSession } from "@/lib/management/auth";
import { isKnownIntroKey } from "@/lib/feature-intros/registry";
import { getSeen, markSeen, resetSeen } from "@/lib/feature-intros/seen-store";

// Which feature intros the signed-in user has finished or skipped. UI-only state:
// not an operation, so it's not in lib/operations, not exposed to agents, and
// doesn't move capabilityHash or PROTOCOL_VERSION.
export const dynamic = "force-dynamic";

const unauthenticated = () =>
  Response.json(
    { success: false, error: { code: "UNAUTHENTICATED", message: "Not logged in." } },
    { status: 401 }
  );

async function currentUser() {
  return (await authenticateSession(await cookies())).user;
}

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthenticated();
  return Response.json({ success: true, seen: await getSeen(user.id) });
}

const Body = z.object({ key: z.string().refine(isKnownIntroKey, "Unknown intro key.") });

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json(
      { success: false, error: { code: "INVALID_INPUT", message: "key must be a registered intro key (id@version)." } },
      { status: 400 }
    );
  }
  await markSeen(user.id, parsed.data.key);
  return Response.json({ success: true });
}

export async function DELETE() {
  const user = await currentUser();
  if (!user) return unauthenticated();
  await resetSeen(user.id);
  return Response.json({ success: true });
}
