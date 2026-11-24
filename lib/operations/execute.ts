import { fail } from "@/lib/result";
import { inputObject, checkOutput } from "@/lib/schema";
import type { Result } from "@/lib/result";
import { roleSatisfies } from "@/lib/auth";
import { auditLog } from "@/lib/auditlog";
import { auditRecorder } from "@/lib/audit/port";
import { telemetryObserver } from "@/lib/telemetry/port";
import { credits as creditsPort, type CallOutcome } from "@/lib/credits/port";
import { bytesOf } from "@/lib/credits/policy";
import type { CreditInfo } from "@/lib/result";
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
 *  codes (HTTP 404/403/429) without confusing them with a handler's own errors. */
export type ExecuteStage = "credits" | "fanout" | "lookup" | "rbac" | "input" | "handler";

/** Fan-out limits for one request (invoke batches, composites, invoke inside invoke). */
export const FANOUT = {
  /** Deepest nesting allowed: invoke(0) → invoke(1) → book(2) → createReservation(3). */
  maxDepth: 3,
  /** Most operations one top-level call may run underneath it. */
  maxNested: 200,
};

/** Default handler deadline (ms); OP_DEADLINE_MS overrides, op.deadlineMs per op. */
function defaultDeadlineMs(): number {
  const n = Number(typeof process !== "undefined" ? process.env?.OP_DEADLINE_MS : undefined);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
}

class DeadlineExceeded extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface ExecuteDetail {
  result: Result<unknown>;
  stage: ExecuteStage;
  /** Credit state after a metered top-level call — always, for surfaces that
   *  carry it out of band (MCP _meta, HTTP headers). The Result itself only
   *  carries it when there's a hint. */
  credits?: CreditInfo;
}

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
): Promise<ExecuteDetail> {
  const codes = options.codes ?? DISPATCH_CODES;
  const started = performance.now();
  const startedAt = Date.now();
  const actor = ctx.actor ?? defaultActor(ctx);
  const parentMeta = ctx.meta ?? requestMeta("internal");
  // A context that already has a callId is the parent's: we're nested.
  const nested = parentMeta.callId !== undefined;
  const meta: CallMeta = {
    ...parentMeta,
    callId: crypto.randomUUID(),
    parentCallId: parentMeta.callId,
    depth: nested ? (parentMeta.depth ?? 0) + 1 : 0,
    // One counter object per top-level call, shared by everything under it.
    fanout: nested ? parentMeta.fanout ?? { count: 0 } : { count: 0 },
  };
  const callCtx: OperationContext = { ...ctx, actor, meta };

  const op = getOpByName().get(name);
  let settleCredits: ((o: CallOutcome) => Promise<(CreditInfo & { hinted: boolean }) | null>) | undefined;

  const finish = async (stage: ExecuteStage, result0: Result<unknown>, creditsOut?: CreditInfo) => {
    let result = result0;
    let credits = creditsOut;
    if (settleCredits) {
      const info = await settleCredits({
        durationMs: performance.now() - started,
        responseBytes: bytesOf(result0),
        nestedOps: meta.fanout?.count ?? 0,
      });
      if (info) {
        const { hinted, ...rest } = info;
        credits = rest;
        // Piggyback only when the caller should change what it's doing.
        if (hinted) result = { ...result0, credits: rest };
      }
    }    const call = {
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
    // Usage metrics + OTLP alongside it; best-effort, also never throws.
    await Promise.all([
      auditRecorder()?.({ ...call, op }),
      telemetryObserver()?.({ ...call, permission: op?.permission, startedAt, credits: credits?.charged }),
    ]);
    return { result, stage, credits };
  };

  // Fan-out cap: one request can't grow without bound through invoke batches
  // nested inside invoke batches. Checked before anything else for nested calls.
  if (nested) {
    const fanout = meta.fanout!;
    fanout.count += 1;
    if ((meta.depth ?? 0) > FANOUT.maxDepth) {
      return finish("fanout", fail("FANOUT_LIMIT", `Calls may nest at most ${FANOUT.maxDepth} levels deep; '${name}' was not run. Flatten the request into one invoke batch.`));
    }
    if (fanout.count > FANOUT.maxNested) {
      return finish("fanout", fail("FANOUT_LIMIT", `One request may run at most ${FANOUT.maxNested} operations; '${name}' was not run. Split the work into several requests.`));
    }
  }

  // Credits: only the top-level call pays, before anything runs, so a
  // composite can never run out halfway through its writes.
  const meter = nested ? undefined : creditsPort();
  if (meter) {
    const admission = await meter.admit({ operation: name, op, args, actor, meta });
    if (!admission.admitted) {
      const c = admission.credits;
      return finish("credits", { ...fail("INSUFFICIENT_CREDITS", c.hint ?? "Out of credits; retry later."), credits: c }, c);
    }
    settleCredits = admission.finish;
  }

  // Everything after admission is inside the try, so whatever throws, finish()
  // runs and the credits reserved above are always settled.
  const deadlineMs = op?.deadlineMs ?? defaultDeadlineMs();
  try {
    if (!op) return finish("lookup", fail(codes.unknown, `No operation named '${name}'.`));
    if (!roleSatisfies(actor.role, op.roles)) {
      return finish("rbac", fail("FORBIDDEN", `Role '${actor.role}' is not permitted to call '${name}'.`));
    }
    const parsed = inputObject(op.inputSchema).safeParse(args);
    if (!parsed.success) return finish("input", fail(codes.invalid, formatIssues(parsed.error.issues)));
    const result = (await withDeadline(op.handler(parsed.data, callCtx), deadlineMs)) as Result<unknown>;
    if (result.success) checkOutput(op.name, op.outputSchema, result.data);
    return finish("handler", result);
  } catch (err) {
    if (err instanceof DeadlineExceeded) {
      // The handler may still finish in the background; the caller is told it
      // didn't complete in time, and the time is charged either way.
      return finish("handler", fail("HANDLER_TIMEOUT", `'${name}' did not finish within ${Math.round(deadlineMs / 1000)} s. Check whether it took effect before retrying.`));
    }
    return finish("handler", fail("HANDLER_ERROR", String(err)));
  }
}
