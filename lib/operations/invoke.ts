import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import type { Result } from "@/lib/result";
import { runOne, effectiveParallelSafe, getOpByName } from "./dispatch";
import { ShortText } from "./schemas";
import { findRefs, formatAt, parseRef, resolveRef, substitute, type ParsedRef } from "./refs";
import type { OperationContext } from "./types";

const CallSchema = z.object({
  name: ShortText(128).min(1).describe("Function name"),
  args: z.record(z.unknown()).default({}).describe(
    "Its arguments; a value may be { \"$ref\": \"<i>.data.<path>\" }, e.g. \"0.data.slots[0].id\""
  ),
  parallelSafe: z.boolean().optional().describe("Override parallel-safety"),
}).strict();

export const invoke = defineOperation({
  name: "invoke",
  title: "Invoke",
  description:
    "Call any function by name, without loading it. { name, args } returns its own result. " +
    "{ calls: [...] } returns { results } in order: reads run in parallel, writes in order, and it costs fewer credits. " +
    "In a batch, an argument { \"$ref\": \"<i>.data.<path>\" } (keys and [n] only) uses earlier call i's result; " +
    "if that fails, the call gets DEPENDENCY_FAILED.",
  permission: "read",
  dispatchesOps: true,
  // Single call relays the called op's data verbatim, so its keys are not known here.
  openOutput: true,
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    name: ShortText(128).min(1).optional().describe("Function name (single call)"),
    args: z.record(z.unknown()).optional().describe("Its arguments (single call)"),
    calls: z.array(CallSchema).max(50).optional().describe("A batch, instead of name/args"),
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
      const stray = findRefs(args ?? {})[0];
      if (stray) {
        return fail("INVALID_INPUT", "$ref only works inside invoke({ calls }), where it points at an earlier call.", {
          details: [{ path: formatAt(["args", ...stray.at]), message: "$ref outside a batch" }],
        });
      }
      const result = await runOne(name, (args ?? {}) as Record<string, unknown>, ctx);
      // Relaying a replay: invoke ran nothing either, so it is charged as one too.
      if (result.success && result.idempotency && ctx.meta) ctx.meta.idempotencyReplayed = true;
      return result as Result<{ results?: never }>;
    }
    if (calls && calls.length > 0 && calls.some((c, i) => refsOf(c, i).length > 0)) {
      return runDependentBatch(calls, ctx);
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

type Call = { name: string; args: Record<string, unknown>; parallelSafe?: boolean };

/** The `$ref`s that belong to this batch in call i's args. A nested invoke's own
 *  `calls` are left alone: their refs point into that inner batch. */
function refsOf(call: Call, _i: number) {
  if (getOpByName().get(call.name)?.dispatchesOps) return [];
  return findRefs(call.args ?? {});
}

/**
 * A batch where some calls use earlier calls' results (NavWebMcp 2.2.0).
 *
 * Every ref is checked before anything runs: it must parse and point at an
 * earlier call (so there are no cycles). Then each call starts as soon as:
 *  - the calls it refers to have finished, and
 *  - for a call that isn't parallel-safe (a write): the previous such call has
 *    finished, and so have the parallel-safe calls that don't depend on any
 *    write — the same "reads first, then writes in order" as a plain batch.
 * A call whose dependency failed, or whose path doesn't resolve, is not run and
 * gets DEPENDENCY_FAILED; calls depending on it fail the same way.
 */
async function runDependentBatch(calls: Call[], ctx: OperationContext): Promise<Result<{ results: Result<unknown>[] }>> {
  const n = calls.length;
  const refs: { at: (string | number)[]; raw: string; parsed: ParsedRef }[][] = [];
  const details: { path: string; message: string }[] = [];
  for (let i = 0; i < n; i++) {
    const found = refsOf(calls[i], i);
    refs.push([]);
    for (const f of found) {
      const path = formatAt(["calls", i, "args", ...f.at]);
      const parsed = parseRef(f.raw);
      if (!parsed) {
        details.push({ path, message: `Not a valid $ref: '${String(f.raw).slice(0, 80)}'. Use '<i>.data.<key>[<n>]…', e.g. '0.data.slots[0].id'` });
      } else if (parsed.call >= i) {
        details.push({ path, message: `$ref must point at an earlier call (0–${i - 1})${i === 0 ? ", and call 0 has none" : ""}; got ${parsed.call}` });
      } else {
        refs[i].push({ ...f, parsed });
      }
    }
  }
  if (details.length > 0) {
    return fail("INVALID_INPUT", `Invalid $ref in the batch: ${details.map((d) => d.path).join(", ")}. Nothing was run.`, { details });
  }

  const deps = refs.map((r) => [...new Set(r.map((x) => x.parsed.call))]);
  const seq = calls.map((c) => {
    const op = getOpByName().get(c.name);
    return !effectiveParallelSafe(op ?? ({ permission: "write" } as never), c.parallelSafe);
  });
  // Does call i (transitively) wait on a write? Deps only point back, so one pass.
  const afterWrite: boolean[] = [];
  for (let i = 0; i < n; i++) afterWrite.push(deps[i].some((d) => seq[d] || afterWrite[d]));
  const initialReads = calls.map((_, i) => i).filter((i) => !seq[i] && !afterWrite[i]);

  const results: Result<unknown>[] = new Array(n);
  const running = new Map<number, Promise<void>>();
  let prevWrite = -1;
  const prevWriteOf: number[] = calls.map((_, i) => {
    if (!seq[i]) return -1;
    const p = prevWrite;
    prevWrite = i;
    return p;
  });

  const run = (i: number): Promise<void> => {
    const existing = running.get(i);
    if (existing) return existing;
    const p = (async () => {
      const waits = [...deps[i]];
      if (seq[i]) {
        if (prevWriteOf[i] >= 0) waits.push(prevWriteOf[i]);
        waits.push(...initialReads);
      }
      await Promise.all(waits.map(run));
      const values = new Map<string, unknown>();
      for (const r of refs[i]) {
        const res = resolveRef(r.parsed, results[r.parsed.call]);
        if (!res.ok) {
          results[i] = fail("DEPENDENCY_FAILED", `Call ${i} ('${calls[i].name}') was not run: ${res.reason}.`, {
            details: [{ path: formatAt(["calls", i, "args", ...r.at]), message: `$ref '${r.raw}': ${res.reason}` }],
            requestId: ctx.meta?.requestId,
          });
          return;
        }
        values.set(r.raw, res.value);
      }
      const args = substitute(calls[i].args ?? {}, values) as Record<string, unknown>;
      results[i] = await runOne(calls[i].name, args, ctx);
    })();
    running.set(i, p);
    return p;
  };
  // Start in request order, so sibling calls begin in a stable order.
  await Promise.all(calls.map((_, i) => run(i)));
  return ok({ results });
}
