// The SOC2 audit trail: append-only, hash-chained, retained for
// AUDIT_RETENTION_DAYS (default 365).
//
// Storage is a Redis Stream whose entry ids are the chain sequence numbers
// ("<seq>-0"), plus a head key holding "<seq>:<hash>" of the latest event.
// Appends are compare-and-set in one Lua script: write only if the head is
// still what this instance linked against, otherwise re-link and retry. Two
// serverless instances appending at once therefore can't fork the chain.
//
// It is NOT a lib/shared-state descriptor: that machinery snapshots whole
// blobs with last-write-wins and a 24h TTL, which is exactly what an audit
// trail must not do. Without REDIS_URL (local dev, tests) it keeps the same
// chain in memory, and reports itself as non-durable.
import { getRedis } from "@/lib/shared-state/redis";
import { link, verifyEvents, type ChainVerification } from "./chain";
import type { AuditCategory, AuditEvent, AuditEventBody, AuditOutcome } from "./types";

const NAMESPACE = process.env.VERCEL_ENV ?? "dev";
const STREAM_KEY = `webmcp:audit:${NAMESPACE}:v1`;
const HEAD_KEY = `${STREAM_KEY}:head`;
const MAX_CAS_RETRIES = 8;

export function retentionDays(): number {
  const n = Number(process.env.AUDIT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 365;
}

interface Head { seq: number; hash: string }
const EMPTY: Head = { seq: 0, hash: "" };

function encodeHead(h: Head): string {
  return h.seq === 0 ? "" : `${h.seq}:${h.hash}`;
}
function decodeHead(raw: string | null | undefined): Head {
  if (!raw) return EMPTY;
  const i = raw.indexOf(":");
  return { seq: Number(raw.slice(0, i)), hash: raw.slice(i + 1) };
}

// ── Backends ─────────────────────────────────────────────────────────────────

interface Backend {
  durable: boolean;
  head(): Promise<Head>;
  /** Append iff the head is still `expected`. Returns the current head if not. */
  casAppend(expected: Head, event: AuditEvent): Promise<{ ok: true } | { ok: false; head: Head }>;
  /** Events with fromSeq <= seq <= toSeq, oldest first (or newest first when reverse). */
  range(fromSeq: number, toSeq: number, count: number, reverse: boolean): Promise<AuditEvent[]>;
  /** Drop every event with seq < minSeq. Returns how many were dropped. */
  trimBelow(minSeq: number): Promise<number>;
}

declare global {
  // eslint-disable-next-line no-var
  var __auditStore: { events: AuditEvent[]; head: Head; appendsSinceTrim: number } | undefined;
}

function mem() {
  return (globalThis.__auditStore ??= { events: [], head: EMPTY, appendsSinceTrim: 0 });
}

const memoryBackend: Backend = {
  durable: false,
  async head() {
    return mem().head;
  },
  async casAppend(expected, event) {
    const m = mem();
    if (encodeHead(m.head) !== encodeHead(expected)) return { ok: false, head: m.head };
    m.events.push(event);
    m.head = { seq: event.seq, hash: event.hash };
    return { ok: true };
  },
  async range(fromSeq, toSeq, count, reverse) {
    const inRange = mem().events.filter((e) => e.seq >= fromSeq && e.seq <= toSeq);
    return (reverse ? inRange.reverse() : inRange).slice(0, count);
  },
  async trimBelow(minSeq) {
    const m = mem();
    const before = m.events.length;
    m.events = m.events.filter((e) => e.seq >= minSeq);
    return before - m.events.length;
  },
};

const CAS_APPEND = `
local head = redis.call('GET', KEYS[2])
if not head then head = '' end
if head ~= ARGV[1] then return head end
redis.call('XADD', KEYS[1], ARGV[3] .. '-0', 'e', ARGV[4])
redis.call('SET', KEYS[2], ARGV[2])
return 'OK'
`;

type RedisClient = NonNullable<Awaited<ReturnType<typeof getRedis>>>;

function redisBackend(redis: RedisClient): Backend {
  const parseEntries = (entries: { id: string; message: Record<string, string> }[]) =>
    entries.map((x) => JSON.parse(x.message.e) as AuditEvent);
  return {
    durable: true,
    async head() {
      return decodeHead(await redis.get(HEAD_KEY));
    },
    async casAppend(expected, event) {
      const res = await redis.eval(CAS_APPEND, {
        keys: [STREAM_KEY, HEAD_KEY],
        arguments: [encodeHead(expected), encodeHead({ seq: event.seq, hash: event.hash }), String(event.seq), JSON.stringify(event)],
      });
      return res === "OK" ? { ok: true } : { ok: false, head: decodeHead(String(res ?? "")) };
    },
    async range(fromSeq, toSeq, count, reverse) {
      const from = `${Math.max(fromSeq, 0)}-0`;
      const to = `${toSeq}-0`;
      const entries = reverse
        ? await redis.xRevRange(STREAM_KEY, to, from, { COUNT: count })
        : await redis.xRange(STREAM_KEY, from, to, { COUNT: count });
      return parseEntries(entries as { id: string; message: Record<string, string> }[]);
    },
    async trimBelow(minSeq) {
      return Number(await redis.xTrim(STREAM_KEY, "MINID", `${minSeq}-0`));
    },
  };
}

/** Which store is live right now. Redis when configured and reachable. */
async function backend(): Promise<Backend> {
  const redis = await getRedis().catch(() => null);
  return redis ? redisBackend(redis) : memoryBackend;
}

export async function isDurable(): Promise<boolean> {
  return (await backend()).durable;
}

// ── Append ───────────────────────────────────────────────────────────────────

// Serialise appends within an instance: cheaper than losing CAS races to ourselves.
let tail: Promise<unknown> = Promise.resolve();

async function appendTo(b: Backend, body: AuditEventBody): Promise<AuditEvent> {
  let head = await b.head();
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const event = link(body, head);
    const res = await b.casAppend(head, event);
    if (res.ok) return event;
    head = res.head; // another instance appended first: re-link on top of it
  }
  throw new Error("audit append: too much contention");
}

