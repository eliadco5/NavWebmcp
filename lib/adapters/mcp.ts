import { AsyncLocalStorage } from "async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
// Import from the index, not "./registry" directly — the index is what runs
// registry.push(...) as a side effect. Importing the bare module here would read
// an empty array unless some unrelated route happened to import the index first
// in the same process (and never, once each route bundles independently).
import { registry } from "@/lib/operations";
import { auditLog } from "@/lib/auditlog";
import { fail } from "@/lib/result";
import { roleSatisfies } from "@/lib/auth";
import { getLoaded } from "@/lib/loadedTools";
import type { Role } from "@/lib/auth";

interface McpContext {
  role: Role;
  token: string;
}

// Per-request ALS holding the caller's role and bearer token.
// Populated by withMcpAuthRole() before the MCP handler runs.
const mcpContext = new AsyncLocalStorage<McpContext>();

export function getMcpContext(): McpContext | undefined {
  return mcpContext.getStore();
}

// Back-compat: callers that only need role
export function getRoleContext(): Role | undefined {
  return mcpContext.getStore()?.role;
}

/** Wrap an existing MCP handler so role + token are available in mcpContext. */
export function withMcpAuthRole(
  handler: (req: Request) => Promise<Response>,
  getRole: (req: Request) => Role | undefined,
  getToken: (req: Request) => string | undefined
): (req: Request) => Promise<Response> {
  return (req: Request) => {
    const role = getRole(req) ?? ("customer" as Role);
    const token = getToken(req) ?? "";
    return mcpContext.run({ role, token }, () => handler(req));
  };
}

export function registerMcpTools(server: McpServer) {
  const ctx = mcpContext.getStore();
  const callerRole: Role = ctx?.role ?? "customer";
  const token: string = ctx?.token ?? "";

  // Determine which non-alwaysOn ops are currently loaded for this token
  const loaded = getLoaded(token);

  for (const op of registry) {
    // Role gate (applies to all ops)
    if (!roleSatisfies(callerRole, op.roles)) continue;

    // Non-alwaysOn ops are only registered if explicitly loaded
    if (!op.alwaysOn && !loaded.has(op.name)) continue;

    const zodShape = op.inputSchema as Record<string, z.ZodTypeAny>;

    server.registerTool(
      op.name,
      {
        title: op.title,
        description: op.description,
        inputSchema: zodShape,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (input: Record<string, unknown>, extra: any) => {
        const userId: string | undefined = extra?.authInfo?.extra?.userId;
        const role: Role | undefined = extra?.authInfo?.extra?.role;

        if (!userId || !role) {
          const err = fail("UNAUTHENTICATED", "A valid user token is required.");
          auditLog.record(op.name, input, false, "agent", err.error);
          return { content: [{ type: "text" as const, text: JSON.stringify(err, null, 2) }], isError: true };
        }

        // Defense-in-depth: re-check role on every call
        if (!roleSatisfies(role, op.roles)) {
          const err = fail("FORBIDDEN", `Role '${role}' is not permitted to call '${op.name}'.`);
          auditLog.record(op.name, input, false, "agent", err.error);
          return { content: [{ type: "text" as const, text: JSON.stringify(err, null, 2) }], isError: true };
        }

        try {
          const bearerToken: string = extra?.authInfo?.token ?? "";
          const result = await op.handler(input, { userId, role, token: bearerToken });
          auditLog.record(op.name, input, result.success, "agent", result.success ? result.data : result.error);
          if (result.success) {
            return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
          } else {
            return { content: [{ type: "text" as const, text: JSON.stringify(result.error, null, 2) }], isError: true };
          }
        } catch (err) {
          auditLog.record(op.name, input, false, "agent", { code: "HANDLER_ERROR", message: String(err) });
          return { content: [{ type: "text" as const, text: String(err) }], isError: true };
        }
      }
    );
  }
}
