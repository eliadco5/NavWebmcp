import { getRedis } from "./redis";
import { withStateLock } from "./mutex";
import { ALL_DESCRIPTORS, type StoreDescriptor } from "./registry";
import { auditLog, type AuditEntry } from "@/lib/auditlog";

const SCHEMA_VERSION = "1";

// Vercel injects VERCEL_ENV ("production" | "preview" | "development") with zero
// setup. Namespacing by it means a preview deployment and production never share
// a key, even though the Vercel Marketplace Upstash integration wires the same
// database into both by default.
const NAMESPACE = process.env.VERCEL_ENV ?? "dev";

function keyFor(suffix: string): string {
  return `webmcp:${SCHEMA_VERSION}:${NAMESPACE}:${suffix}`;
}

// Seed data embeds dates relative to "now" (today()/daysAgo()/isoAt() in
// lib/seed/store.ts) so it keeps looking current — but only if it keeps getting
// re-seeded. Once persisted to Redis it stops moving, so a deployment read weeks
// later would show stale dates. A day-long TTL means an idle deployment
// self-heals back to fresh seed data instead of freezing "today" forever.
const TTL_SECONDS = 24 * 60 * 60;

interface HydrationBaseline {
  descriptors: StoreDescriptor[];
  /** descriptor key -> JSON of its snapshot immediately after hydrate. Flush
   *  re-snapshots and skips writing anything that still matches — a read-only
   *  request performs zero Redis writes. */
  snapshots: Map<string, string>;
}

async function hydrate(): Promise<HydrationBaseline | null> {
  const redis = getRedis();
  if (!redis) return null; // local dev / tests: fall through to today's in-memory behavior

  const snapshots = new Map<string, string>();
  try {
    const pipeline = redis.pipeline();
    for (const d of ALL_DESCRIPTORS) pipeline.get(keyFor(d.key));
    const results = await pipeline.exec<unknown[]>();

    ALL_DESCRIPTORS.forEach((d, i) => {
      const raw = results[i];
      // A missing key means "nothing persisted yet" — keep whatever snapshot()
      // just seeded from lib/seed instead of restoring, so the first request
      // also becomes the thing that gets flushed.
      if (raw !== null && raw !== undefined) d.restore(raw);
      snapshots.set(d.key, JSON.stringify(d.snapshot()));
    });
  } catch (err) {
    // Fail OPEN: a Redis outage degrades to today's per-instance behavior rather
    // than a 500. Stale/local data beats a broken demo.
    console.warn("[shared-state] hydrate failed, using in-process state:", err);
    return null;
  }

  return { descriptors: ALL_DESCRIPTORS, snapshots };
}

async function flush(baseline: HydrationBaseline | null): Promise<void> {
  if (!baseline) return;
  const redis = getRedis();
  if (!redis) return;

  try {
    const pipeline = redis.pipeline();
    let writes = 0;
    for (const d of baseline.descriptors) {
      const next = JSON.stringify(d.snapshot());
      if (next === baseline.snapshots.get(d.key)) continue; // untouched this request
      pipeline.set(keyFor(d.key), next, { ex: TTL_SECONDS });
      writes++;
    }
    if (writes > 0) await pipeline.exec();
  } catch (err) {
    console.warn("[shared-state] flush failed:", err);
  }
}

/** Wrap a route handler so every shared store is hydrated from Redis before it
 *  runs and flushed back after — hydrate/flush/handler all under one lock (see
 *  lib/shared-state/mutex.ts). A no-op when Redis isn't configured. */
export function withSharedState<A extends unknown[], R>(
  handler: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return (...args: A) =>
    withStateLock(async () => {
      const baseline = await hydrate();
      try {
        return await handler(...args);
      } finally {
        await flush(baseline);
      }
    });
}

/** Dedicated read path for GET /api/audit, which the UI polls every 4s per open
 *  tab (app/providers.tsx). Deliberately bypasses withSharedState entirely: it
 *  must not take the state lock on a hot polling path, and it must not call
 *  restore() (which would overwrite the live in-memory audit log a concurrent
 *  writer on this same instance might be mid-write on). Reads the persisted
 *  blob directly and falls back to in-memory when there's nothing there yet. */
export async function readAuditEntries(): Promise<AuditEntry[]> {
  const redis = getRedis();
  if (!redis) return auditLog.getEntries();

  try {
    const raw = await redis.get<AuditEntry[]>(keyFor("audit"));
    return raw ?? auditLog.getEntries();
  } catch (err) {
    console.warn("[shared-state] audit read failed, using in-process state:", err);
    return auditLog.getEntries();
  }
}
