import { cookies } from "next/headers";
import { z } from "zod";
import { getOrProvisionUser } from "@/lib/auth-tokens";
import { TabRef } from "@/lib/ui-components/contract";
import { claimCommands, putResult } from "@/lib/ui-relay/store";

export const dynamic = "force-dynamic";

// One round trip per page poll (lib/ui-relay/client.ts): the page hands back
// the results of the commands it just applied and picks up any new ones.
// Results are stored under the session's own userId, so a page can only answer
// commands addressed to its own user.

const ResultSchema = z.union([
  z.object({ success: z.literal(true), data: z.unknown() }),
  z.object({ success: z.literal(false), error: z.object({ code: z.string().max(64), message: z.string().max(2000) }) }),
]);

const Body = z.object({
  tabId: TabRef(),
  results: z.array(z.object({ cmdId: z.string().max(64), result: ResultSchema })).max(50).default([]),
});

export async function POST(req: Request) {
  const { user } = getOrProvisionUser(await cookies());
  if (!user) {
    return Response.json({ success: false, error: { code: "UNAUTHENTICATED", message: "Login required." } }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) {
    return Response.json({ success: false, error: { code: "INVALID_INPUT", message: parsed.error.issues.map((i) => i.message).join("; ") } }, { status: 400 });
  }

  const { tabId, results } = parsed.data;
  for (const { cmdId, result } of results) {
    await putResult(user.id, cmdId, result as Parameters<typeof putResult>[2]);
  }
  const commands = await claimCommands(user.id, tabId);
  return Response.json({ success: true, data: { commands } });
}
