import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { roleSatisfies } from "@/lib/auth";
import { auditLog } from "@/lib/auditlog";
import { registry } from "./registry";

let _opByName: Map<string, (typeof registry)[number]> | undefined;
function getOpByName() {
  if (!_opByName) _opByName = new Map(registry.map((op) => [op.name, op]));
  return _opByName;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function effectiveParallelSafe(op: (typeof registry)[number], override?: boolean): boolean {
  if (override !== undefined) return override;
  if (op.parallelSafe !== undefined) return op.parallelSafe;
  return op.permission === "read";
}

async function runOne(name: string, args: Record<string, unknown>, ctx: { userId: string; role: never; token: string }): Promise<unknown> {
  // Invalidate lazy map if registry has grown (new ops loaded)
  _opByName = undefined;
  const op = getOpByName().get(name);
  if (!op) { auditLog.record(name, args, false, "agent"); return fail("UNKNOWN_TOOL", `No operation named '${name}'.`); }
  if (!roleSatisfies(ctx.role, op.roles)) { auditLog.record(name, args, false, "agent"); return fail("FORBIDDEN", `Role '${ctx.role}' is not permitted to call '${name}'.`); }
  const parsed = z.object(op.inputSchema as Record<string, z.ZodTypeAny>).safeParse(args);
  if (!parsed.success) { auditLog.record(name, args, false, "agent"); return fail("INVALID_ARGS", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")); }
  try {
    const result = await op.handler(parsed.data, { userId: ctx.userId, role: ctx.role, token: ctx.token });
    auditLog.record(name, args, result.success, "agent");
    return result;
  } catch (err) {
    auditLog.record(name, args, false, "agent");
    return fail("HANDLER_ERROR", String(err));
  }
}

const CallSchema = z.object({
  name: z.string().describe("Operation name"),
  args: z.record(z.unknown()).default({}).describe("Arguments for the operation"),
  parallelSafe: z.boolean().optional().describe("Override parallel-safety for this call"),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const invoke = defineOperation<any, any>({
  name: "invoke",
  title: "Invoke",
  description:
    "Call a function without loading it (stateless, Path B). " +
    "Single call: { name, args }. Batch: { calls: [{name, args}] } — reads run in parallel, writes run in order.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    name: z.string().optional().describe("Function name (single-call form)"),
    args: z.record(z.unknown()).optional().describe("Arguments (single-call form)"),
    calls: z.array(CallSchema).optional().describe("Batch calls (use this or name+args, not both)"),
  },
  async handler({ name, args, calls }, ctx) {
    if (name !== undefined) return ok(await runOne(name, (args ?? {}) as Record<string, unknown>, ctx as never));
    if (calls && calls.length > 0) {
      const results: unknown[] = new Array(calls.length);
      const parallelIdx: number[] = [], seqIdx: number[] = [];
      for (let i = 0; i < calls.length; i++) {
        const op = getOpByName().get(calls[i].name);
        effectiveParallelSafe(op ?? { permission: "write" } as never, calls[i].parallelSafe) ? parallelIdx.push(i) : seqIdx.push(i);
      }
      await Promise.all(parallelIdx.map(async (i) => { results[i] = await runOne(calls[i].name, (calls[i].args ?? {}) as Record<string, unknown>, ctx as never); }));
      for (const i of seqIdx) results[i] = await runOne(calls[i].name, (calls[i].args ?? {}) as Record<string, unknown>, ctx as never);
      return ok({ results });
    }
    return fail("INVALID_ARGS", "Provide either 'name' (single call) or 'calls' (batch).");
  },
});