/**
 * Append one event. Never throws: an audit write failing must not fail the
 * business operation that's already happened. If the durable store is down,
 * the event is kept in memory and an error is logged (the management health
 * check reports non-durable mode).
 */
export function appendAuditEvent(body: AuditEventBody): Promise<AuditEvent | null> {
  const run = tail.then(async () => {
    const b = await backend();
    try {
      const event = await appendTo(b, body);
      maybeEnforceRetention(b);
      return event;
    } catch (err) {
      console.error("[audit] durable append failed, keeping event in memory:", err);
      if (b === memoryBackend) return null;
      try {
        return await appendTo(memoryBackend, body);
      } catch {
        return null;
      }
    }
  });
  tail = run.catch(() => undefined);
  return run;
}

// ── Retention ────────────────────────────────────────────────────────────────

const TRIM_EVERY = 500;

function maybeEnforceRetention(b: Backend) {
  const m = mem();
  if (++m.appendsSinceTrim < TRIM_EVERY) return;
  m.appendsSinceTrim = 0;
  void enforceRetentionOn(b)
    .then(({ trimmed, oldestSeq }) => {
      // Removing audit history is itself an auditable act.
      if (trimmed > 0) {
        return appendAuditEvent({
          v: 1,
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          category: "admin",
          action: "audit.retention_trim",
          outcome: "success",
          actor: { type: "system", userId: "system", role: "admin", assurance: "verified" },
          channel: "internal",
          output: { trimmed, oldestSeq, retentionDays: retentionDays() },
        });
      }
    })
    .catch((err) => console.warn("[audit] retention pass failed:", err));
}

/** Remove events older than the retention window. Returns how many went. */
async function enforceRetentionOn(b: Backend, now = Date.now()): Promise<{ trimmed: number; oldestSeq?: number }> {
  const cutoff = now - retentionDays() * 24 * 60 * 60 * 1000;
  const head = await b.head();
  let firstKeep: number | undefined;
  let from = 0;
  while (from <= head.seq) {
    const page = await b.range(from, head.seq, 500, false);
    if (page.length === 0) break;
    const keep = page.find((e) => Date.parse(e.ts) >= cutoff);
    if (keep) { firstKeep = keep.seq; break; }
    from = page[page.length - 1].seq + 1;
  }
  // Everything is expired: keep the newest event so the chain keeps an anchor.
  const minSeq = firstKeep ?? head.seq;
  const trimmed = minSeq > 0 ? await b.trimBelow(minSeq) : 0;
  return { trimmed, oldestSeq: minSeq || undefined };
}

