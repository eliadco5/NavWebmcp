import { NextRequest } from "next/server";
import { isDurable, retentionDays } from "@/lib/audit";
import { AUDIT_SINKS } from "@/lib/audit/sinks";
import { otlpEnabled } from "@/lib/telemetry/otlp";
import { getRedis, isRedisDown } from "@/lib/shared-state/redis";
import { requireAdmin, isResponse } from "@/lib/management/guard";

export const dynamic = "force-dynamic";

// GET /api/admin/health — is the management layer running in a SOC2-worthy
// configuration right now? The main thing to watch: `audit.durable` false
// means audit events are only in this instance's memory.
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req, "admin.health");
  if (isResponse(admin)) return admin;
  const configured = Boolean(process.env.REDIS_URL);
  const connected = Boolean(await getRedis().catch(() => null));
  const durable = await isDurable();
  const warnings: string[] = [];
  if (!configured) warnings.push("REDIS_URL is not set: audit trail, sessions and metrics are in-memory per instance.");
  else if (!connected) warnings.push("Redis is configured but unreachable: running on the in-memory fallback.");
  if (!process.env.AUDIT_HMAC_KEY && !process.env.AUTH_SECRET) warnings.push("Neither AUDIT_HMAC_KEY nor AUTH_SECRET is set: the audit chain uses the insecure default key.");
  if (AUDIT_SINKS.every((s) => !s.enabled())) warnings.push("No audit export sink is configured (AUDIT_WEBHOOK_URL or OTEL_EXPORTER_OTLP_ENDPOINT): no off-platform copy of the audit trail.");
  return Response.json({
    success: true,
    data: {
      redis: { configured, connected, cooldown: isRedisDown() },
      audit: {
        durable,
        retentionDays: retentionDays(),
        hmacKey: process.env.AUDIT_HMAC_KEY ? "AUDIT_HMAC_KEY" : process.env.AUTH_SECRET ? "AUTH_SECRET" : "insecure-default",
        sinks: AUDIT_SINKS.map((s) => ({ name: s.name, enabled: s.enabled() })),
      },
      telemetry: { otlpTraces: otlpEnabled("traces"), otlpMetrics: otlpEnabled("metrics") },
      warnings,
    },
  });
}
