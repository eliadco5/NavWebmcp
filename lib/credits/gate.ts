// Request gate: how many requests one caller may have in progress on this
// instance at once, counted from when the request arrives — BEFORE it queues
// for the per-instance state lock (lib/shared-state/mutex.ts).
//
// Why it exists (found by scripts/credits-stress.mjs): state-touching requests
// run one at a time per instance. Credits are checked inside that queue, so a
// caller firing 40 requests at once occupied 40 places in the line, and a
// person clicking in the UI waited behind all of them (p95 ≈ 1.9 s). The gate
// refuses a caller's excess requests at the door, so one caller can only ever
// hold a few places in the line, whatever it sends.
//
// In-process and per instance on purpose: it guards this instance's queue.
// The credit ledger (shared through Redis) still governs the total.
import { creditsEnabled } from "./policy";

export type GateProfile = "agent" | "human";

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** CREDITS_MAX_INFLIGHT_AGENT (default 8), CREDITS_MAX_INFLIGHT_HUMAN (default 16). */
export function gateLimit(profile: GateProfile): number {
  return profile === "agent" ? envInt("CREDITS_MAX_INFLIGHT_AGENT", 8) : envInt("CREDITS_MAX_INFLIGHT_HUMAN", 16);
}

declare global {
  // eslint-disable-next-line no-var
  var __creditsGate: Map<string, number> | undefined;
}
function inflight(): Map<string, number> {
  return (globalThis.__creditsGate ??= new Map());
}

export function gateCount(key: string): number {
  return inflight().get(key) ?? 0;
}

/** What a refused request is told. One sentence, like every credits hint. */
export function gateHint(limit: number): string {
  return `Refused: you already have ${limit} requests in progress on this server. Wait for one to finish before sending another; retry in 1 s.`;
}

/**
 * Run `fn` if `key` has fewer than its limit in progress; otherwise return
 * `refuse(limit)` at once without running anything. Never throws on its own.
 */
export async function withRequestGate<T>(
  key: string,
  profile: GateProfile,
  fn: () => Promise<T>,
  refuse: (limit: number) => T | Promise<T>
): Promise<T> {
  if (!creditsEnabled()) return fn();
  const map = inflight();
  const limit = gateLimit(profile);
  const n = map.get(key) ?? 0;
  if (n >= limit) return refuse(limit);
  map.set(key, n + 1);
  try {
    return await fn();
  } finally {
    release(key);
  }
}

function release(key: string) {
  const map = inflight();
  const left = (map.get(key) ?? 1) - 1;
  if (left <= 0) map.delete(key);
  else map.set(key, left);
}

/** Longest a place is held for one response, whatever happens to its body. */
const RESPONSE_HOLD_MAX_MS = 120_000;

/**
 * Like withRequestGate, but for a route that returns a streamed Response: the
 * place is held until the response body has been fully sent (or cancelled),
 * not just until the handler returns. The MCP transport answers with a stream
 * and does its real work — building the server, running the tool — while
 * writing it, so releasing at "handler returned" would count nothing (the
 * stress test showed 40 parallel requests all admitted).
 */
export async function withResponseGate(
  key: string,
  profile: GateProfile,
  fn: () => Promise<Response>,
  refuse: (limit: number) => Response | Promise<Response>
): Promise<Response> {
  if (!creditsEnabled()) return fn();
  const map = inflight();
  const limit = gateLimit(profile);
  const n = map.get(key) ?? 0;
  if (n >= limit) return refuse(limit);
  map.set(key, n + 1);

  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    clearTimeout(safety);
    release(key);
  };
  const safety = setTimeout(done, RESPONSE_HOLD_MAX_MS);
  (safety as { unref?: () => void }).unref?.();

  let res: Response;
  try {
    res = await fn();
  } catch (err) {
    done();
    throw err;
  }
  if (!res.body) {
    done();
    return res;
  }
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read();
        if (end) {
          controller.close();
          done();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        done();
        controller.error(err);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
