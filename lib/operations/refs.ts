// Dependent batches (NavWebMcp 2.2.0): inside invoke({ calls }), any argument
// value may be { "$ref": "<index>.<path>" }, which is replaced by a value from
// an earlier call's result before that call runs.
//
//   { "$ref": "0.data.slots[0].id" }    call 0's result → data → slots → [0] → id
//   { "$ref": "1.data.reservation.id" }
//
// Grammar, deliberately small: a call index, then any number of `.key` and
// `[n]` steps. No filters, wildcards or functions: selection belongs in the
// operation's own inputs (e.g. searchAvailability's `time`). Client-safe.
import type { Result } from "@/lib/result";

export type RefStep = { key: string } | { index: number };

export interface ParsedRef {
  /** The batch index the ref points at. */
  call: number;
  /** Steps into that call's Result envelope ({ success, data }). */
  steps: RefStep[];
}

/** One `$ref` found in a call's arguments. */
export interface FoundRef {
  /** Where it sits inside the args, e.g. ["slotId"] or ["items", 2, "id"]. */
  at: (string | number)[];
  raw: string;
}

const REF_RE = /^(\d+)((?:\.[A-Za-z_$][\w$-]*|\[\d+\])*)$/;
const STEP_RE = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]/g;

/** True for `{ "$ref": "…" }` with no other key. */
export function isRef(value: unknown): value is { $ref: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "$ref";
}

export function parseRef(raw: unknown): ParsedRef | null {
  if (typeof raw !== "string" || raw.length > 256) return null;
  const m = REF_RE.exec(raw);
  if (!m) return null;
  const steps: RefStep[] = [];
  for (const s of m[2].matchAll(STEP_RE)) {
    steps.push(s[1] !== undefined ? { key: s[1] } : { index: Number(s[2]) });
  }
  return { call: Number(m[1]), steps };
}

/** Every `$ref` object in `args`, at any depth. */
export function findRefs(args: unknown): FoundRef[] {
  const out: FoundRef[] = [];
  const walk = (v: unknown, at: (string | number)[]) => {
    if (isRef(v)) {
      out.push({ at, raw: v.$ref as unknown as string });
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...at, i]));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, [...at, k]);
  };
  walk(args, []);
  return out;
}

export function formatAt(at: (string | number)[]): string {
  return at.map(String).join(".");
}

export type Resolution = { ok: true; value: unknown } | { ok: false; reason: string };

/** Follow a ref's steps into an earlier call's Result. Only a successful call
 *  can be referenced; a missing key or index is a failure, never `undefined`. */
export function resolveRef(ref: ParsedRef, target: Result<unknown>): Resolution {
  if (!target.success) return { ok: false, reason: `call ${ref.call} failed (${target.error.code})` };
  let cur: unknown = target;
  let walked = String(ref.call);
  for (const step of ref.steps) {
    if ("key" in step) {
      walked += `.${step.key}`;
      if (!cur || typeof cur !== "object" || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, step.key)) {
        return { ok: false, reason: `'${walked}' does not exist in call ${ref.call}'s result` };
      }
      cur = (cur as Record<string, unknown>)[step.key];
    } else {
      walked += `[${step.index}]`;
      if (!Array.isArray(cur) || step.index >= cur.length) {
        const len = Array.isArray(cur) ? `it has ${cur.length} item(s)` : "it is not a list";
        return { ok: false, reason: `'${walked}' does not exist in call ${ref.call}'s result: ${len}` };
      }
      cur = cur[step.index];
    }
  }
  if (cur === undefined) return { ok: false, reason: `'${walked}' has no value` };
  return { ok: true, value: cur };
}

/** A copy of `args` with every `$ref` replaced by `values[raw]`. */
export function substitute(args: unknown, values: Map<string, unknown>): unknown {
  if (isRef(args)) return values.get(args.$ref as unknown as string);
  if (Array.isArray(args)) return args.map((v) => substitute(v, values));
  if (args && typeof args === "object") {
    return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, substitute(v, values)]));
  }
  return args;
}
