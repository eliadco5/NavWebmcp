import crypto from "node:crypto";
import type { AuditEvent } from "@/lib/audit/types";

/**
 * A destination audit events are exported to, for long-term retention and
 * monitoring outside the app (SIEM, log platform). Same shape and failure
 * rule as lib/bugreport/sinks: enabled() is read per run so env changes and
 * tests take effect, and a failing sink is recorded, never thrown.
 *
 * Export happens AFTER the event is durably in the audit store, so a slow or
 * down sink can never lose an event or delay the call that produced it; the
 * store is the system of record and a sink can be back-filled from it.
 */
export interface AuditSink {
  name: string;
  enabled(): boolean;
  send(events: AuditEvent[]): Promise<void>;
}

const TIMEOUT_MS = 3000;

async function post(url: string, body: string, headers: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
}

/** Generic HTTPS webhook (SIEM collectors, Splunk HEC-style endpoints).
 *  Signed with HMAC-SHA256 over the body in `x-navwebmcp-signature`. */
export const webhookSink: AuditSink = {
  name: "webhook",
  enabled: () => Boolean(process.env.AUDIT_WEBHOOK_URL),
  async send(events) {
    const body = JSON.stringify({ events });
    const headers: Record<string, string> = {};
    const secret = process.env.AUDIT_WEBHOOK_SECRET;
    if (secret) headers["x-navwebmcp-signature"] = crypto.createHmac("sha256", secret).update(body).digest("hex");
    await post(process.env.AUDIT_WEBHOOK_URL!, body, headers);
  },
};

function otlpAttr(key: string, value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return { key, value: Number.isInteger(value) ? { intValue: value } : { doubleValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } };
}

/** OTLP/HTTP JSON logs (/v1/logs) — any OpenTelemetry collector. Plain fetch,
 *  no SDK. Enabled by the standard OTEL_EXPORTER_OTLP_ENDPOINT variable. */
export const otlpLogsSink: AuditSink = {
  name: "otlp-logs",
  enabled: () => Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
  async send(events) {
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT!.replace(/\/$/, "");
    const headers: Record<string, string> = {};
    // OTEL_EXPORTER_OTLP_HEADERS: "k1=v1,k2=v2"
    for (const pair of (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
      const i = pair.indexOf("=");
      if (i > 0) headers[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
    }
    const body = {
      resourceLogs: [{
        resource: { attributes: [otlpAttr("service.name", process.env.OTEL_SERVICE_NAME ?? "navwebmcp")] },
        scopeLogs: [{
          scope: { name: "navwebmcp.audit", version: "1" },
          logRecords: events.map((e) => ({
            timeUnixNano: String(Date.parse(e.ts) * 1_000_000),
            severityText: e.outcome === "success" ? "INFO" : "WARN",
            body: { stringValue: `${e.category} ${e.action} ${e.outcome}` },
            attributes: [
              otlpAttr("navwebmcp.audit.seq", e.seq),
              otlpAttr("navwebmcp.audit.hash", e.hash),
              otlpAttr("navwebmcp.audit.id", e.id),
              otlpAttr("navwebmcp.audit.category", e.category),
              otlpAttr("navwebmcp.audit.action", e.action),
              otlpAttr("navwebmcp.audit.outcome", e.outcome),
              otlpAttr("error.type", e.errorCode),
              otlpAttr("enduser.id", e.actor.userId),
              otlpAttr("enduser.role", e.actor.role),
              otlpAttr("navwebmcp.actor.type", e.actor.type),
              otlpAttr("navwebmcp.actor.assurance", e.actor.assurance),
              otlpAttr("navwebmcp.channel", e.channel),
              otlpAttr("gen_ai.agent.id", e.actor.agent?.clientId),
              otlpAttr("gen_ai.agent.name", e.actor.agent?.name),
              otlpAttr("mcp.session.id", e.actor.agent?.sessionId),
              otlpAttr("navwebmcp.target.type", e.target?.type),
              otlpAttr("navwebmcp.target.id", e.target?.id),
              otlpAttr("navwebmcp.request.id", e.requestId),
              otlpAttr("client.address", e.ip),
              otlpAttr("navwebmcp.duration_ms", e.durationMs),
            ].filter(Boolean),
          })),
        }],
      }],
    };
    await post(`${endpoint}/v1/logs`, JSON.stringify(body), headers);
  },
};

export const AUDIT_SINKS: AuditSink[] = [webhookSink, otlpLogsSink];

export interface AuditSinkResult { sink: string; ok: boolean; error?: string }

export async function runAuditSinks(events: AuditEvent[], sinks: AuditSink[] = AUDIT_SINKS): Promise<AuditSinkResult[]> {
  const results: AuditSinkResult[] = [];
  for (const sink of sinks) {
    if (!sink.enabled()) continue;
    try {
      await sink.send(events);
      results.push({ sink: sink.name, ok: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[audit] sink ${sink.name} failed:`, error);
      results.push({ sink: sink.name, ok: false, error });
    }
  }
  return results;
}
