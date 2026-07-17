import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { runOne, effectiveParallelSafe, getOpByName } from "./dispatch";

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
    if (name !== undefined) return ok(await runOne(name, (args ?? {}) as Record<string, unknown>, ctx));
    if (calls && calls.length > 0) {
      const results: unknown[] = new Array(calls.length);
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
