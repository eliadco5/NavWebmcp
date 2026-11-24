// Usage metrics: how the application is used, by people and by agents.
//
// Every operation call increments counters in two time-bucketed Redis hashes
// — per minute (kept 48h, for "right now" views) and per hour (kept 90 days,
// for trends) — keyed by the dimensions an operator slices by:
//   operation | read/write | channel | human/agent/system | outcome
// plus a fixed-bucket latency histogram per dimension, and per-hour
// HyperLogLogs of distinct users and distinct agent clients (adoption).
// All of one call's writes go in a single MULTI round trip.
//
// Like the other management stores it is separate from lib/shared-state's
// 24h demo snapshot, and falls back to in-process memory without REDIS_URL.
import { getRedis } from "@/lib/shared-state/redis";
import type { CallObservation } from "./port";

const NAMESPACE = process.env.VERCEL_ENV ?? "dev";
const PREFIX = `webmcp:metrics:${NAMESPACE}`;
const MINUTE_TTL_S = 48 * 60 * 60;
const HOUR_TTL_S = 90 * 24 * 60 * 60;

/** Upper bounds (ms) of the latency histogram; the last bucket is +Inf. */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 200, 500, 1000, 2500, 5000] as const;

export type Resolution = "minute" | "hour";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** UTC bucket id: YYYYMMDDHHmm (minute) or YYYYMMDDHH (hour). */
export function bucketId(ms: number, res: Resolution): string {
  const d = new Date(ms);
  const hour = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
  return res === "hour" ? hour : `${hour}${pad(d.getUTCMinutes())}`;
}

export function bucketStart(id: string): number {
  const y = +id.slice(0, 4), mo = +id.slice(4, 6) - 1, d = +id.slice(6, 8), h = +id.slice(8, 10);
  const mi = id.length > 10 ? +id.slice(10, 12) : 0;
  return Date.UTC(y, mo, d, h, mi);
}

const STEP_MS: Record<Resolution, number> = { minute: 60_000, hour: 3_600_000 };

const countersKey = (res: Resolution, id: string) => `${PREFIX}:${res === "minute" ? "m" : "h"}:${id}`;
const usersKey = (hourId: string) => `${PREFIX}:users:${hourId}`;
const agentsKey = (hourId: string) => `${PREFIX}:agents:${hourId}`;

export interface Dimensions {
  operation: string;
  kind: "read" | "write";
  channel: string;
  actorType: string;
  outcome: "success" | "failure" | "denied";
}

const SEP = "|";
function dimKey(d: Dimensions): string {
  return [d.operation, d.kind, d.channel, d.actorType, d.outcome].join(SEP);
}
function parseDim(key: string): Dimensions {
  const [operation, kind, channel, actorType, outcome] = key.split(SEP);
  return { operation, kind: kind as Dimensions["kind"], channel, actorType, outcome: outcome as Dimensions["outcome"] };
}

export function latencyBucket(ms: number): number {
  const i = LATENCY_BUCKETS_MS.findIndex((b) => ms <= b);
  return i === -1 ? LATENCY_BUCKETS_MS.length : i;
}

const DENIALS = new Set(["FORBIDDEN", "UNAUTHENTICATED", "CONFIRMATION_DENIED", "INSUFFICIENT_CREDITS", "FANOUT_LIMIT"]);

export function dimensionsOf(o: CallObservation): Dimensions {
  return {
    operation: o.operation,
    kind: o.permission === "write" ? "write" : "read",
    channel: o.meta.channel,
    actorType: o.actor.type,
    outcome: o.success ? "success" : o.errorCode && DENIALS.has(o.errorCode) ? "denied" : "failure",
  };
}

/** Field increments for one call: count, top-level count, latency sum and bucket. */
function increments(o: CallObservation): { ints: [string, number][]; floats: [string, number][] } {
  const d = dimKey(dimensionsOf(o));
  const ints: [string, number][] = [[`${d}#n`, 1], [`${d}#b${latencyBucket(o.durationMs)}`, 1]];
  if (!o.meta.parentCallId) ints.push([`${d}#top`, 1]);
  if (o.credits) ints.push([`${d}#cr`, o.credits]);
  return { ints, floats: [[`${d}#ms`, o.durationMs]] };
}

// ── Memory fallback ──────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __metrics: { hashes: Map<string, Map<string, number>>; sets: Map<string, Set<string>> } | undefined;
}
function mem() {
  return (globalThis.__metrics ??= { hashes: new Map(), sets: new Map() });
}
function memIncr(key: string, field: string, by: number) {
  const h = mem().hashes.get(key) ?? new Map<string, number>();
  h.set(field, (h.get(field) ?? 0) + by);
  mem().hashes.set(key, h);
}
function memAdd(key: string, member: string) {
  const s = mem().sets.get(key) ?? new Set<string>();
  s.add(member);
  mem().sets.set(key, s);
}

