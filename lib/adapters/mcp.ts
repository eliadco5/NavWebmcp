import { AsyncLocalStorage } from "async_hooks";
import {
  fromJsonSchema, inputRequired, inputResponse,
  type McpServer, type JsonSchemaValidator, type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
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
import { inputObject, outputObject, toJsonSchema } from "@/lib/schema";
// Installs the UI relay the ui_* ops reach through lib/ui-relay/port.ts.
import "@/lib/ui-relay/store";
import type { Role } from "@/lib/auth";
import type { Actor, CallMeta, Operation } from "@/lib/operations/types";
import { executeDetailed, requestMeta } from "@/lib/operations/execute";
import type { ConfirmationInfo, CreditInfo, IdempotencyInfo, ProtocolError, Result } from "@/lib/result";
import { getOpByName } from "@/lib/operations/execute";
import { FORMAT_HEADER, TEXT_FORMATS, type TextFormat } from "@/lib/constants";
import { creditCost } from "@/lib/credits/policy";
import { isIdempotentOp } from "@/lib/idempotency/port";
import { noteAgentSoftware } from "@/lib/management/sessions";
// Also turns on the SOC2 audit trail for every call execute() runs.
import { auditOperation } from "@/lib/audit";
// ...and usage metrics / OpenTelemetry export.
import { observeCall } from "@/lib/telemetry";
// ...and the management service behind the admin.* operations.
import "@/lib/management/service";
// ...and credit metering for every top-level call (lib/credits/port.ts).
import "@/lib/credits";
// ...and the shared idempotency store for keyed writes (lib/idempotency/port.ts).
import "@/lib/idempotency";
// ...and the shared key and one-use store for confirmation tokens (lib/confirmation/port.ts).
import "@/lib/confirmation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOp = Operation<any, any>;

export function mcpAnnotations(op: AnyOp) {
  return {
    title: op.title,
    readOnlyHint: op.permission === "read" && !op.dispatchesOps,
    destructiveHint: op.requiresConfirmation === true || op.dispatchesOps === true,
    // True since 2.1.0: a repeat with the same idempotencyKey has no further effect.
    ...(isIdempotentOp(op) && { idempotentHint: true }),
  };
}

/** The JSON in a result's text block: indented (the default) or compact. Only
 *  whitespace differs; structuredContent and _meta are identical either way. */
export function formatText(value: unknown, format: TextFormat = "pretty"): string {
  return format === "compact" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

function asFormat(v: unknown): TextFormat | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : undefined;
  return (TEXT_FORMATS as readonly string[]).includes(s ?? "") ? (s as TextFormat) : undefined;
}

/** A connection's format: the X-NavWebMcp-Format header, else `?format=` on the
 *  MCP URL, else "pretty". An unknown value is ignored, never an error. */
export function formatFromRequest(req: Request): TextFormat {
  let fromUrl: string | null = null;
  try {
    fromUrl = new URL(req.url).searchParams.get("format");
  } catch { /* relative URL in a test: no query */ }
  return asFormat(req.headers.get(FORMAT_HEADER)) ?? asFormat(fromUrl) ?? "pretty";
}

/** Per call: params._meta["navwebmcp/format"] overrides the connection's format. */
export const FORMAT_META_KEY = "navwebmcp/format";

/** Whether tools/list carries the op's outputSchema on MCP: business operations
 *  yes, the always-on navigation and ui_* tools no (NavWebMcp ≥ 2.5.0). */
export function publishesOutputSchema(op: AnyOp): boolean {
  return !op.alwaysOn;
}

/** Every failure, whatever its origin, goes out as the same ProtocolError shape. */
function errorResult(error: ProtocolError, credits?: CreditInfo, hinted = false, format: TextFormat = "pretty") {
  const content = [{ type: "text" as const, text: formatText(error, format) }];
  // A refusal's guidance is already its message; any other error gets the hint as its own block.
  if (hinted && credits?.hint && error.code !== "INSUFFICIENT_CREDITS") content.push(hintBlock(credits));
  return { content, isError: true, ...creditsMeta(credits) };
}

/** NavWebMcp credits on MCP (docs/credits.md): machine-readable state on every
 *  metered result in `_meta`; the hint, when there is one, as a short text
 *  block — the part a model reads. structuredContent is left untouched so it
 *  still matches the tool's outputSchema. */
export const CREDITS_META_KEY = "navwebmcp/credits";

function creditsMeta(credits?: CreditInfo, idempotency?: IdempotencyInfo) {
  const meta: Record<string, unknown> = {};
  if (credits) meta[CREDITS_META_KEY] = credits;
  if (idempotency) meta[IDEMPOTENCY_META_KEY] = idempotency;
  return Object.keys(meta).length > 0 ? { _meta: meta } : {};
}

/** On a replayed result (NavWebMcp 2.1.0): `{ key, replayed: true }`. */
export const IDEMPOTENCY_META_KEY = "navwebmcp/idempotency";

function hintBlock(credits: CreditInfo) {
  return { type: "text" as const, text: `[credits] ${credits.hint}` };
}

/** The client's optional CreditRequest: params._meta["navwebmcp/credits"].request. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function creditRequestOf(meta: any): number | undefined {
  const n = Number(meta?.[CREDITS_META_KEY]?.request);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1024) : undefined;
}

interface McpContext {
  role: Role;
  token: string;
  /** How this connection wants text blocks written (formatFromRequest). */
  format?: TextFormat;
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
    return mcpContext.run({ role, token, format: formatFromRequest(req) }, () => handler(req));
  };
}

