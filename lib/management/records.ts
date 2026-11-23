// Long-lived management records (human sessions, agent clients): one Redis
// HASH per kind, field = record id, value = JSON.
//
// Deliberately NOT a descriptor in lib/shared-state/registry.ts: that snapshot
// machinery is last-write-wins across instances and has a 24h TTL with demo
// reseeding. Revocation must stick and must be visible to every instance on the
// next request, so each write here is a single-field HSET that can't clobber
// unrelated records. Falls back to in-process memory without REDIS_URL (local
// dev and tests) — like lib/feature-intros/seen-store.ts.
import { getRedis } from "@/lib/shared-state/redis";

const NAMESPACE = process.env.VERCEL_ENV ?? "dev";
const TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Records are never read-modify-written: a session/client record is written
 * once when created, and the things that change later live in their own
 * hashes keyed by the same id — "ended" (logout / revocation) and "seen"
 * (last activity). So a heartbeat racing an admin's revocation on another
 * instance can't overwrite the revocation with a stale copy.
 * Session ids start "s_" and client ids "c_", so they share those hashes.
 */
export type RecordKind = "sessions" | "clients" | "ended" | "seen" | "software";

function keyFor(kind: RecordKind): string {
  return `webmcp:mgmt:${NAMESPACE}:${kind}`;
}

declare global {
  // eslint-disable-next-line no-var
  var __mgmtRecords: Map<RecordKind, Map<string, string>> | undefined;
}

function memory(kind: RecordKind): Map<string, string> {
  const all = (globalThis.__mgmtRecords ??= new Map());
  if (!all.has(kind)) all.set(kind, new Map());
  return all.get(kind)!;
}

function parse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function getRecord<T>(kind: RecordKind, id: string): Promise<T | null> {
  const redis = await getRedis().catch(() => null);
  if (redis) {
    try {
      return parse<T>(await redis.hGet(keyFor(kind), id));
    } catch (err) {
      console.warn(`[management] read ${kind} failed, using in-process state:`, err);
    }
  }
  return parse<T>(memory(kind).get(id));
}

export async function putRecord<T extends object>(kind: RecordKind, id: string, value: T): Promise<void> {
  const json = JSON.stringify(value);
  memory(kind).set(id, json);
  const redis = await getRedis().catch(() => null);
  if (!redis) return;
  try {
    await redis.multi().hSet(keyFor(kind), id, json).expire(keyFor(kind), TTL_SECONDS).exec();
  } catch (err) {
    console.warn(`[management] write ${kind} failed, kept in-process only:`, err);
  }
}

/** Write only if no record with this id exists yet. Returns true if written. */
export async function putRecordIfAbsent<T extends object>(kind: RecordKind, id: string, value: T): Promise<boolean> {
  const json = JSON.stringify(value);
  const redis = await getRedis().catch(() => null);
  if (redis) {
    try {
      const added = await redis.hSetNX(keyFor(kind), id, json);
      if (added) await redis.expire(keyFor(kind), TTL_SECONDS);
      if (added) memory(kind).set(id, json);
      return Boolean(added);
    } catch (err) {
      console.warn(`[management] write ${kind} failed, kept in-process only:`, err);
    }
  }
  const mem = memory(kind);
  if (mem.has(id)) return false;
  mem.set(id, json);
  return true;
}

/** Every record of a kind as [id, value] pairs. */
export async function listEntries<T>(kind: RecordKind): Promise<[string, T][]> {
  let raw: [string, string][] = [...memory(kind).entries()];
  const redis = await getRedis().catch(() => null);
  if (redis) {
    try {
      raw = Object.entries(await redis.hGetAll(keyFor(kind)));
    } catch (err) {
      console.warn(`[management] list ${kind} failed, using in-process state:`, err);
    }
  }
  const out: [string, T][] = [];
  for (const [id, v] of raw) {
    const parsed = parse<T>(v);
    if (parsed !== null) out.push([id, parsed]);
  }
  return out;
}

export async function listRecords<T>(kind: RecordKind): Promise<T[]> {
  return (await listEntries<T>(kind)).map(([, v]) => v);
}
