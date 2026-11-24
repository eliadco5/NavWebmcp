import { cookies } from "next/headers";
import { z } from "zod";
import { authenticateSession } from "@/lib/management/auth";
import { UiPageSnapshotSchema, TabRef } from "@/lib/ui-components/contract";
import { putSnapshot, removeSnapshot } from "@/lib/ui-relay/store";
import { readTextCapped } from "@/lib/http-limits";

export const dynamic = "force-dynamic";

// The page publishes which agent-operable components it has mounted, and their
// state (lib/ui-relay/client.ts). Read back by the server-side ui_list /
// ui_get_state and used to route ui_set_state / ui_action to a live tab.

const MAX_BODY_BYTES = 256 * 1024;

const Body = z.union([
  UiPageSnapshotSchema,
  z.object({ tabId: TabRef(), closed: z.literal(true) }),
]);

export async function POST(req: Request) {
  const { user } = await authenticateSession(await cookies());
  if (!user) {
    return Response.json({ success: false, error: { code: "UNAUTHENTICATED", message: "Login required." } }, { status: 401 });
  }

  // navigator.sendBeacon (tab closing) posts text/plain, so parse the raw text.
  // Stops reading at the cap instead of buffering the whole body first.
  const text = await readTextCapped(req, MAX_BODY_BYTES);
  if (text instanceof Response) return text;
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return Response.json({ success: false, error: { code: "INVALID_INPUT", message: parsed.error.issues.map((i) => i.message).join("; ") } }, { status: 400 });
  }

  if ("closed" in parsed.data) await removeSnapshot(user.id, parsed.data.tabId);
  else await putSnapshot(user.id, parsed.data);
  return Response.json({ success: true, data: {} });
}