/** Request-level meta from the SDK's per-call context: the HTTP request's
 *  headers when there is one (absent on the in-memory transport in tests). */
function mcpRequestMeta(headers: Headers | undefined): CallMeta {
  return requestMeta("mcp", headers ?? new Headers());
}

/** What the SDK v2 hands a tool callback, as far as this adapter reads it. */
interface ToolCallContext {
  http?: { authInfo?: { token?: string; clientId?: string; extra?: Record<string, unknown> }; req?: Request };
  mcpReq?: {
    _meta?: Record<string, unknown>;
    /** 2026-07-28 multi round-trip: the client's answers, on the retried call. */
    inputResponses?: Record<string, unknown>;
    requestState?: () => unknown;
  };
}

// ── Confirmation through MCP elicitation (NavWebMcp 2.6.0) ───────────────────
//
// When a destructive call needs approval and the client can elicit, the server
// asks the user itself: the call answers `input_required` with an elicitation
// showing the preview, and the confirmation tokens as `requestState`. The client
// shows the form, then re-sends the same call with the answer; execute() then
// accepts exactly the calls those tokens were minted for. Nothing is held open
// between the two requests, so it works on serverless. The tokens are HMAC'd
// and bound to the caller, the operation and the arguments, so an echoed state
// can't approve anything else.

/** The key of our one elicitation in inputRequests / inputResponses. */
export const ELICIT_KEY = "navwebmcp_confirm";

const ELICIT_SCHEMA = {
  type: "object" as const,
  properties: {
    approve: { type: "boolean" as const, title: "Approve", description: "Approve this action" },
  },
  required: ["approve"],
};

/** The user's answer carried by a retried call, if any. */
function elicitationAnswer(mcpReq: ToolCallContext["mcpReq"]): CallMeta["elicitation"] | undefined {
  let raw: unknown;
  try { raw = mcpReq?.requestState?.(); } catch { return undefined; }
  if (typeof raw !== "string" || raw.length > 64_000) return undefined;
  let tokens: string[];
  try {
    const state = JSON.parse(raw) as { v?: unknown; tokens?: unknown };
    if (state?.v !== 1 || !Array.isArray(state.tokens)) return undefined;
    tokens = state.tokens.filter((t): t is string => typeof t === "string" && t.length <= 1024).slice(0, 50);
  } catch {
    return undefined;
  }
  const answer = inputResponse(mcpReq?.inputResponses, ELICIT_KEY);
  if (answer.kind !== "elicit") return undefined;
  return { approved: answer.action === "accept" && answer.content?.approve === true, tokens };
}

/** The approvals a result asks for: its own, or those of an invoke batch's
 *  items. Undefined when nothing asks, or when re-running the call would
 *  repeat a write that already succeeded in this round (a batch that also wrote). */
