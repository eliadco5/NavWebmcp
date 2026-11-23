// Turns raw metric buckets into the views an operator asks for (PRD §13):
// adoption (who's active, how much is done by agents), usage (which
// operations, through which surface) and efficiency (errors, denials, calls per
// request, latency against the PRD's p99 < 200 ms target).
import { listClients, listSessions } from "@/lib/management/sessions";
import {
  LATENCY_BUCKETS_MS, countActive, parseField, readBuckets, resolutionFor,
  type Bucket, type Resolution,
} from "./metrics";

/** PRD §14a: bridge.call() p99 < 200 ms. */
export const LATENCY_SLO_MS = 200;

type ActorType = "human" | "agent" | "system";
const ACTOR_TYPES: ActorType[] = ["human", "agent", "system"];

interface Acc {
  calls: number;
  top: number;
  errors: number;
  denials: number;
  writes: number;
  ms: number;
  hist: number[];
}
const emptyAcc = (): Acc => ({ calls: 0, top: 0, errors: 0, denials: 0, writes: 0, ms: 0, hist: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0) });

function add(acc: Acc, metric: string, value: number, kind: string, outcome: string) {
  if (metric === "n") {
    acc.calls += value;
    if (outcome === "failure") acc.errors += value;
    if (outcome === "denied") acc.denials += value;
    if (kind === "write") acc.writes += value;
  } else if (metric === "top") acc.top += value;
  else if (metric === "ms") acc.ms += value;
  else if (metric.startsWith("b")) acc.hist[Number(metric.slice(1))] += value;
}

/**
 * Percentile from the fixed-bucket histogram: the upper bound of the bucket
 * the percentile falls in (so "p99 ≤ 100 ms"). `null` when it falls in the
 * open-ended top bucket (> 5 s), or there's no data.
 */
export function percentile(hist: number[], q: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rank = q * total;
  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    cum += hist[i];
    if (cum >= rank) return i < LATENCY_BUCKETS_MS.length ? LATENCY_BUCKETS_MS[i] : null;
  }
  return null;
}

function latency(acc: Acc) {
  return {
    avgMs: acc.calls ? Math.round((acc.ms / acc.calls) * 100) / 100 : null,
    p50Ms: percentile(acc.hist, 0.5),
    p95Ms: percentile(acc.hist, 0.95),
    p99Ms: percentile(acc.hist, 0.99),
  };
}

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 10_000) / 10_000 : 0);

export interface UsageQuery {
  /** ISO or ms; default: 24h ago. */
  from?: string | number;
  /** ISO or ms; default: now. */
  to?: string | number;
  /** Max operations listed (by call count). Default 20. */
  topOperations?: number;
  /** Include live session / agent connection counts. Default true. */
  includeConnections?: boolean;
}

const toMs = (v: string | number | undefined, dflt: number) =>
  v === undefined ? dflt : typeof v === "number" ? v : Date.parse(v);

export async function getUsageSummary(q: UsageQuery = {}, now = Date.now()) {
  const to = toMs(q.to, now);
  const from = toMs(q.from, to - 24 * 3_600_000);
  const resolution: Resolution = resolutionFor(from, to);
  const [buckets, active] = await Promise.all([readBuckets(from, to, resolution), countActive(from, to)]);

  const total = emptyAcc();
  const byActor = Object.fromEntries(ACTOR_TYPES.map((t) => [t, emptyAcc()])) as Record<ActorType, Acc>;
  const byChannel = new Map<string, Acc>();
  const byOp = new Map<string, Acc & { kind: string; actors: Record<ActorType, number> }>();
  const series: { t: string; human: number; agent: number; system: number; errors: number; denials: number }[] = [];

  for (const b of buckets) {
    const point = { t: new Date(b.start).toISOString(), human: 0, agent: 0, system: 0, errors: 0, denials: 0 };
    for (const [field, value] of b.fields) {
      const { dim, metric } = parseField(field);
      const actor = (ACTOR_TYPES.includes(dim.actorType as ActorType) ? dim.actorType : "system") as ActorType;
      add(total, metric, value, dim.kind, dim.outcome);
      add(byActor[actor], metric, value, dim.kind, dim.outcome);
      if (!byChannel.has(dim.channel)) byChannel.set(dim.channel, emptyAcc());
      add(byChannel.get(dim.channel)!, metric, value, dim.kind, dim.outcome);
      if (!byOp.has(dim.operation)) {
        byOp.set(dim.operation, { ...emptyAcc(), kind: dim.kind, actors: { human: 0, agent: 0, system: 0 } });
      }
      const op = byOp.get(dim.operation)!;
      add(op, metric, value, dim.kind, dim.outcome);
      if (metric === "n") {
        op.actors[actor] += value;
        point[actor] += value;
        if (dim.outcome === "failure") point.errors += value;
        if (dim.outcome === "denied") point.denials += value;
      }
    }
    series.push(point);
  }

  const lat = latency(total);
  const connections = q.includeConnections === false ? undefined : await liveConnections(now);

  return {
    range: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), resolution },
    totals: {
      calls: total.calls,
      topLevelCalls: total.top,
      writes: total.writes,
      errors: total.errors,
      denials: total.denials,
      errorRate: ratio(total.errors, total.calls),
      denialRate: ratio(total.denials, total.calls),
      /** Operations run per top-level request (composites and invoke fan out). */
      callsPerRequest: total.top ? Math.round((total.calls / total.top) * 100) / 100 : null,
    },
    adoption: {
      activeUsers: active.users,
      activeAgentClients: active.agentClients,
      /** Share of all writes (mutations) that agents made. */
      agentShareOfWrites: ratio(byActor.agent.writes, total.writes),
      agentShareOfCalls: ratio(byActor.agent.calls, total.calls),
    },
    byActorType: Object.fromEntries(
      ACTOR_TYPES.map((t) => [t, { calls: byActor[t].calls, writes: byActor[t].writes, errors: byActor[t].errors, denials: byActor[t].denials, ...latency(byActor[t]) }])
    ) as Record<ActorType, { calls: number; writes: number; errors: number; denials: number } & ReturnType<typeof latency>>,
    byChannel: Object.fromEntries(
      [...byChannel].map(([ch, a]) => [ch, { calls: a.calls, writes: a.writes, errors: a.errors, denials: a.denials }])
    ),
    operations: [...byOp]
      .map(([operation, a]) => ({
        operation, kind: a.kind, calls: a.calls, errors: a.errors, denials: a.denials,
        byActorType: a.actors, ...latency(a),
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, q.topOperations ?? 20),
    latency: { ...lat, sloMs: LATENCY_SLO_MS, sloMet: lat.p99Ms === null ? total.calls === 0 : lat.p99Ms <= LATENCY_SLO_MS },
    connections,
    series,
  };
}

export type UsageSummary = Awaited<ReturnType<typeof getUsageSummary>>;

/** Live right now: humans signed in and agents connected (last 5 min). */
export async function liveConnections(now = Date.now()) {
  const [sessions, clients] = await Promise.all([listSessions({}, now), listClients({}, now)]);
  return {
    humanSessions: sessions.filter((s) => s.connected).length,
    agentClients: clients.filter((c) => c.connected).length,
  };
}

export type { Bucket };
