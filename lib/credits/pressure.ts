// Server load as seen by this instance: how many metered calls are running
// right now against a capacity setting (CREDITS_CAPACITY, default 64). Below
// half capacity there is no pressure; at full capacity grants drop to zero, so
// callers can only continue on the slow refill until load falls.
declare global {
  // eslint-disable-next-line no-var
  var __creditsInFlight: number | undefined;
}

export function capacity(): number {
  const n = Number(process.env.CREDITS_CAPACITY);
  return Number.isFinite(n) && n > 0 ? n : 64;
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

/** 0..1. */
export function pressure(): number {
  const half = capacity() / 2;
  return Math.min(1, Math.max(0, (inFlight() - half) / half));
}
