import { z } from "zod";
import { ok, fail } from "@/lib/result";
import type { Result } from "@/lib/result";
import { roleSatisfies } from "@/lib/auth";
import { auditLog } from "@/lib/auditlog";
import { registry } from "./registry";
import type { OperationContext } from "./types";

let _opByName: Map<string, (typeof registry)[number]> | undefined;
function getOpByName() {
  if (!_opByName) _opByName = new Map(registry.map((op) => [op.name, op]));
  return _opByName;
}

export function invalidateOpCache() {
  _opByName = undefined;
}

export { getOpByName };

export function effectiveParallelSafe(
  op: (typeof registry)[number],
  override?: boolean
): boolean {
  if (override !== undefined) return override;
  if (op.parallelSafe !== undefined) return op.parallelSafe;
  return op.permission === "read";
}

export async function runOne(
  name: string,
  args: Record<string, unknown>,
  ctx: OperationContext
): Promise<Result<unknown>> {
  invalidateOpCache();
  const op = getOpByName().get(name);
  if (!op) {
    auditLog.record(name, args, false, "agent");
    return fail("UNKNOWN_TOOL", `No operation named '${name}'.`);
  }
  if (!roleSatisfies(ctx.role, op.roles)) {
    auditLog.record(name, args, false, "agent");
    return fail("FORBIDDEN", `Role '${ctx.role}' is not permitted to call '${name}'.`);
  }
  const parsed = z.object(op.inputSchema as Record<string, z.ZodTypeAny>).safeParse(args);
  if (!parsed.success) {
    auditLog.record(name, args, false, "agent");
    return fail(
      "INVALID_ARGS",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }
  try {
    const result = await op.handler(parsed.data, ctx);
    auditLog.record(name, args, result.success, "agent");
    return result as Result<unknown>;
  } catch (err) {
    auditLog.record(name, args, false, "agent");
    return fail("HANDLER_ERROR", String(err));
  }
}

export function makeDispatch(ctx: OperationContext) {
  return (name: string, params: Record<string, unknown>) => runOne(name, params, ctx);
}

export { ok };
