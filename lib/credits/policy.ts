// Credit policy: who is metered how strictly, and what a call costs.
//
// Modeled on SMB2/3 credits (docs/credits.md): a request's charge grows with
// its size and with the number of operations it carries; the server decides
// how many credits to hand back on each response. On top of SMB we charge by
// operation type and by time spent running, so long calls cost more.
import type { Actor, Operation } from "@/lib/operations/types";

export type ProfileName = "agent" | "human";

export interface Profile {
  initialWindow: number;
  minWindow: number;
  maxWindow: number;
  /** Trickle refill toward the window, credits per second (starvation guard). */
  refillPerSec: number;
  /** Bytes per credit, request and response. */
  sizeUnit: number;
  /** Run time is charged `timeRate` credits per started `timeUnitMs`. */
  timeUnitMs: number;
  timeRate: number;
  /** A call longer than this halves the window. */
  longCallMs: number;
  /** Backpressure: hold a call up to this long for refill before refusing. */
  maxHoldMs: number;
}

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Defaults, each overridable as CREDITS_<PROFILE>_<FIELD>, e.g. CREDITS_AGENT_MAX_WINDOW. */
const DEFAULTS: Record<ProfileName, Profile> = {
  agent: {
    initialWindow: 16,
    minWindow: 2,
    maxWindow: 64,
    refillPerSec: 2,
    sizeUnit: 4096,
    timeUnitMs: 1000,
    timeRate: 1,
    longCallMs: 3000,
    maxHoldMs: 1500,
  },
  human: {
    initialWindow: 128,
    minWindow: 32,
    maxWindow: 512,
    refillPerSec: 20,
    sizeUnit: 16384,
    timeUnitMs: 1000,
    timeRate: 0,
    longCallMs: 10_000,
    maxHoldMs: 1000,
  },
};

const ENV_FIELD: Record<keyof Profile, string> = {
  initialWindow: "INITIAL_WINDOW",
  minWindow: "MIN_WINDOW",
  maxWindow: "MAX_WINDOW",
  refillPerSec: "REFILL_PER_SEC",
  sizeUnit: "SIZE_UNIT",
  timeUnitMs: "TIME_UNIT_MS",
  timeRate: "TIME_RATE",
  longCallMs: "LONG_CALL_MS",
  maxHoldMs: "MAX_HOLD_MS",
};

export function profile(name: ProfileName): Profile {
  const base = DEFAULTS[name];
  const out = { ...base };
  for (const k of Object.keys(base) as (keyof Profile)[]) {
    out[k] = envNum(`CREDITS_${name.toUpperCase()}_${ENV_FIELD[k]}`, base[k]);
  }
  out.sizeUnit = Math.max(1, out.sizeUnit);
  out.timeUnitMs = Math.max(1, out.timeUnitMs);
  out.minWindow = Math.max(1, out.minWindow);
  out.maxWindow = Math.max(out.minWindow, out.maxWindow);
  out.initialWindow = Math.min(out.maxWindow, Math.max(out.minWindow, out.initialWindow));
  return out;
}

/** CREDITS_ENABLED=false turns metering off entirely (default: on). */
export function creditsEnabled(): boolean {
  return process.env.CREDITS_ENABLED !== "false";
}

export interface Principal {
  /** Ledger key: one per agent client, one per human user. */
  key: string;
  profile: ProfileName;
}

/** Who pays for a call. System actors (seed data, scripts) are never metered. */
export function principalOf(actor: Actor): Principal | null {
  if (actor.type === "system") return null;
  if (actor.type === "agent") return { key: `a:${actor.agent?.clientId ?? actor.userId}`, profile: "agent" };
  return { key: `h:${actor.userId}`, profile: "human" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOp = Operation<any, any>;

/** Base weight of one operation: read 1, write 2, unless the op declares its own. */
export function weightOf(op: AnyOp | undefined): number {
  if (!op) return 1; // unknown names still cost something
  if (op.credits?.weight !== undefined) return op.credits.weight;
  return op.permission === "write" ? 2 : 1;
}

export function bytesOf(value: unknown): number {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return 0;
  }
}

/**
 * The up-front charge for a call (SMB's CreditCharge): op weight plus size.
 * For a dispatching op (invoke) the weight is the sum of what it will run,
 * read from its args, so a 50-call batch can't pass for one call. `estimatedOps`
 * is what settle compares the actual nested count against.
 */
export function chargeFor(
  op: AnyOp | undefined,
  args: Record<string, unknown>,
  lookup: (name: string) => AnyOp | undefined,
  p: Profile
): { charge: number; weight: number; estimatedOps: number } {
  let weight = weightOf(op);
  let estimatedOps = 0;
  if (op?.dispatchesOps) {
    const single = typeof args.name === "string" ? [args.name] : [];
    const batch = Array.isArray(args.calls)
      ? (args.calls as unknown[]).map((c) => (c && typeof c === "object" ? (c as { name?: unknown }).name : undefined))
      : [];
    const names = [...single, ...batch].filter((n): n is string => typeof n === "string");
    // Each dispatched op, plus whatever a composite among them runs itself.
    estimatedOps = names.reduce((sum, n) => sum + 1 + (lookup(n)?.credits?.weight ?? 0), 0);
    weight = Math.max(weight, names.reduce((sum, n) => sum + weightOf(lookup(n)), 0));
  } else if (op?.credits?.weight !== undefined) {
    // A composite declares the number of operations it runs as its weight.
    estimatedOps = op.credits.weight;
  }
  // Like SMB's CreditCharge, a request that fits in one size unit pays no size
  // cost; every further unit costs one more. Every request also pays a fixed
  // REQUEST_COST, which is what makes one invoke batch cheaper than the same
  // calls sent one by one.
  const charge = REQUEST_COST + weight + Math.floor(bytesOf(args) / p.sizeUnit);
  return { charge, weight, estimatedOps };
}

/** Fixed per-request overhead, paid once per top-level call. */
export const REQUEST_COST = 1;

/** Cost found only after the call ran: response size, run time, unplanned nested ops. */
export function extraFor(
  outcome: { durationMs: number; responseBytes: number; nestedOps: number },
  estimatedOps: number,
  weight: number,
  p: Profile
): { extra: number; sizeCost: number; timeCost: number; opsCost: number } {
  const sizeCost = Math.floor(outcome.responseBytes / p.sizeUnit);
  const timeCost = Math.floor(outcome.durationMs / p.timeUnitMs) * p.timeRate;
  // Nested ops nobody declared up front (a composite inside a batch, say) cost
  // one each beyond the estimate; the declared ones are already in `weight`.
  const opsCost = Math.max(0, outcome.nestedOps - Math.max(estimatedOps, weight));
  return { extra: sizeCost + timeCost + opsCost, sizeCost, timeCost, opsCost };
}
