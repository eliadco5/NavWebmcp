import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { registerMcpTools, withMcpAuthRole } from "@/lib/adapters/mcp";
import { scopesForRole } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { userForToken } from "@/lib/auth-tokens";
import { PROTOCOL_VERSION } from "@/lib/protocol";
import { AGENT_INSTRUCTIONS } from "@/lib/agent-instructions";
import { withSharedState } from "@/lib/shared-state";

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

async function verifyToken(_req: Request, bearer?: string): Promise<AuthInfo | undefined> {
  if (!bearer) return undefined;
  const user = userForToken(bearer);
  if (!user) return undefined;
  return {
    token: bearer,
    clientId: user.id,
    scopes: scopesForRole(user.role),
    extra: { userId: user.id, role: user.role },
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
const mcpHandlerWithRole = withMcpAuthRole(withSharedState(mcpHandler), getRole, getToken);

// No resourceUrl here: mcp-handler builds the metadata URL as `${resourceUrl}${path}`,
// so passing the full MCP_RESOURCE (".../api/mcp") produces a malformed
// ".../api/mcp/.well-known/oauth-protected-resource". Omitting it lets mcp-handler
// derive the origin from Vercel's own x-forwarded-host/x-forwarded-proto headers,
// which is correct with zero config on every deployment (preview or production).
const handler = withMcpAuth(mcpHandlerWithRole, verifyToken, {
  required: true,
});

export { handler as GET, handler as POST, handler as DELETE };
