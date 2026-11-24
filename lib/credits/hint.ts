// The piggybacked hint: one plain-language sentence the server adds to a
// result when — and only when — the caller should change what it's doing.
// Written for an agent that has never heard of NavWebMcp credits: it says what
// happened, why, and the one thing to do next. All the wording lives here.

export interface HintInput {
  balance: number;
  window: number;
  charged: number;
  refillPerSec: number;
  durationMs?: number;
  timeCost?: number;
  sizeCost?: number;
  heldMs?: number;
  shrunk?: boolean;
  refused?: { reason: "insufficient" | "frozen" | "busy"; retryAfterMs: number };
}

/** Below this share of the window, results start carrying a hint. */
export const LOW_SHARE = 0.25;

const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
const BATCH = "combine independent reads into one invoke({ calls: [...] }) batch";

/** Seconds of refill until the balance is back to half the window. */
function recoverSecs(i: HintInput): number {
  if (i.refillPerSec <= 0) return 0;
  return Math.max(1, Math.ceil((i.window / 2 - i.balance) / i.refillPerSec));
}

export function needsHint(i: HintInput): boolean {
  return Boolean(i.refused || i.heldMs || i.shrunk || i.balance < 0 || i.balance < i.window * LOW_SHARE);
}

export function hintFor(i: HintInput): string | undefined {
  const bal = `${Math.floor(i.balance)} of ${i.window}`;
  if (i.refused) {
    const wait = secs(i.refused.retryAfterMs);
    switch (i.refused.reason) {
      case "frozen":
        return "Refused: an administrator has paused this agent's access. Don't retry; tell the user.";
      case "busy":
        return `Refused: another call of yours is already waiting for credits. Send calls one at a time; retry in ${wait} s.`;
      default:
        return `Refused: out of credits (${bal} left). Retry in ${wait} s. Calls cost more when they are large or slow; ${BATCH}.`;
    }
  }
  if (!needsHint(i)) return undefined;

  const why: string[] = [];
  if ((i.timeCost ?? 0) > 0 && i.durationMs !== undefined) why.push(`it ran ${Math.max(1, Math.round(i.durationMs / 1000))} s`);
  if ((i.sizeCost ?? 0) > 0) why.push("it returned a large result");
  const cost = `That call cost ${i.charged} credit${i.charged === 1 ? "" : "s"}${why.length ? ` because ${why.join(" and ")}` : ""}`;
  const wait = recoverSecs(i);
  const next = wait > 0 ? `wait ~${wait} s before the next call, or ${BATCH}` : BATCH;

  if (i.heldMs) return `This call waited ${secs(i.heldMs)} s for credits (${bal} left). Slow down: ${next}.`;
  if (i.shrunk) return `${cost}; you can now hold at most ${i.window} credits because your calls run long or cost more than they return. Make fewer, smaller calls; ${next}.`;
  if (i.balance < 0) return `${cost}; your balance is now ${Math.floor(i.balance)} (of ${i.window}). ${next[0].toUpperCase()}${next.slice(1)}.`;
  return `Credits low (${bal}). ${cost}; ${next}.`;
}