function pendingConfirmations(op: AnyOp, input: Record<string, unknown>, result: Result<unknown>): ConfirmationInfo[] | undefined {
  if (!result.success) return result.error.confirmation ? [result.error.confirmation] : undefined;
  if (!op.dispatchesOps || !Array.isArray(input.calls)) return undefined;
  const items = (result.data as { results?: unknown })?.results;
  if (!Array.isArray(items)) return undefined;
  const calls = input.calls as { name?: unknown }[];
  const asks: ConfirmationInfo[] = [];
  for (let i = 0; i < items.length; i++) {
    const r = items[i] as Result<unknown> | undefined;
    if (r && !r.success && r.error?.confirmation) asks.push(r.error.confirmation);
    else if (r?.success) {
      const called = typeof calls[i]?.name === "string" ? getOpByName().get(calls[i].name as string) : undefined;
      if (!called || called.permission === "write") return undefined;
    }
  }
  return asks.length > 0 ? asks : undefined;
}

function elicitationRequest(asks: ConfirmationInfo[]) {
  const lines = asks.map((a) => `• ${a.preview.summary}`).join("\n");
  return inputRequired({
    inputRequests: {
      [ELICIT_KEY]: inputRequired.elicit({
        message: `An agent wants to do this on your behalf:\n${lines}\nApprove?`,
        requestedSchema: ELICIT_SCHEMA,
      }),
    },
    requestState: JSON.stringify({ v: 1, tokens: asks.map((a) => a.token) }),
  });
}

type JsonSchema = Parameters<typeof fromJsonSchema>[0];

/** Accepts any arguments, so execute() is what validates them. It runs the
 *  operation's own strict Zod schema and answers a NavWebMcp INVALID_INPUT with
 *  per-field details, the same error as on invoke and /api/call. The SDK's own
 *  check would answer a bare text line instead ("data must NOT have additional
 *  properties"), without saying which field. */
const deferToExecute: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

/** The tool's JSON Schema, built by our own converter (lib/schema.ts) and
 *  handed to the SDK as-is. The SDK v2 only converts Zod 4 itself; ours is Zod 3,
 *  and this way tools/list publishes exactly what describe_tool and WebMCP do. */
function sdkSchema(json: Record<string, unknown>, kind: "input" | "output") {
  const { $schema: _dialect, ...rest } = json;
  // Output keeps the SDK's check: it's a second guard on top of execute()'s.
  return kind === "input"
    ? fromJsonSchema<Record<string, unknown>>(rest as JsonSchema, deferToExecute)
    : allowDryRun(fromJsonSchema<Record<string, unknown>>(rest as JsonSchema));
}

/** A dryRun's data ({ dryRun: true, preview }) is not the op's output shape,
 *  and nothing ran to check; every other result still gets the SDK's check. */
function allowDryRun<S extends ReturnType<typeof fromJsonSchema<Record<string, unknown>>>>(schema: S): S {
  const std = schema["~standard"];
  return {
    ...schema,
    "~standard": {
      ...std,
      validate: (data: unknown) => (isDryRunData(data) ? { value: data as Record<string, unknown> } : std.validate(data)),
    },
  };
}

function isDryRunData(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { dryRun?: unknown }).dryRun === true && "preview" in data;
}

/** An operation's two SDK schemas, built once per process. A server is built
 *  per request (stateless), and both the JSON Schema conversion and the SDK's
 *  validator compilation are too slow to repeat for every tool on every call:
 *  done per request they cut throughput roughly ninefold. Operations are
 *  static, so the cache never goes stale. */
const schemaCache = new WeakMap<AnyOp, { input: ReturnType<typeof sdkSchema>; output: ReturnType<typeof sdkSchema> }>();

function sdkSchemasOf(op: AnyOp) {
  let cached = schemaCache.get(op);
  if (!cached) {
    cached = {
      input: sdkSchema(toJsonSchema(inputObject(op.inputSchema as Record<string, z.ZodTypeAny>)), "input"),
      output: sdkSchema(toJsonSchema(outputObject(op.outputSchema as Record<string, z.ZodTypeAny>, op.openOutput)), "output"),
    };
    schemaCache.set(op, cached);
  }
  return cached;
}

