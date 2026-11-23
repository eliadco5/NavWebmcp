// OpenTelemetry export over OTLP/HTTP JSON with plain fetch (no SDK).
//
// One span per operation call: trace id from the request id, span id from the
// call id, parent from parentCallId — so a composite like `book` shows up as a
// trace with its nested calls underneath. Each flush also sends delta metrics
// (call count and a duration histogram) for the same calls, so dashboards
// work without a span-to-metrics connector.
//
// Enabled by the standard OTEL_EXPORTER_OTLP_ENDPOINT (+ optional
// OTEL_EXPORTER_OTLP_HEADERS, OTEL_SERVICE_NAME); OTEL_TRACES_EXPORTER=none /
// OTEL_METRICS_EXPORTER=none switch either signal off. Export is batched per
// request and runs after the response (next/server after()), so it adds no
// latency to the call and a collector outage loses telemetry, never data.
import crypto from "node:crypto";
import type { CallObservation } from "./port";
import { LATENCY_BUCKETS_MS, dimensionsOf } from "./metrics";

const TIMEOUT_MS = 3000;
const MAX_BATCH = 200;

export function otlpEnabled(signal: "traces" | "metrics"): boolean {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
  const v = signal === "traces" ? process.env.OTEL_TRACES_EXPORTER : process.env.OTEL_METRICS_EXPORTER;
  return v !== "none";
}

/** Lowercase hex of `len` chars derived from an id (uuid → its hex; else a hash). */
function hexId(id: string, len: 32 | 16): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]+$/.test(hex) && hex.length >= len) return hex.slice(0, len);
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, len);
}

type Attr = { key: string; value: Record<string, unknown> };
function attr(key: string, value: unknown): Attr | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return { key, value: Number.isInteger(value) ? { intValue: value } : { doubleValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: String(value) } };
}
const attrs = (...a: (Attr | undefined)[]) => a.filter((x): x is Attr => !!x);

function callAttributes(o: CallObservation) {
  const d = dimensionsOf(o);
  return attrs(
    attr("gen_ai.operation.name", "execute_tool"),
    attr("gen_ai.tool.name", o.operation),
    attr("gen_ai.agent.id", o.actor.agent?.clientId),
    attr("gen_ai.agent.name", o.actor.agent?.name),
    attr("mcp.session.id", o.actor.agent?.sessionId),
    attr("enduser.id", o.actor.userId),
    attr("enduser.role", o.actor.role),
    attr("navwebmcp.actor.type", o.actor.type),
    attr("navwebmcp.actor.assurance", o.actor.assurance),
    attr("navwebmcp.channel", o.meta.channel),
    attr("navwebmcp.operation.kind", d.kind),
    attr("navwebmcp.outcome", d.outcome),
    attr("error.type", o.errorCode),
  );
}

function resource() {
  return { attributes: attrs(attr("service.name", process.env.OTEL_SERVICE_NAME ?? "navwebmcp"), attr("telemetry.sdk.name", "navwebmcp-otlp-fetch")) };
}

export function buildTraces(batch: CallObservation[]) {
  return {
    resourceSpans: [{
      resource: resource(),
      scopeSpans: [{
        scope: { name: "navwebmcp", version: "1" },
        spans: batch.map((o) => ({
          traceId: hexId(o.meta.requestId, 32),
          spanId: hexId(o.meta.callId ?? crypto.randomUUID(), 16),
          ...(o.meta.parentCallId && { parentSpanId: hexId(o.meta.parentCallId, 16) }),
          name: o.operation,
          kind: o.meta.parentCallId ? 1 /* INTERNAL */ : 2 /* SERVER */,
          startTimeUnixNano: String(Math.round(o.startedAt * 1e6)),
          endTimeUnixNano: String(Math.round((o.startedAt + o.durationMs) * 1e6)),
          attributes: callAttributes(o),
          status: o.success ? { code: 1 } : { code: 2, message: o.errorCode ?? "error" },
        })),
      }],
    }],
  };
}

