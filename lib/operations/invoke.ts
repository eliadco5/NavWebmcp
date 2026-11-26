import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import type { Result } from "@/lib/result";
import { runOne, effectiveParallelSafe, getOpByName } from "./dispatch";
import { ShortText } from "./schemas";

const CallSchema = z.object({
  name: ShortText(128).min(1).describe("Operation name"),
  args: z.record(z.unknown()).default({}).describe("Arguments for the operation"),
  parallelSafe: z.boolean().optional().describe("Override parallel-safety for this call"),
}).strict();

export const invoke = defineOperation({
  name: "invoke",
  title: "Invoke",
  description:
    "Call a function without loading it (stateless, Path B). " +
    "Single call: { name, args } returns exactly what the function returns — its data on success, its error on failure. " +
    "Batch: { calls: [{name, args}] } returns { results }, one { success, data | error } per call in request order; " +
    "reads run in parallel, writes run in order. " +
    "A batch costs fewer credits than the same calls made one by one.",
  permission: "read",
  dispatchesOps: true,
  // Single call relays the called op's data verbatim, so its keys are not known here.
  openOutput: true,
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    name: ShortText(128).min(1).optional().describe("Function name (single-call form)"),
    args: z.record(z.unknown()).optional().describe("Arguments (single-call form)"),
    calls: z.array(CallSchema).max(50).optional().describe("Batch calls (use this or name+args, not both)"),
  },
  // Single call: the called function's own success data (see its outputSchema via
  // describe_tool); any key may appear. Batch: { results }.
  //
  // `results` items are typed loosely on purpose: a single call to an op whose own
  // data has a `results` key (load_tools, explore with an array) relays that key
  // verbatim, and the MCP SDK validates every structuredContent against this schema.
  outputSchema: {
    results: z.array(z.record(z.unknown())).optional().describe(
      "Batch form: one { success, data | error } per call, in request order. " +
      "(A single call relays the called op's own data, which may have its own `results`.)"
    ),
  },
  async handler({ name, args, calls }, ctx) {
    if (name !== undefined && calls !== undefined) {
      return fail("INVALID_INPUT", "Provide either 'name' (single call) or 'calls' (batch), not both.", {
        details: [{ path: "calls", message: "Not allowed together with 'name'" }],
      });
    }
    // Single call: no second envelope. A failed op fails invoke with the op's own
    // error, so `success` always means "the operation succeeded".
    if (name !== undefined) {
      const result = await runOne(name, (args ?? {}) as Record<string, unknown>, ctx);
      // Relaying a replay: invoke ran nothing either, so it is charged as one too.
      if (result.success && result.idempotency && ctx.meta) ctx.meta.idempotencyReplayed = true;
      return result as Result<{ results?: never }>;
    }
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
    return fail("INVALID_INPUT", "Provide either 'name' (single call) or 'calls' (batch).", {
      details: [{ path: "", message: "One of 'name' or 'calls' is required" }],
    });
  },
});