export function registerMcpTools(server: McpServer) {
  const ctx = mcpContext.getStore();
  const callerRole: Role = ctx?.role ?? "customer";
  const token: string = ctx?.token ?? "";
  const connectionFormat: TextFormat = ctx?.format ?? "pretty";

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
        // Strict object (additionalProperties: false), as execute() enforces it.
        inputSchema: sdkSchemasOf(op).input,
        // The SDK requires structuredContent matching this on every non-error result.
        // Not published for the always-on tools (2.5.0): they're in every tools/list,
        // their results are self-describing, and their output schemas were most of
        // the connect cost. describe_tool still returns them on request.
        ...(publishesOutputSchema(op) && { outputSchema: sdkSchemasOf(op).output }),
        annotations: mcpAnnotations(op),
        // The tool's credit cost on its own, for protocol-aware clients; the
        // same number explore/search/describe_tool/getCapabilities report.
        _meta: { [CREDITS_META_KEY]: { cost: creditCost(op) } },
      },
      async (input: Record<string, unknown>, sdkCtx: ToolCallContext) => {
        // mcp-handler's Streamable HTTP transport resolves the route's own
        // Response before this callback finishes running (the body is a
        // stream, and the tool call executes as part of writing to it) — so
        // withSharedState's wrapper-level flush (app/api/[transport]/route.ts)
        // can fire before the mutation below happens. flushCurrentSharedState()
        // here flushes at the moment completion is actually known, using the
        // AsyncLocalStorage baseline that survives this same async boundary
        // (mcpContext, right below, already relies on the same guarantee).
        try {
          const authInfo = sdkCtx?.http?.authInfo;
          const reqMeta = sdkCtx?.mcpReq?._meta;
          const userId = authInfo?.extra?.userId as string | undefined;
          const role = authInfo?.extra?.role as Role | undefined;
          const elicitation = elicitationAnswer(sdkCtx?.mcpReq);
          const meta: CallMeta = {
            ...mcpRequestMeta(sdkCtx?.http?.req?.headers),
            creditRequest: creditRequestOf(reqMeta),
            ...(elicitation && { elicitation }),
          };
          const format: TextFormat = asFormat(reqMeta?.[FORMAT_META_KEY]) ?? connectionFormat;

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
            return errorResult(err.error, undefined, false, format);
          }

          // The client's name and version: from the request's own envelope on
          // 2026-07-28, or from `initialize` on 2025-era clients (the SDK fills
          // this accessor in either way). Unknown when neither carried it.
          const client = server.server?.getClientVersion?.();
          const clientId: string = authInfo?.clientId ?? userId;
          await noteAgentSoftware(clientId, client?.name, client?.version);
          const actor: Actor = {
            type: "agent",
            userId,
            role,
            assurance: "verified",
            sessionId: authInfo?.extra?.sid as string | undefined,
            agent: {
              clientId,
              name: client?.name,
              version: client?.version,
            },
          };
          const bearerToken: string = authInfo?.token ?? "";
          // execute() re-checks the role on every call (defense-in-depth on
          // top of the registration-time gate above) and audits the outcome.
          const { result, credits } = await executeDetailed(
            op.name,
            input,
            { userId, role, token: bearerToken, actor, meta }
          );
          // A client that can elicit gets the approval question asked of its user
          // directly, instead of a CONFIRMATION_REQUIRED for the model to relay.
          if (server.server?.getClientCapabilities?.()?.elicitation) {
            const asks = pendingConfirmations(op, input, result);
            if (asks) return elicitationRequest(asks) as never;
          }
          const hinted = Boolean(result.credits?.hint);
          if (!result.success) return errorResult(result.error, credits, hinted, format);
          // The text block is kept for clients that predate structuredContent
          // (and for scripts/bench.mjs, which parses content[0].text).
          const content = [{ type: "text" as const, text: formatText(result.data, format) }];
          if (hinted && credits) content.push(hintBlock(credits));
          // A replay says so in a block the model reads; structuredContent stays the op's own data.
          if (result.idempotency) {
            content.push({ type: "text" as const, text: `[idempotency] Replayed the earlier result for idempotencyKey '${result.idempotency.key}'; nothing ran again.` });
          }
          return {
            content,
            structuredContent: result.data as Record<string, unknown>,
            ...creditsMeta(credits, result.idempotency),
          };
        } finally {
          await flushCurrentSharedState();
        }
      }
    );
  }
}
