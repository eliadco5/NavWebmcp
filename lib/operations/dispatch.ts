import { ok } from "@/lib/result";
import type { Result } from "@/lib/result";
import { registry } from "./registry";
import { execute, getOpByName, invalidateOpCache } from "./execute";
import type { OperationContext } from "./types";

export { getOpByName, invalidateOpCache };

export function effectiveParallelSafe(
  op: (typeof registry)[number],
  override?: boolean
): boolean {
  if (override !== undefined) return override;
  if (op.parallelSafe !== undefined) return op.parallelSafe;
  return op.permission === "read";
}

/** In-process call by name. Nested calls (invoke, composites) inherit the
 *  caller's actor and are linked to it via parentCallId — see execute(). */
export function runOne(
  name: string,
  args: Record<string, unknown>,
  ctx: OperationContext
): Promise<Result<unknown>> {
  return execute(name, args, ctx);
}

export function makeDispatch(ctx: OperationContext) {
  return (name: string, params: Record<string, unknown>) => runOne(name, params, ctx);
}

export { ok };
