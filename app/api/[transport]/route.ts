import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { registerMcpTools, withMcpAuthRole } from "@/lib/adapters/mcp";
import { userForToken, scopesForRole, MCP_RESOURCE } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { PROTOCOL_VERSION } from "@/lib/protocol";
import { AGENT_INSTRUCTIONS } from "@/lib/agent-instructions";

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

const mcpHandlerWithRole = withMcpAuthRole(mcpHandler, getRole, getToken);

const handler = withMcpAuth(mcpHandlerWithRole, verifyToken, {
  required: true,
  resourceUrl: MCP_RESOURCE,
});

export { handler as GET, handler as POST, handler as DELETE };
