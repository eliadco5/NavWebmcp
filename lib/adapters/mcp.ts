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
import type { Actor, CallMeta, Operation } from "@/lib/operations/types";
import { executeDetailed, requestMeta } from "@/lib/operations/execute";
import type { CreditInfo, ProtocolError } from "@/lib/result";
import { creditCost } from "@/lib/credits/policy";
import { noteAgentSoftware } from "@/lib/management/sessions";
// Also turns on the SOC2 audit trail for every call execute() runs.
import { auditOperation } from "@/lib/audit";
// ...and usage metrics / OpenTelemetry export.
import { observeCall } from "@/lib/telemetry";
// ...and the management service behind the admin.* operations.
import "@/lib/management/service";
// ...and credit metering for every top-level call (lib/credits/port.ts).
import "@/lib/credits";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOp = Operation<any, any>;

export function mcpAnnotations(op: AnyOp) {
  return {
    title: op.title,
    readOnlyHint: op.permission === "read" && !op.dispatchesOps,
    destructiveHint: op.requiresConfirmation === true || op.dispatchesOps === true,
  };
}

/** Every failure, whatever its origin, goes out as the same ProtocolError shape. */
function errorResult(error: ProtocolError, credits?: CreditInfo, hinted = false) {
  const content = [{ type: "text" as const, text: JSON.stringify(error, null, 2) }];
  // A refusal's guidance is already its message; any other error gets the hint as its own block.
  if (hinted && credits?.hint && error.code !== "INSUFFICIENT_CREDITS") content.push(hintBlock(credits));
  return { content, isError: true, ...creditsMeta(credits) };
}

/** NavWebMcp credits on MCP (docs/credits.md): machine-readable state on every
 *  metered result in `_meta`; the hint, when there is one, as a short text
 *  block — the part a model reads. structuredContent is left untouched so it
 *  still matches the tool's outputSchema. */
export const CREDITS_META_KEY = "navwebmcp/credits";

function creditsMeta(credits?: CreditInfo) {
  return credits ? { _meta: { [CREDITS_META_KEY]: credits } } : {};
}

function hintBlock(credits: CreditInfo) {
  return { type: "text" as const, text: `[credits] ${credits.hint}` };
}

/** The client's optional CreditRequest: params._meta["navwebmcp/credits"].request. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function creditRequestOf(extra: any): number | undefined {
  const n = Number(extra?._meta?.[CREDITS_META_KEY]?.request);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1024) : undefined;
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

/** Request-level meta from the SDK's per-call `extra` (headers when the
 *  transport supplies them; absent in unit tests). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mcpRequestMeta(extra: any): CallMeta {
  const raw: Record<string, string | string[] | undefined> | undefined = extra?.requestInfo?.headers;
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  return requestMeta("mcp", headers);
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
        outputSchema: inlineSchema(outputObject(op.outputSchema as Record<string, z.ZodTypeAny>, op.openOutput)),
        annotations: mcpAnnotations(op),
        // The tool's credit cost on its own, for protocol-aware clients; the
        // same number explore/search/describe_tool/getCapabilities report.
        _meta: { [CREDITS_META_KEY]: { cost: creditCost(op) } },
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
          const meta: CallMeta = { ...mcpRequestMeta(extra), creditRequest: creditRequestOf(extra) };

          if (!userId || !role) {
            const err = fail("UNAUTHENTICATED", "A valid user token is required.");
            const denied = {
              operation: op.name,
              input,
              success: false,
              output: err.error,
              errorCode: err.error.code,
              actor: { type: "agent", userId: "anonymous", role: "customer", assurance: "asserted" } satisfies Actor,
              meta: { ...meta, callId: crypto.randomUUID() },
            };
            auditLog.recordCall(denied);
            await Promise.all([
              auditOperation({ ...denied, op }),
              observeCall({ ...denied, permission: op.permission, durationMs: 0, startedAt: Date.now() }),
            ]);
            return errorResult(err.error);
          }

          // clientInfo from `initialize`, when this server instance saw it
          // (stateless transports may not: then it's just unknown).
          const client = server.server?.getClientVersion?.();
          const clientId: string = extra?.authInfo?.clientId ?? userId;
          await noteAgentSoftware(clientId, client?.name, client?.version);
          const actor: Actor = {
            type: "agent",
            userId,
            role,
            assurance: "verified",
            sessionId: extra?.authInfo?.extra?.sid,
            agent: {
              clientId,
              name: client?.name,
              version: client?.version,
              sessionId: extra?.sessionId,
            },
          };
          const bearerToken: string = extra?.authInfo?.token ?? "";
          // execute() re-checks the role on every call (defense-in-depth on
          // top of the registration-time gate above) and audits the outcome.
          const { result, credits } = await executeDetailed(
            op.name,
            input,
            { userId, role, token: bearerToken, actor, meta }
          );
          const hinted = Boolean(result.credits?.hint);
          if (!result.success) return errorResult(result.error, credits, hinted);
          // The text block is kept for clients that predate structuredContent
          // (and for scripts/bench.mjs, which parses content[0].text).
          const content = [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }];
          if (hinted && credits) content.push(hintBlock(credits));
          return {
            content,
            structuredContent: result.data as Record<string, unknown>,
            ...creditsMeta(credits),
          };
        } finally {
          await flushCurrentSharedState();
        }
      }
    );
  }
}
