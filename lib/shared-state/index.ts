import { AsyncLocalStorage } from "async_hooks";
import { getRedis } from "./redis";
import { withStateLock } from "./mutex";
import { ALL_DESCRIPTORS, type StoreDescriptor } from "./registry";
import { auditLog, type AuditEntry } from "@/lib/auditlog";

// Bump whenever a descriptor's snapshot shape changes incompatibly with what
// might already be sitting in Redis (e.g. lib/store.ts's BookingStoreSnapshot
// gaining tables/bills) — this changes every key's prefix, so old data is
// simply never read instead of crashing restore() on a shape it doesn't
// recognise. Cheap: it's all disposable, TTL'd demo data.
const SCHEMA_VERSION = "2";

// Vercel injects VERCEL_ENV ("production" | "preview" | "development") with zero
// setup. Namespacing by it means a preview deployment and production never share
// a key, even if they're ever pointed at the same Redis instance.
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
  /** descriptor key -> JSON of its snapshot as of the last hydrate/flush. Flush
   *  re-snapshots and skips writing anything that still matches — a read-only
   *  request performs zero Redis writes. Updated in place after each
   *  successful write so a second flush() call in the same request (see
   *  baselineContext below) doesn't re-write what the first one already sent. */
  snapshots: Map<string, string>;
}

// mcp-handler's Streamable HTTP transport resolves the route's Response before
// the tool call that produced it has actually finished running — the body is a
// stream, and the tool executes as part of writing to it, not before headers
// are sent. That means `await mcpHandler(req)` in withSharedState's wrapper can
// resolve (and its `finally` fire) BEFORE registerMcpTools' tool callback (in
// lib/adapters/mcp.ts) has mutated anything, so the wrapper's own flush sees a
// snapshot from before the write and skips it.
//
// The fix mirrors mcpContext in lib/adapters/mcp.ts, which relies on the exact
// same guarantee (role/token ARE correctly visible inside a tool callback
// invoked later in the stream): AsyncLocalStorage context follows the request's
// causal async chain, not Promise resolution order. Storing the baseline here
// lets flushCurrentSharedState() be called from inside the tool callback itself,
// at the moment the mutation is actually known to be complete. withSharedState's
// own finally-flush still runs too, as a no-op-if-unchanged safety net for
// non-streaming callers (app/api/call, app/api/bench/reset) that don't need this.
const baselineContext = new AsyncLocalStorage<HydrationBaseline | null>();

async function hydrate(): Promise<HydrationBaseline | null> {
  const redis = await getRedis();
  if (!redis) return null; // local dev / tests: fall through to today's in-memory behavior

  let results: (string | null)[];
  try {
    const multi = redis.multi();
    for (const d of ALL_DESCRIPTORS) multi.get(keyFor(d.key));
    results = (await multi.exec()) as unknown as (string | null)[];
  } catch (err) {
    // Fail OPEN: a Redis outage degrades to today's per-instance behavior rather
    // than a 500. Stale/local data beats a broken demo.
    console.warn("[shared-state] hydrate failed, using in-process state:", err);
    return null;
  }

  // Each descriptor's restore() is isolated: one incompatible/corrupt key
  // (e.g. leftover data shaped for a since-changed snapshot — SCHEMA_VERSION
  // should prevent this, but restore() isn't the place to find out it didn't)
  // must not take every OTHER store's persistence down with it for the rest of
  // this request. A descriptor that fails just keeps its freshly-seeded
  // in-memory state and gets flushed as-is, same as a missing key would.
  const snapshots = new Map<string, string>();
  ALL_DESCRIPTORS.forEach((d, i) => {
    const raw = results[i];
    try {
      if (raw !== null && raw !== undefined) d.restore(JSON.parse(raw));
    } catch (err) {
      console.warn(`[shared-state] restore failed for "${d.key}", using in-process state:`, err);
    }
    snapshots.set(d.key, JSON.stringify(d.snapshot()));
  });

  return { descriptors: ALL_DESCRIPTORS, snapshots };
}

async function flush(baseline: HydrationBaseline | null): Promise<void> {
  if (!baseline) return;
  const redis = await getRedis();
  if (!redis) return;

  try {
    const multi = redis.multi();
    const pending: { key: string; next: string }[] = [];
    for (const d of baseline.descriptors) {
      const next = JSON.stringify(d.snapshot());
      if (next === baseline.snapshots.get(d.key)) continue; // untouched since last flush
      multi.set(keyFor(d.key), next, { EX: TTL_SECONDS });
      pending.push({ key: d.key, next });
    }
    if (pending.length > 0) {
      await multi.exec();
      // Update in place so a second flush() in the same request (the wrapper's
      // own safety-net flush, after an explicit mid-request one) sees no further
      // diff instead of re-writing the same value.
      for (const p of pending) baseline.snapshots.set(p.key, p.next);
    }
  } catch (err) {
    console.warn("[shared-state] flush failed:", err);
  }
}

/** Wrap a route handler so every shared store is hydrated from Redis before it
 *  runs and flushed back after. A no-op when Redis isn't configured. For
 *  callers whose handler runs a tool asynchronously relative to when its own
 *  Promise resolves (the MCP route), also call flushCurrentSharedState()
 *  explicitly at the true point of completion — see lib/adapters/mcp.ts. */
export function withSharedState<A extends unknown[], R>(
  handler: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return (...args: A) =>
    withStateLock(async () => {
      const baseline = await hydrate();
      return baselineContext.run(baseline, async () => {
        try {
          return await handler(...args);
        } finally {
          await flush(baseline);
        }
      });
    });
}

/** Flush the current request's shared state immediately, using the baseline
 *  hydrate() captured for it. Callable from anywhere within the same request's
 *  async chain (see baselineContext above) — a no-op outside of one. */
export async function flushCurrentSharedState(): Promise<void> {
  const baseline = baselineContext.getStore();
  if (baseline === undefined) return; // not inside a withSharedState() call
  await flush(baseline);
}

/** Dedicated read path for GET /api/audit, which the UI polls every 4s per open
 *  tab (app/providers.tsx). Deliberately bypasses withSharedState entirely: it
 *  must not take the state lock on a hot polling path, and it must not call
 *  restore() (which would overwrite the live in-memory audit log a concurrent
 *  writer on this same instance might be mid-write on). Reads the persisted
 *  blob directly and falls back to in-memory when there's nothing there yet. */
export async function readAuditEntries(): Promise<AuditEntry[]> {
  const redis = await getRedis();
  if (!redis) return auditLog.getEntries();

  try {
    const raw = await redis.get(keyFor("audit"));
    return raw ? JSON.parse(raw) : auditLog.getEntries();
  } catch (err) {
    console.warn("[shared-state] audit read failed, using in-process state:", err);
    return auditLog.getEntries();
  }
}
