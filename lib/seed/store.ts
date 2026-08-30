// Shared plumbing for every lib/seed/*.ts factory. Each op file used to declare
// its own `declare global { var __xxx }` + seed literal + `globalThis.__xxx ??
// (globalThis.__xxx = ...)` — duplicated 2-6x per store across ~35 files. This is
// the one place that pattern lives now.

/** Lazily create-or-reuse a value on globalThis, keyed by name. Every call site
 *  across every serverless instance that imports the same factory function gets
 *  the SAME object once it's been created in that instance's process — this is
 *  what makes e.g. crmGuests() in getGuest.ts and searchGuests.ts share one Map. */
export function singleton<T>(key: string, create: () => T): T {
  const g = globalThis as unknown as Record<string, T | undefined>;
  return g[key] ?? (g[key] = create());
}

/** Map-backed store keyed by `key`, built from `build()`'s entries. */
export function singletonMap<K, V>(key: string, build: () => Iterable<[K, V]>): Map<K, V> {
  return singleton(key, () => new Map(build()));
}

/** Reset an existing map-backed store IN PLACE (clear + refill), rather than
 *  replacing the object on globalThis. Every operation file that already
 *  imported this store bound to the same object at module load time — handing
 *  those files a brand new Map here would leave them silently pointed at
 *  stale data instead of the reset one. */
export function resetMap<K, V>(key: string, build: () => Iterable<[K, V]>): void {
  const g = globalThis as unknown as Record<string, Map<K, V> | undefined>;
  const m = g[key];
  if (!m) return; // never touched this request lifetime — nothing to reset
  m.clear();
  for (const [k, v] of build()) m.set(k, v);
}

/** Reset an existing array-backed store IN PLACE — same reasoning as resetMap. */
export function resetArray<T>(key: string, build: () => T[]): void {
  const g = globalThis as unknown as Record<string, T[] | undefined>;
  const arr = g[key];
  if (!arr) return;
  arr.length = 0;
  arr.push(...build());
}

/** Today's date, ISO YYYY-MM-DD, evaluated at call time — not module init. Seed
 *  data that embeds a fixed past date (the original demo data was dated
 *  2026-07-07/08) goes stale the moment "today" moves past it, and looks
 *  especially bad on a serverless deploy where a cold start might happen weeks
 *  after the code was written. Every seed factory computes its dates through
 *  this instead of a literal. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** n days before today, ISO YYYY-MM-DD. */
export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** n days before now, as a full ISO timestamp at a fixed hour/minute — lets seed
 *  rows keep a believable time-of-day instead of all landing on midnight. */
export function isoAt(daysBack: number, hour: number, minute = 0): string {
  const d = new Date(Date.now() - daysBack * 86_400_000);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}
