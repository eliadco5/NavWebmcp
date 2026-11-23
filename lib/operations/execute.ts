import { fail } from "@/lib/result";
import { inputObject, checkOutput } from "@/lib/schema";
import type { Result } from "@/lib/result";
import { roleSatisfies } from "@/lib/auth";
import { auditLog } from "@/lib/auditlog";
import { auditRecorder } from "@/lib/audit/port";
import { registry } from "./registry";
import type { Actor, CallMeta, Channel, OperationContext } from "./types";

/**
 * The single execution path for every operation call, whatever surface it came
 * through: POST /api/call (UI clicks and the in-page WebMCP agent), MCP tool
 * calls, and nested calls made by invoke and the composites. It does lookup →
 * RBAC → input validation → handler → output check, and records exactly one
 * audit entry per call — denials and validation failures included — carrying
 * who acted (human / agent / system), on whose behalf, through which channel,
 * and how the call relates to the request that caused it.
 */

/** Error-code spelling differs by surface for historical reasons; agents are
 *  told both mean the same thing (lib/agent-instructions.ts). */
export interface ExecuteCodes {
  unknown: string;
  invalid: string;
}

const DISPATCH_CODES: ExecuteCodes = { unknown: "UNKNOWN_TOOL", invalid: "INVALID_ARGS" };
export const SURFACE_CODES: ExecuteCodes = { unknown: "NOT_FOUND", invalid: "INVALID_INPUT" };

export interface ExecuteOptions {
  codes?: ExecuteCodes;
}

let _opByName: Map<string, (typeof registry)[number]> | undefined;
export function getOpByName() {
  if (!_opByName) _opByName = new Map(registry.map((op) => [op.name, op]));
  return _opByName;
}
export function invalidateOpCache() {
  _opByName = undefined;
}

/** Actor for a context nobody labelled — tests, scripts, the benchmarks. */
function defaultActor(ctx: OperationContext): Actor {
  return { type: "system", userId: ctx.userId, role: ctx.role, assurance: "asserted" };
}

/** Build the request-level meta a surface attaches to its context. */
export function requestMeta(channel: Channel, headers?: Headers): CallMeta {
  const forwarded = headers?.get("x-forwarded-for");
  return {
    requestId: headers?.get("x-request-id") || crypto.randomUUID(),
    channel,
    ip: forwarded ? forwarded.split(",")[0].trim() : headers?.get("x-real-ip") ?? undefined,
    userAgent: headers?.get("user-agent") ?? undefined,
  };
}

function formatIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
    .join("; ");
}

/** Where a call stopped. Lets a surface map gate failures to its own status
 *  codes (HTTP 404/403) without confusing them with a handler's own errors. */
export type ExecuteStage = "lookup" | "rbac" | "input" | "handler";

export async function execute(
  name: string,
  args: Record<string, unknown>,
  ctx: OperationContext,
  options: ExecuteOptions = {}
): Promise<Result<unknown>> {
  return (await executeDetailed(name, args, ctx, options)).result;
}

export async function executeDetailed(
  name: string,
  args: Record<string, unknown>,
  ctx: OperationContext,
  options: ExecuteOptions = {}
): Promise<{ result: Result<unknown>; stage: ExecuteStage }> {
  const codes = options.codes ?? DISPATCH_CODES;
  const started = performance.now();
  const actor = ctx.actor ?? defaultActor(ctx);
  const parentMeta = ctx.meta ?? requestMeta("internal");
  // A context that already has a callId is the parent's: we're nested.
  const meta: CallMeta = {
    ...parentMeta,
    callId: crypto.randomUUID(),
    parentCallId: parentMeta.callId,
  };
  const callCtx: OperationContext = { ...ctx, actor, meta };

  const op = getOpByName().get(name);

  const finish = async (stage: ExecuteStage, result: Result<unknown>) => {
    const call = {
      operation: name,
      input: args,
      success: result.success,
      output: result.success ? result.data : result.error,
      actor,
      meta,
      errorCode: result.success ? undefined : result.error.code,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    };
    // Activity feed (UI) — in-memory, last 100.
    auditLog.recordCall(call);
    // SOC2 trail — durable, hash-chained. Awaited so the event is stored
    // before the caller sees the result; never throws (lib/audit/store.ts).
    await auditRecorder()?.({ ...call, op });
    return { result, stage };
  };

  if (!op) return finish("lookup", fail(codes.unknown, `No operation named '${name}'.`));
  if (!roleSatisfies(actor.role, op.roles)) {
    return finish("rbac", fail("FORBIDDEN", `Role '${actor.role}' is not permitted to call '${name}'.`));
  }
  const parsed = inputObject(op.inputSchema).safeParse(args);
  if (!parsed.success) return finish("input", fail(codes.invalid, formatIssues(parsed.error.issues)));
  try {
    const result = (await op.handler(parsed.data, callCtx)) as Result<unknown>;
    if (result.success) checkOutput(op.name, op.outputSchema, result.data);
    return finish("handler", result);
  } catch (err) {
    return finish("handler", fail("HANDLER_ERROR", String(err)));
  }
}