/** Delta metrics for the batch, grouped by the same dimensions as lib/telemetry/metrics.ts. */
export function buildMetrics(batch: CallObservation[], now = Date.now()) {
  const groups = new Map<string, { sample: CallObservation; count: number; sum: number; buckets: number[]; start: number }>();
  for (const o of batch) {
    const d = dimensionsOf(o);
    const key = `${d.operation}|${d.kind}|${d.channel}|${d.actorType}|${d.outcome}`;
    const g = groups.get(key) ?? { sample: o, count: 0, sum: 0, buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), start: o.startedAt };
    g.count++;
    g.sum += o.durationMs;
    const i = LATENCY_BUCKETS_MS.findIndex((b) => o.durationMs <= b);
    g.buckets[i === -1 ? LATENCY_BUCKETS_MS.length : i]++;
    g.start = Math.min(g.start, o.startedAt);
    groups.set(key, g);
  }
  const DELTA = 1;
  const end = String(now * 1e6);
  const points = [...groups.values()];
  const pointAttrs = (o: CallObservation) => {
    const d = dimensionsOf(o);
    return attrs(
      attr("gen_ai.tool.name", d.operation),
      attr("navwebmcp.operation.kind", d.kind),
      attr("navwebmcp.channel", d.channel),
      attr("navwebmcp.actor.type", d.actorType),
      attr("navwebmcp.outcome", d.outcome),
    );
  };
  return {
    resourceMetrics: [{
      resource: resource(),
      scopeMetrics: [{
        scope: { name: "navwebmcp", version: "1" },
        metrics: [
          {
            name: "navwebmcp.calls",
            unit: "{call}",
            description: "Operation calls, by operation, channel, actor type and outcome",
            sum: {
              aggregationTemporality: DELTA,
              isMonotonic: true,
              dataPoints: points.map((g) => ({
                startTimeUnixNano: String(g.start * 1e6), timeUnixNano: end, asInt: String(g.count), attributes: pointAttrs(g.sample),
              })),
            },
          },
          {
            name: "navwebmcp.call.duration",
            unit: "ms",
            description: "Operation call duration",
            histogram: {
              aggregationTemporality: DELTA,
              dataPoints: points.map((g) => ({
                startTimeUnixNano: String(g.start * 1e6), timeUnixNano: end,
                count: String(g.count), sum: g.sum,
                bucketCounts: g.buckets.map(String), explicitBounds: [...LATENCY_BUCKETS_MS],
                attributes: pointAttrs(g.sample),
              })),
            },
          },
        ],
      }],
    }],
  };
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  for (const pair of (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) h[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return h;
}

async function post(path: string, body: unknown) {
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT!.replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OTLP ${path} answered ${res.status}`);
}

// ── Batching ─────────────────────────────────────────────────────────────────

let pending: CallObservation[] = [];
let scheduled = false;

export async function flushOtlp(): Promise<void> {
  scheduled = false;
  const batch = pending.splice(0, pending.length);
  if (batch.length === 0) return;
  const jobs: Promise<void>[] = [];
  if (otlpEnabled("traces")) jobs.push(post("/v1/traces", buildTraces(batch)));
  if (otlpEnabled("metrics")) jobs.push(post("/v1/metrics", buildMetrics(batch)));
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.warn("[telemetry] OTLP export failed:", String(r.reason));
}

/** Queue one call for export. Flushed once after the current request. */
export async function enqueueOtlp(o: CallObservation): Promise<void> {
  if (!otlpEnabled("traces") && !otlpEnabled("metrics")) return;
  pending.push(o);
  if (pending.length >= MAX_BATCH) {
    void flushOtlp();
    return;
  }
  if (scheduled) return;
  scheduled = true;
  try {
    const { after } = await import("next/server");
    after(flushOtlp);
  } catch {
    // Outside a request (tests, scripts): flush on the next tick.
    setTimeout(() => void flushOtlp(), 0);
  }
}
