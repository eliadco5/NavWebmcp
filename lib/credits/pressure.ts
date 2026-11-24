// Server load as seen by this instance, 0..1. It drives how many credits a
// response hands back (SMB's server-controlled CreditResponse): at 0 a call's
// cost comes straight back, at 1 nothing does and callers live on the slow
// trickle.
//
// Two signals, whichever is worse:
//   - in-flight: metered calls running right now vs CREDITS_CAPACITY (64).
//     Below half capacity no pressure; at capacity full pressure.
//   - event-loop lag: how late timers fire. A Node instance saturated with
//     requests (the stress test's 40-way flood) has few calls *in flight* at
//     any instant — each runs to completion quickly — but every request waits
//     in line for the CPU. Lag is what everybody else feels, so it's what
//     must make heavy callers slow down. CREDITS_LAG_LOW_MS (50) → 0,
//     CREDITS_LAG_HIGH_MS (400) → 1. A quiet server's GC and JIT pauses
//     stay under 50 ms, so they don't trim anyone's grants.
declare global {
  // eslint-disable-next-line no-var
  var __creditsInFlight: number | undefined;
  // eslint-disable-next-line no-var
  var __creditsLag: { lagMs: number; timer?: ReturnType<typeof setInterval> } | undefined;
}

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function capacity(): number {
  return envNum("CREDITS_CAPACITY", 64);
}

export function enter(): void {
  globalThis.__creditsInFlight = (globalThis.__creditsInFlight ?? 0) + 1;
}

export function leave(): void {
  globalThis.__creditsInFlight = Math.max(0, (globalThis.__creditsInFlight ?? 0) - 1);
}

export function inFlight(): number {
  return globalThis.__creditsInFlight ?? 0;
}

const SAMPLE_MS = 50;

/**
 * Start sampling event-loop lag (idempotent). A 50 ms interval measures how
 * late it fires; the reading decays smoothly (EWMA) so one slow tick doesn't
 * swing grants. Unref'd: never keeps the process alive.
 */
export function startLagMonitor(): void {
  if (globalThis.__creditsLag?.timer || typeof setInterval !== "function") return;
  const state = (globalThis.__creditsLag ??= { lagMs: 0 });
  let last = Date.now();
  state.timer = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - last - SAMPLE_MS);
    last = now;
    // Rise fast, fall slower.
    const alpha = lag > state.lagMs ? 0.25 : 0.1;
    state.lagMs = state.lagMs + alpha * (lag - state.lagMs);
  }, SAMPLE_MS);
  (state.timer as { unref?: () => void }).unref?.();
}

export function lagMs(): number {
  return globalThis.__creditsLag?.lagMs ?? 0;
}

/** Test hook: pretend the loop is this late. */
export function setLagForTests(ms: number): void {
  (globalThis.__creditsLag ??= { lagMs: 0 }).lagMs = ms;
}

// ── Fair share ───────────────────────────────────────────────────────────────
//
// Load is caused by someone. Applying the same pressure to every caller would
// make a quiet agent pay for a noisy one (the stress test: 20 busy agents
// drove everyone to 18 % success). So each caller's pressure is scaled by its
// share of recent traffic: at or below the fair share (total ÷ active callers)
// it feels pressure in proportion, and a caller sending 10× the fair share
// feels all of it.

const RATE_HALF_LIFE_MS = 5000;
const ACTIVE_MS = 15_000;
const RATE_MAP_MAX = 10_000;

declare global {
  // eslint-disable-next-line no-var
  var __creditsRates: Map<string, { rate: number; at: number }> | undefined;
}
function rates() {
  return (globalThis.__creditsRates ??= new Map());
}

function decayed(r: { rate: number; at: number }, now: number): number {
  return r.rate * Math.pow(0.5, Math.max(0, now - r.at) / RATE_HALF_LIFE_MS);
}

/** Count one call for this caller (an exponentially decaying calls-per-window). */
export function noteCall(key: string, now = Date.now()): void {
  const m = rates();
  const cur = m.get(key);
  const rate = (cur ? decayed(cur, now) : 0) + 1;
  m.delete(key); // LRU order
  m.set(key, { rate, at: now });
  while (m.size > RATE_MAP_MAX) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

/** This caller's share of recent traffic relative to the fair share; 0..1. */
export function shareFactor(key: string, now = Date.now()): number {
  let total = 0;
  let active = 0;
  let mine = 0;
  for (const [k, r] of rates()) {
    if (now - r.at > ACTIVE_MS) continue;
    const v = decayed(r, now);
    total += v;
    active++;
    if (k === key) mine = v;
  }
  if (active <= 1 || total <= 0) return 1; // alone: it is the load
  const fair = total / active;
  return Math.min(1, mine / fair);
}

/** The pressure this caller feels: instance pressure × its share. */
export function pressureFor(key: string, now = Date.now()): number {
  return pressure() * shareFactor(key, now);
}

/** 0..1. */
export function pressure(): number {
  const half = capacity() / 2;
  const inflightP = Math.min(1, Math.max(0, (inFlight() - half) / half));
  const low = envNum("CREDITS_LAG_LOW_MS", 50);
  const high = Math.max(low + 1, envNum("CREDITS_LAG_HIGH_MS", 400));
  const lagP = Math.min(1, Math.max(0, (lagMs() - low) / (high - low)));
  return Math.max(inflightP, lagP);
}
