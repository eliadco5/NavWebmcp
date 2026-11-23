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
import { flushCurrentSharedState } from "@/lib/shared-state";
import { inputObject, outputObject, inlineSchema } from "@/lib/schema";
// Installs the UI relay the ui_* ops reach through lib/ui-relay/port.ts.
import "@/lib/ui-relay/store";
import type { Role } from "@/lib/auth";
import type { Operation } from "@/lib/operations/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOp = Operation<any, any>;

export function mcpAnnotations(op: AnyOp) {
  return {
    title: op.title,
    readOnlyHint: op.permission === "read" && !op.dispatchesOps,
    destructiveHint: op.requiresConfirmation === true || op.dispatchesOps === true,
  };
}

/** Every failure, whatever its origin, goes out as the same `{code, message}` shape. */
function errorResult(error: { code: string; message: string }) {
  return { content: [{ type: "text" as const, text: JSON.stringify(error, null, 2) }], isError: true };
}

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

    server.registerTool(
      op.name,
      {
        title: op.title,
        description: op.description,
        // Strict object, so the SDK's own input validation rejects unknown keys too.
        inputSchema: inlineSchema(inputObject(op.inputSchema as Record<string, z.ZodTypeAny>)),
        // The SDK requires structuredContent matching this on every non-error result.
        outputSchema: inlineSchema(outputObject(op.outputSchema as Record<string, z.ZodTypeAny>)),
        annotations: mcpAnnotations(op),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (input: Record<string, unknown>, extra: any) => {
        // mcp-handler's Streamable HTTP transport resolves the route's own
        // Response before this callback finishes running (the body is a
        // stream, and the tool call executes as part of writing to it) — so
        // withSharedState's wrapper-level flush (app/api/[transport]/route.ts)
        // can fire before the mutation below happens. flushCurrentSharedState()
        // here flushes at the moment completion is actually known, using the
        // AsyncLocalStorage baseline that survives this same async boundary
        // (mcpContext, right below, already relies on the same guarantee).
        try {
          const userId: string | undefined = extra?.authInfo?.extra?.userId;
          const role: Role | undefined = extra?.authInfo?.extra?.role;

          if (!userId || !role) {
            const err = fail("UNAUTHENTICATED", "A valid user token is required.");
            auditLog.record(op.name, input, false, "agent", err.error);
            return errorResult(err.error);
          }

          // Defense-in-depth: re-check role on every call
          if (!roleSatisfies(role, op.roles)) {
            const err = fail("FORBIDDEN", `Role '${role}' is not permitted to call '${op.name}'.`);
            auditLog.record(op.name, input, false, "agent", err.error);
            return errorResult(err.error);
          }

          try {
            const bearerToken: string = extra?.authInfo?.token ?? "";
            const result = await op.handler(input, { userId, role, token: bearerToken });
            auditLog.record(op.name, input, result.success, "agent", result.success ? result.data : result.error);
            if (!result.success) return errorResult(result.error);
            // The text block is kept for clients that predate structuredContent
            // (and for scripts/bench.mjs, which parses content[0].text).
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
              structuredContent: result.data as Record<string, unknown>,
            };
          } catch (err) {
            const error = { code: "HANDLER_ERROR", message: String(err) };
            auditLog.record(op.name, input, false, "agent", error);
            return errorResult(error);
          }
        } finally {
          await flushCurrentSharedState();
        }
      }
    );
  }
}
