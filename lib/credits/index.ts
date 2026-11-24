// NavWebMcp credits (docs/credits.md): SMB-style flow control for every
// top-level operation call. Importing this module from a server entry point
// turns it on for execute() via ./port.ts.
//
//   admit  → reserve the up-front charge (op weight + request size); if short,
//            hold briefly for refill (backpressure), else refuse with a hint
//   finish → settle the real cost (response size, run time, nested ops),
//            adapt the window, grant credits back scaled by server load
import { getOpByName } from "@/lib/operations/execute";
import { isStateLockHeld } from "@/lib/shared-state/mutex";
import type { Actor } from "@/lib/operations/types";
import { installCredits, type Admission, type AdmitRequest, type CreditInfo, type CreditSnapshot, type CreditsPort } from "./port";
import { chargeFor, creditsEnabled, extraFor, principalOf, profile, REQUEST_COST, type Profile } from "./policy";
import { effectiveProfile, freshLedger, getLedger, noteRefusal, refill, reserve, settle, updateLedger, type Ledger } from "./ledger";
import { hintFor, needsHint } from "./hint";
import { enter, leave, noteCall, pressureFor, startLagMonitor } from "./pressure";

export { listCreditLedgers, setCreditPolicy, type CreditLedgerView } from "./admin";

/** Mutable so tests can make backpressure instant. */
export const creditTuning = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

/** Retry-After for a caller that can't recover within a minute (deep debt, no refill). */
const MAX_RETRY_AFTER_MS = 60_000;

declare global {
  // eslint-disable-next-line no-var
  var __creditsHeld: Set<string> | undefined;
}
/** Principals with a call currently held for refill on this instance (one each). */
function heldSet(): Set<string> {
  return (globalThis.__creditsHeld ??= new Set());
}

const UNMETERED: Admission = { admitted: true, finish: async () => null };

type Attempt = { ok: true; reserved: number; holdId: string; p: Profile } | { ok: false; ledger: Ledger; p: Profile; waitMs: number; reason: "insufficient" | "frozen" };

async function tryReserve(key: string, base: Profile, charge: number, now: number): Promise<Attempt> {
  return updateLedger(key, (cur, override) => {
    const p = effectiveProfile(base, override);
    const r = reserve(cur ?? freshLedger(p, now), charge, p, now, override?.frozen);
    const value: Attempt = r.ok ? { ok: true, reserved: r.reserved, holdId: r.holdId, p } : { ok: false, ledger: r.ledger, p, waitMs: r.waitMs, reason: r.reason };
    return { next: r.ledger, value };
  });
}

async function refuse(
  key: string,
  a: Extract<Attempt, { ok: false }>,
  reason: "insufficient" | "frozen" | "busy",
  charge: number
): Promise<Admission> {
  // Frozen refusals are already counted by reserve().
  if (a.reason !== "frozen") await updateLedger(key, (cur) => ({ next: noteRefusal(cur ?? a.ledger, Date.now()), value: undefined }));
  const retryAfterMs = reason === "frozen" ? undefined : Math.min(MAX_RETRY_AFTER_MS, Number.isFinite(a.waitMs) ? Math.max(a.waitMs, 250) : MAX_RETRY_AFTER_MS);
  const base = { balance: Math.floor(a.ledger.balance), window: a.ledger.window, charged: 0, granted: 0 };
  const credits: CreditInfo = {
    ...base,
    ...(retryAfterMs !== undefined && { retryAfterMs }),
    hint: hintFor({ ...base, charged: charge, refillPerSec: a.p.refillPerSec, refused: { reason, retryAfterMs: retryAfterMs ?? 0 } }),
  };
  return { admitted: false, credits };
}