// ── Write ────────────────────────────────────────────────────────────────────

/** Record one call. Never throws: metrics are best-effort, unlike the audit trail. */
export async function recordCallMetrics(o: CallObservation): Promise<void> {
  const at = o.startedAt;
  const keys = [countersKey("minute", bucketId(at, "minute")), countersKey("hour", bucketId(at, "hour"))];
  const hourId = bucketId(at, "hour");
  const { ints, floats } = increments(o);
  const agentId = o.actor.type === "agent" ? o.actor.agent?.clientId : undefined;
  const userId = o.actor.type === "system" ? undefined : o.actor.userId;

  const redis = await getRedis().catch(() => null);
  if (redis) {
    try {
      const m = redis.multi();
      for (const key of keys) {
        for (const [f, n] of ints) m.hIncrBy(key, f, n);
        for (const [f, n] of floats) m.hIncrByFloat(key, f, n);
      }
      m.expire(keys[0], MINUTE_TTL_S).expire(keys[1], HOUR_TTL_S);
      if (userId) m.pfAdd(usersKey(hourId), userId).expire(usersKey(hourId), HOUR_TTL_S);
      if (agentId) m.pfAdd(agentsKey(hourId), agentId).expire(agentsKey(hourId), HOUR_TTL_S);
      await m.exec();
      return;
    } catch (err) {
      console.warn("[telemetry] metrics write failed, counting in-process:", err);
    }
  }
  for (const key of keys) {
    for (const [f, n] of [...ints, ...floats]) memIncr(key, f, n);
  }
  if (userId) memAdd(usersKey(hourId), userId);
  if (agentId) memAdd(agentsKey(hourId), agentId);
}

// ── Read ─────────────────────────────────────────────────────────────────────

/** Longest range served from minute buckets; anything longer uses hours. */
const MINUTE_RANGE_MAX_MS = 6 * 3_600_000;
const MAX_RANGE_MS = 90 * 24 * 3_600_000;

export interface Bucket {
  id: string;
  start: number;
  fields: Map<string, number>;
}

export function resolutionFor(fromMs: number, toMs: number): Resolution {
  return toMs - fromMs <= MINUTE_RANGE_MAX_MS ? "minute" : "hour";
}

function bucketIds(fromMs: number, toMs: number, res: Resolution): string[] {
  const step = STEP_MS[res];
  const ids: string[] = [];
  for (let t = Math.floor(fromMs / step) * step; t <= toMs; t += step) ids.push(bucketId(t, res));
  return ids;
}

export async function readBuckets(fromMs: number, toMs: number, res = resolutionFor(fromMs, toMs)): Promise<Bucket[]> {
  const from = Math.max(fromMs, toMs - MAX_RANGE_MS);
  const ids = bucketIds(from, toMs, res);
  const redis = await getRedis().catch(() => null);
  if (redis) {
    try {
      const m = redis.multi();
      for (const id of ids) m.hGetAll(countersKey(res, id));
      const rows = (await m.exec()) as unknown as Record<string, string>[];
      return ids.map((id, i) => ({
        id,
        start: bucketStart(id),
        fields: new Map(Object.entries(rows[i] ?? {}).map(([k, v]) => [k, Number(v)])),
      }));
    } catch (err) {
      console.warn("[telemetry] metrics read failed, using in-process counts:", err);
    }
  }
  return ids.map((id) => ({ id, start: bucketStart(id), fields: new Map(mem().hashes.get(countersKey(res, id)) ?? []) }));
}

/** Distinct users / agent clients active in [from, to], hour granularity. */
export async function countActive(fromMs: number, toMs: number): Promise<{ users: number; agentClients: number }> {
  const hours = bucketIds(Math.max(fromMs, toMs - MAX_RANGE_MS), toMs, "hour");
  const redis = await getRedis().catch(() => null);
  if (redis) {
    try {
      const [users, agents] = await Promise.all([
        redis.pfCount(hours.map(usersKey)),
        redis.pfCount(hours.map(agentsKey)),
      ]);
      return { users: Number(users), agentClients: Number(agents) };
    } catch (err) {
      console.warn("[telemetry] active-count read failed, using in-process sets:", err);
    }
  }
  const union = (keyOf: (h: string) => string) => {
    const s = new Set<string>();
    for (const h of hours) for (const v of mem().sets.get(keyOf(h)) ?? []) s.add(v);
    return s.size;
  };
  return { users: union(usersKey), agentClients: union(agentsKey) };
}

/** Split "<dim>#<metric>" back into its parts. */
export function parseField(field: string): { dim: Dimensions; metric: string } {
  const i = field.lastIndexOf("#");
  return { dim: parseDim(field.slice(0, i)), metric: field.slice(i + 1) };
}
