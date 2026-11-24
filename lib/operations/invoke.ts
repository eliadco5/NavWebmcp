import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { runOne, effectiveParallelSafe, getOpByName } from "./dispatch";
import { ErrorSchema } from "@/lib/schema";
import { ShortText } from "./schemas";

const CallSchema = z.object({
  name: ShortText(128).min(1).describe("Operation name"),
  args: z.record(z.unknown()).default({}).describe("Arguments for the operation"),
  parallelSafe: z.boolean().optional().describe("Override parallel-safety for this call"),
}).strict();

const InnerResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional().describe("The called function's success data; see its outputSchema via describe_tool"),
  error: ErrorSchema.optional(),
});

export const invoke = defineOperation({
  name: "invoke",
  title: "Invoke",
  description:
    "Call a function without loading it (stateless, Path B). " +
    "Single call: { name, args }. Batch: { calls: [{name, args}] } — reads run in parallel, writes run in order. " +
    "A batch costs fewer credits than the same calls made one by one.",
  permission: "read",
  dispatchesOps: true,
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    name: ShortText(128).min(1).optional().describe("Function name (single-call form)"),
    args: z.record(z.unknown()).optional().describe("Arguments (single-call form)"),
    calls: z.array(CallSchema).max(50).optional().describe("Batch calls (use this or name+args, not both)"),
  },
  // Single call: the called function's own Result envelope ({success, data|error}).
  // Batch: { results } with one such envelope per call, in request order.
  outputSchema: {
    ...InnerResultSchema.partial().shape,
    results: z.array(InnerResultSchema).optional().describe("Batch form: one result per call, in request order"),
  },
  async handler({ name, args, calls }, ctx) {
    if (name !== undefined) return ok(await runOne(name, (args ?? {}) as Record<string, unknown>, ctx));
    if (calls && calls.length > 0) {
      const results: Awaited<ReturnType<typeof runOne>>[] = new Array(calls.length);
      const parallelIdx: number[] = [], seqIdx: number[] = [];
      for (let i = 0; i < calls.length; i++) {
        const op = getOpByName().get(calls[i].name);
        effectiveParallelSafe(op ?? { permission: "write" } as never, calls[i].parallelSafe) ? parallelIdx.push(i) : seqIdx.push(i);
      }
      await Promise.all(parallelIdx.map(async (i) => { results[i] = await runOne(calls[i].name, (calls[i].args ?? {}) as Record<string, unknown>, ctx); }));
      for (const i of seqIdx) results[i] = await runOne(calls[i].name, (calls[i].args ?? {}) as Record<string, unknown>, ctx);
      return ok({ results });
    }
    return fail("INVALID_ARGS", "Provide either 'name' (single call) or 'calls' (batch).");
  },
});
