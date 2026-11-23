import { NextRequest } from "next/server";
import { auditAdmin } from "@/lib/audit";
import { managementService } from "@/lib/management/service";
import { requireAdmin, isResponse } from "@/lib/management/guard";
import { AuditQuerySchema, issues, paramsToObject } from "@/lib/management/queries";
import type { AuditEvent } from "@/lib/audit/types";

export const dynamic = "force-dynamic";

/** Hard cap on one export, so a huge range can't exhaust the function. */
const MAX_EVENTS = 50_000;

const CSV_COLUMNS: [string, (e: AuditEvent) => unknown][] = [
  ["seq", (e) => e.seq], ["ts", (e) => e.ts], ["category", (e) => e.category], ["action", (e) => e.action],
  ["outcome", (e) => e.outcome], ["errorCode", (e) => e.errorCode], ["actorType", (e) => e.actor.type],
  ["userId", (e) => e.actor.userId], ["role", (e) => e.actor.role], ["assurance", (e) => e.actor.assurance],
  ["agentClientId", (e) => e.actor.agent?.clientId], ["agentName", (e) => e.actor.agent?.name],
  ["sessionId", (e) => e.actor.sessionId], ["channel", (e) => e.channel], ["targetType", (e) => e.target?.type],
  ["targetId", (e) => e.target?.id], ["requestId", (e) => e.requestId], ["callId", (e) => e.callId],
  ["parentCallId", (e) => e.parentCallId], ["ip", (e) => e.ip], ["durationMs", (e) => e.durationMs],
  ["reportedBy", (e) => e.reportedBy], ["id", (e) => e.id], ["prevHash", (e) => e.prevHash], ["hash", (e) => e.hash],
];

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  // Quote, and defuse spreadsheet formula injection (=, +, -, @ at the start).
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// GET /api/admin/audit/export?format=ndjson|csv&<same filters as /api/admin/audit>
// Oldest first, full events (NDJSON) or a flat summary (CSV) with the chain
// hashes, so the export can be checked against the store. Exporting is itself
// an audited act.
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req, "admin.audit_export");
  if (isResponse(admin)) return admin;
  const params = new URLSearchParams(req.nextUrl.searchParams);
  const format = params.get("format") === "csv" ? "csv" : "ndjson";
  params.delete("format");
  const parsed = AuditQuerySchema.omit({ limit: true, beforeSeq: true }).safeParse(paramsToObject(params));
  if (!parsed.success) {
    return Response.json({ success: false, error: { code: "INVALID_INPUT", message: issues(parsed.error) } }, { status: 400 });
  }

  const events: AuditEvent[] = [];
  let beforeSeq: number | undefined;
  do {
    const page = await managementService.queryAudit({ ...parsed.data, limit: 200, beforeSeq });
    events.push(...page.events);
    beforeSeq = page.nextBeforeSeq;
  } while (beforeSeq !== undefined && events.length < MAX_EVENTS);
  events.reverse();
  const truncated = beforeSeq !== undefined;

  await auditAdmin({
    action: "admin.audit_export",
    outcome: "success",
    actor: admin.actor,
    ...admin.info,
    detail: { format, filters: parsed.data, events: events.length, truncated },
  });

  const body = format === "csv"
    ? [CSV_COLUMNS.map(([h]) => h).join(","), ...events.map((e) => CSV_COLUMNS.map(([, f]) => csvCell(f(e))).join(","))].join("\n") + "\n"
    : events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new Response(body, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson",
      "Content-Disposition": `attachment; filename="audit-${stamp}.${format === "csv" ? "csv" : "ndjson"}"`,
      "X-Audit-Events": String(events.length),
      "X-Audit-Truncated": String(truncated),
    },
  });
}