async function admitInner(req: AdmitRequest): Promise<Admission> {
  if (!creditsEnabled()) return UNMETERED;
  const principal = principalOf(req.actor);
  if (!principal) return UNMETERED;

  noteCall(principal.key);
  const base = profile(principal.profile);
  const lookup = (n: string) => getOpByName().get(n);
  const { charge, weight, estimatedOps } = chargeFor(req.op, req.args, lookup, base);

  let attempt = await tryReserve(principal.key, base, charge, Date.now());
  let heldMs = 0;
  if (!attempt.ok && attempt.reason === "insufficient") {
    const held = heldSet();
    // Backpressure: wait for the trickle instead of refusing — but never while
    // holding the per-instance state lock (that would stall every request on
    // this instance), and only one held call per caller at a time.
    const canHold = attempt.waitMs <= attempt.p.maxHoldMs && !isStateLockHeld();
    if (canHold && held.has(principal.key)) return refuse(principal.key, attempt, "busy", charge);
    if (canHold) {
      held.add(principal.key);
      const started = Date.now();
      try {
        await creditTuning.sleep(attempt.waitMs);
        attempt = await tryReserve(principal.key, base, charge, Date.now());
      } finally {
        held.delete(principal.key);
      }
      heldMs = Date.now() - started;
    }
  }
  if (!attempt.ok) return refuse(principal.key, attempt, attempt.reason, charge);

  const { reserved, holdId, p } = attempt;
  enter();
  let finished = false;
  return {
    admitted: true,
    async finish(outcome) {
      if (finished) return null;
      finished = true;
      // Load scaled by this caller's share of recent traffic (pressure.ts).
      const load = pressureFor(principal.key);
      leave();
      const cost = extraFor(outcome, estimatedOps, weight, p);
      try {
        const now = Date.now();
        const s = await updateLedger(principal.key, (cur, override) => {
          const pp = effectiveProfile(base, override);
          const r = settle(cur ?? freshLedger(pp, now), { reserved, holdId, extra: cost.extra, durationMs: outcome.durationMs, creditRequest: req.meta.creditRequest, pressure: load }, pp, now);
          return { next: r.ledger, value: { ...r, pp } };
        });
        const info = {
          balance: Math.floor(s.ledger.balance),
          window: s.ledger.window,
          charged: reserved + cost.extra,
          granted: s.granted,
          ...(heldMs > 0 && { heldMs }),
        };
        const hintIn = {
          ...info,
          balance: s.ledger.balance,
          refillPerSec: s.pp.refillPerSec,
          durationMs: outcome.durationMs,
          timeCost: cost.timeCost,
          sizeCost: cost.sizeCost,
          opsCost: cost.opsCost,
          heldMs: heldMs || undefined,
          shrunk: s.shrunk,
        };
        const hinted = needsHint(hintIn);
        return { ...info, ...(hinted && { hint: hintFor(hintIn) }), hinted };
      } catch (err) {
        console.warn("[credits] settle failed:", err);
        return null;
      }
    },
  };
}

/**
 * Admission, failing OPEN on an unexpected error. Metering protects
 * availability; a bug in it must never be what makes the app unreachable. The
 * storage layer already falls back to memory on Redis errors, so this only
 * catches genuine defects — logged loudly.
 */
export async function admit(req: AdmitRequest): Promise<Admission> {
  try {
    return await admitInner(req);
  } catch (err) {
    console.error("[credits] admission failed, letting the call through unmetered:", err);
    return UNMETERED;
  }
}

export async function peek(actor: Actor): Promise<CreditSnapshot | null> {
  if (!creditsEnabled()) return null;
  const principal = principalOf(actor);
  if (!principal) return null;
  const { ledger, override } = await getLedger(principal.key);
  const p = effectiveProfile(profile(principal.profile), override);
  const now = Date.now();
  const l = refill(ledger ?? freshLedger(p, now), p, now);
  return { balance: Math.floor(l.balance), window: l.window, maxWindow: p.maxWindow, refillPerSec: p.refillPerSec, frozen: Boolean(override?.frozen) };
}

/**
 * Cheap refusal at the door, before a route does any expensive work (the MCP
 * transport builds a whole server per request; a refusal inside execute()
 * would still pay for that). Refuses only what admit() would certainly
 * refuse for any call: a frozen caller, or one whose balance can't cover even
 * the cheapest call (REQUEST_COST + 1) within the hold time. Fails open.
 */
export async function quickRefusal(principalKey: string, profileName: "agent" | "human"): Promise<CreditInfo | null> {
  if (!creditsEnabled()) return null;
  try {
    const now = Date.now();
    const { ledger, override } = await getLedger(principalKey);
    if (!ledger && !override?.frozen) return null;
    const p = effectiveProfile(profile(profileName), override);
    const l = refill(ledger ?? freshLedger(p, now), p, now);
    const cheapest = REQUEST_COST + 1;
    if (override?.frozen) {
      noteCall(principalKey);
      const a = { ok: false as const, ledger: l, p, waitMs: 0, reason: "frozen" as const };
      return ((await refuse(principalKey, a, "frozen", cheapest)) as { credits: CreditInfo }).credits;
    }
    if (l.balance >= cheapest) return null;
    const waitMs = p.refillPerSec > 0 ? Math.ceil(((cheapest - l.balance) / p.refillPerSec) * 1000) : Number.POSITIVE_INFINITY;
    if (waitMs <= p.maxHoldMs) return null; // admit() may hold and then run it
    noteCall(principalKey);
    const a = { ok: false as const, ledger: l, p, waitMs, reason: "insufficient" as const };
    return ((await refuse(principalKey, a, "insufficient", cheapest)) as { credits: CreditInfo }).credits;
  } catch (err) {
    console.error("[credits] quick check failed, letting the request in:", err);
    return null;
  }
}

export const creditsPort: CreditsPort = { admit, peek };

if (!process.env.VITEST) startLagMonitor();

installCredits(creditsPort);