export async function enforceRetention(now = Date.now()) {
  return enforceRetentionOn(await backend(), now);
}

// ── Read ─────────────────────────────────────────────────────────────────────

export interface AuditQuery {
  userId?: string;
  actorType?: "human" | "agent" | "system";
  channel?: string;
  category?: AuditCategory;
  action?: string;
  outcome?: AuditOutcome;
  targetType?: string;
  targetId?: string;
  clientId?: string;
  sessionId?: string;
  requestId?: string;
  since?: string;
  until?: string;
  /** Page backwards from just below this seq (cursor). */
  beforeSeq?: number;
  limit?: number;
}

function matches(e: AuditEvent, q: AuditQuery): boolean {
  return (
    (!q.userId || e.actor.userId === q.userId) &&
    (!q.actorType || e.actor.type === q.actorType) &&
    (!q.channel || e.channel === q.channel) &&
    (!q.category || e.category === q.category) &&
    (!q.action || e.action === q.action) &&
    (!q.outcome || e.outcome === q.outcome) &&
    (!q.targetType || e.target?.type === q.targetType) &&
    (!q.targetId || e.target?.id === q.targetId) &&
    (!q.clientId || e.actor.agent?.clientId === q.clientId) &&
    (!q.sessionId || e.actor.sessionId === q.sessionId) &&
    (!q.requestId || e.requestId === q.requestId) &&
    (!q.since || e.ts >= q.since) &&
    (!q.until || e.ts <= q.until)
  );
}

const SCAN_PAGE = 500;
const SCAN_MAX = 20_000;

/** Newest first. `nextBeforeSeq` is the cursor for the next (older) page. */
export async function queryAudit(q: AuditQuery = {}): Promise<{ events: AuditEvent[]; nextBeforeSeq?: number }> {
  const b = await backend();
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const head = await b.head();
  let to = Math.min(q.beforeSeq !== undefined ? q.beforeSeq - 1 : head.seq, head.seq);
  const out: AuditEvent[] = [];
  let scanned = 0;
  while (to >= 1 && out.length < limit && scanned < SCAN_MAX) {
    const page = await b.range(1, to, SCAN_PAGE, true);
    if (page.length === 0) break;
    for (const e of page) {
      scanned++;
      if (q.since && e.ts < q.since) return { events: out };
      if (matches(e, q)) {
        out.push(e);
        if (out.length === limit) return { events: out, nextBeforeSeq: e.seq };
      }
    }
    to = page[page.length - 1].seq - 1;
  }
  return { events: out, nextBeforeSeq: to >= 1 && scanned >= SCAN_MAX ? to + 1 : undefined };
}

/** Verify the chain over [fromSeq, toSeq] (defaults: everything retained). */
export async function verifyAuditChain(fromSeq = 0, toSeq?: number): Promise<ChainVerification & { durable: boolean }> {
  const b = await backend();
  const head = await b.head();
  const end = Math.min(toSeq ?? head.seq, head.seq);
  const events: AuditEvent[] = [];
  let from = fromSeq;
  while (from <= end) {
    const page = await b.range(from, end, SCAN_PAGE, false);
    if (page.length === 0) break;
    events.push(...page);
    from = page[page.length - 1].seq + 1;
  }
  const result = verifyEvents(events);
  // The newest stored event must be the head, or something was cut off the end.
  if (result.ok && toSeq === undefined && events.length > 0 && events[events.length - 1].hash !== head.hash) {
    const last = events[events.length - 1];
    return { ok: false, checked: events.length, brokenAt: { seq: last.seq, id: last.id, reason: "link_mismatch" }, durable: b.durable };
  }
  return { ...result, durable: b.durable };
}
