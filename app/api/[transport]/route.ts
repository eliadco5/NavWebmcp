import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { formatFromRequest, formatText, registerMcpTools, withMcpAuthRole } from "@/lib/adapters/mcp";
import { scopesForRole } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { authenticateAgentToken, requestInfo } from "@/lib/management/auth";
import { PROTOCOL_VERSION } from "@/lib/protocol";
import { AGENT_INSTRUCTIONS } from "@/lib/agent-instructions";
import { withSharedState } from "@/lib/shared-state";
import { declaredTooLarge, readTextCapped } from "@/lib/http-limits";
import { gateHint, withResponseGate } from "@/lib/credits/gate";
import { quickRefusal } from "@/lib/credits";
import { fail } from "@/lib/result";

// mcp-handler needs the Node runtime (lib/adapters/mcp.ts uses AsyncLocalStorage
// from async_hooks) — don't let this get inferred to edge.
export const runtime = "nodejs";
// Vercel's own function timeout. NOT the same as the `maxDuration` in the 3rd
// config object below, which is mcp-handler's internal SSE poll timer.
export const maxDuration = 60;

const mcpHandler = createMcpHandler(
  (server) => {
    registerMcpTools(server);
  },
  {
    serverInfo: {
      name: "agentbridge-booking",
      version: PROTOCOL_VERSION,
    },
    instructions: AGENT_INSTRUCTIONS,
  },
  {
    basePath: "/api",
    maxDuration: 60,
    // Passing this config object at all replaces mcp-handler's own default
    // (which would fall back to REDIS_URL/KV_URL and disableSse:false) — so
    // without this flag, GET /api/sse throws "redisUrl is required" (500).
    // Streamable HTTP (POST /api/mcp) doesn't use Redis and is unaffected.
    disableSse: true,
  }
);

// Rejects expired/forged tokens AND revoked agent clients (or tokens whose
// authorising session an admin revoked) — see lib/management/auth.ts.
async function verifyToken(req: Request, bearer?: string): Promise<AuthInfo | undefined> {
  if (!bearer) return undefined;
  const claims = await authenticateAgentToken(bearer, requestInfo(req.headers));
  if (!claims) return undefined;
  const { user } = claims;
  return {
    token: bearer,
    clientId: claims.clientId,
    scopes: scopesForRole(user.role),
    extra: { userId: user.id, role: user.role, sid: claims.sid },
  };
}

// Correct wrapping order:
// 1. withMcpAuthRole wraps mcpHandler — reads req.auth (set by step 2 before this is called)
// 2. withMcpAuth wraps mcpHandlerWithRole — sets req.auth FIRST, then calls the inner handler
// This guarantees req.auth.extra.role is available when roleContext.run() is called.
function getRole(req: Request): Role | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req as any).auth?.extra?.role as Role | undefined;
}

function getToken(req: Request): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req as any).auth?.token as string | undefined;
}

// withSharedState wraps mcpHandler specifically (not withMcpAuthRole as a
// whole): mcpHandler is what runs registerMcpTools (which reads getLoaded(token)
// — needs Redis-backed state hydrated first) and op.handler (which writes it) —
// see lib/adapters/mcp.ts. createMcpHandler awaits its initializer before
// touching the transport, so hydrate-before/flush-after here brackets the
// entire per-request lifecycle correctly with no change to lib/adapters/mcp.ts.
const lockedMcp = withSharedState(mcpHandler);

// Request gate (lib/credits/gate.ts): one agent client may only hold a few
// places on this instance at once, and a caller already out of credits is
// refused at the door — before the transport builds a server for the request,
// which is the expensive part. Both are answered in-band (a tool result with
// isError), so the model reads why instead of seeing a transport error.
async function gatedMcp(req: Request): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const auth = (req as any).auth as AuthInfo | undefined;
  const key = `a:${auth?.clientId ?? (auth?.extra?.userId as string | undefined) ?? "anonymous"}`;
  return withResponseGate(
    key,
    "agent",
    async () => {
      const messages = await bodyMessages(req);
      if (messages.some((m) => m.method === "tools/call")) {
        const refused = await quickRefusal(key, "agent");
        if (refused) return refusal(messages, refused.hint ?? "Out of credits; retry later.", refused.retryAfterMs, formatFromRequest(req));
      }
      return lockedMcp(req);
    },
    async (limit) => refusal(await bodyMessages(req), gateHint(limit), 1000, formatFromRequest(req))
  );
}

type RpcMessage = { id?: unknown; method?: unknown };

async function bodyMessages(req: Request): Promise<RpcMessage[]> {
  try {
    const parsed = JSON.parse(await req.clone().text());
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((m) => m && typeof m === "object");
  } catch {
    return [];
  }
}

function refusal(messages: RpcMessage[], message: string, retryAfterMs?: number, format: "pretty" | "compact" = "pretty"): Response {
  const answer = (msg: RpcMessage) => {
    if (msg.id === undefined || msg.id === null) return null; // a notification: nothing to answer
    if (msg.method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: formatText(fail("INSUFFICIENT_CREDITS", message).error, format) }],
          isError: true,
          _meta: { "navwebmcp/credits": { ...(retryAfterMs !== undefined && { retryAfterMs }), hint: message } },
        },
      };
    }
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } };
  };
  const out = messages.map(answer).filter(Boolean);
  if (out.length === 0) return new Response(null, { status: 202 });
  const retryS = String(Math.max(1, Math.ceil((retryAfterMs ?? 1000) / 1000)));
  return Response.json(out.length === 1 ? out[0] : out, { status: 200, headers: { "Retry-After": retryS } });
}

const mcpHandlerWithRole = withMcpAuthRole(gatedMcp, getRole, getToken);

// No resourceUrl here: mcp-handler builds the metadata URL as `${resourceUrl}${path}`,
// so passing the full MCP_RESOURCE (".../api/mcp") produces a malformed
// ".../api/mcp/.well-known/oauth-protected-resource". Omitting it lets mcp-handler
// derive the origin from Vercel's own x-forwarded-host/x-forwarded-proto headers,
// which is correct with zero config on every deployment (preview or production).
const authed = withMcpAuth(mcpHandlerWithRole, verifyToken, {
  required: true,
});

// Body cap before anything is parsed (lib/http-limits.ts). A declared
// Content-Length is checked for free; without one, a clone is read up to the
// cap — the original request goes on to the transport untouched.
//
// The body must also be valid JSON before it reaches the transport: a
// malformed body makes mcp-handler throw an unhandled rejection and never
// answer — and since that request holds the per-instance state lock
// (withSharedState above), every later request on the instance would wait
// behind it forever. One 10-byte request took the whole app down that way.
function parseError(): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the body must be valid JSON-RPC." } }, { status: 400 });
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "POST") {
    const declared = declaredTooLarge(req);
    if (declared) return declared;
    const probe = await readTextCapped(req.clone());
    if (probe instanceof Response) return probe;
    let parsed: unknown;
    try {
      parsed = JSON.parse(probe);
    } catch {
      return parseError();
    }
    // A JSON-RPC message is an object, or a batch: a non-empty array of objects.
    const isMsg = (m: unknown) => !!m && typeof m === "object" && !Array.isArray(m);
    if (!(isMsg(parsed) || (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isMsg)))) return parseError();
  }
  return authed(req);
}

export { handler as GET, handler as POST, handler as DELETE };
