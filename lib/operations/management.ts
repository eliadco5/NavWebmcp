// admin.* — the management layer as operations, so an admin's agent can answer
// "who created this reservation, a person or an agent?", check usage, and
// disconnect a misbehaving agent, through the same registry, RBAC and audit as
// every other op. Admin only.
//
// The handlers reach the server-side service through lib/management/port.ts
// (this file is bundled into the browser along with the rest of the registry).
import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { management } from "@/lib/management/port";
import { AuditQueryShape, UsageQueryShape } from "@/lib/management/queries";
import { Id } from "./schemas";
import type { OperationContext } from "./types";

function svc() {
  return management();
}
// HANDLER_ERROR, not a new code: a new error code would be a protocol (MINOR) change.
const UNAVAILABLE = () => fail("HANDLER_ERROR", "The management service isn't available on this surface.");

// ── Output schemas (factories: one shared instance would be emitted as a $ref) ──

const ActorOut = () => z.object({
  type: z.enum(["human", "agent", "system"]),
  userId: z.string().describe("Accountable user (for agents: who authorised it)"),
  role: z.enum(["customer", "support", "admin"]),
  assurance: z.enum(["verified", "asserted"]).describe("verified = server-issued agent token; asserted = declared by the browser"),
  sessionId: z.string().optional(),
  agent: z.object({
    clientId: z.string(),
    name: z.string().optional(),
    version: z.string().optional(),
    sessionId: z.string().optional(),
  }).optional(),
});

const AuditEventOut = () => z.object({
  v: z.literal(1),
  seq: z.number().int(),
  id: z.string(),
  ts: z.string(),
  category: z.enum(["operation", "auth", "admin"]),
  action: z.string(),
  outcome: z.enum(["success", "failure", "denied"]),
  errorCode: z.string().optional(),
  actor: ActorOut(),
  channel: z.enum(["ui", "webmcp", "mcp", "internal"]),
  requestId: z.string().optional(),
  callId: z.string().optional(),
  parentCallId: z.string().optional(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  target: z.object({ type: z.string(), id: z.string() }).optional(),
  input: z.unknown().optional().describe("Redacted"),
  output: z.unknown().optional().describe("Redacted"),
  durationMs: z.number().optional(),
  reportedBy: z.literal("client").optional(),
  prevHash: z.string(),
  hash: z.string(),
});

const Liveness = {
  lastSeenAt: z.string().optional(),
  endedAt: z.string().optional(),
  endReason: z.enum(["logout", "revoked"]).optional(),
  endedBy: z.string().optional(),
  connected: z.boolean().describe("Not ended and active in the last 5 minutes"),
};

const SessionOut = () => z.object({
  sid: z.string(),
  userId: z.string(),
  role: z.enum(["customer", "support", "admin"]),
  startedAt: z.string(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  provisioned: z.boolean().optional(),
  ...Liveness,
});

const ClientOut = () => z.object({
  clientId: z.string(),
  userId: z.string(),
  role: z.enum(["customer", "support", "admin"]),
  kind: z.enum(["default", "connected", "legacy"]),
  label: z.string().optional(),
  sid: z.string().optional(),
  createdAt: z.string(),
  agentName: z.string().optional(),
  agentVersion: z.string().optional(),
  ...Liveness,
});

const Latency = () => ({
  avgMs: z.number().nullable(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  p99Ms: z.number().nullable(),
});
const ActorUsage = () => z.object({ calls: z.number(), writes: z.number(), errors: z.number(), denials: z.number(), ...Latency() });

/** Drop undefined so the wire shape has no explicit-undefined keys. */
const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ── Operations ───────────────────────────────────────────────────────────────

export const queryAuditOp = defineOperation({
  name: "queryAudit",
  title: "Query Audit Trail",
  description:
    "Search the tamper-evident audit trail, newest first. Filter by who (userId, actorType human/agent/system, " +
    "agent clientId, sessionId), how (channel ui/webmcp/mcp), what (category operation/auth/admin, action, " +
    "outcome success/failure/denied), which record (targetType + targetId) and when (since/until). Page with " +
    "beforeSeq = the previous nextBeforeSeq. Inputs/outputs are redacted. Admin only.",
  permission: "read",
  roles: ["admin"],
  module: "admin.audit",
  inputSchema: AuditQueryShape,
  outputSchema: {
    count: z.number().int(),
    events: z.array(AuditEventOut()),
    nextBeforeSeq: z.number().int().optional().describe("Pass as beforeSeq for the next (older) page"),
  },
  untrustedOutput: true,
  audit: { target: () => null },
  async handler(input, _ctx) {
    const s = svc();
    if (!s) return UNAVAILABLE();
    const { events, nextBeforeSeq } = await s.queryAudit(input);
    return ok(clean({ count: events.length, events, ...(nextBeforeSeq !== undefined && { nextBeforeSeq }) }) as never);
  },
});

export const getEntityHistory = defineOperation({
  name: "getEntityHistory",
  title: "Get Record History",
  description:
    "Everything that happened to one record (e.g. type 'reservation', id 'res_…'), oldest first, and who created " +
    "it: a person in the app, or an agent acting for them (which agent, through which surface). Answers " +
    "\"who created / changed / cancelled this?\". Admin only.",
  permission: "read",
  roles: ["admin"],
  module: "admin.audit",
  inputSchema: {
    type: z.string().min(1).max(40).describe("Record type: reservation, guest, task, payment, adjustment, session, agentClient, …"),
    id: Id().describe("Record id"),
  },
  outputSchema: {
    target: z.object({ type: z.string(), id: z.string() }),
    createdBy: z.object({
      at: z.string(),
      actorType: z.enum(["human", "agent", "system"]),
      userId: z.string(),
      channel: z.enum(["ui", "webmcp", "mcp", "internal"]),
      agentClientId: z.string().optional(),
      agentName: z.string().optional(),
      action: z.string().describe("The operation that created it"),
      auditId: z.string(),
    }).optional().describe("From the earliest successful event; absent if it predates the audit trail"),
    count: z.number().int(),
    events: z.array(AuditEventOut()),
    truncated: z.boolean().describe("More than 500 events; only the newest 500 are listed"),
  },
  untrustedOutput: true,
  audit: { target: () => null },
  async handler({ type, id }, _ctx) {
    const s = svc();
    if (!s) return UNAVAILABLE();
    const LIMIT = 500;
    const events: Awaited<ReturnType<typeof s.queryAudit>>["events"] = [];
    let beforeSeq: number | undefined;
    do {
      const page = await s.queryAudit({ targetType: type, targetId: id, limit: 200, beforeSeq });
      events.push(...page.events);
      beforeSeq = page.nextBeforeSeq;
    } while (beforeSeq !== undefined && events.length < LIMIT);
    const list = events.slice(0, LIMIT).reverse();
    const first = list.find((e) => e.outcome === "success" && e.category === "operation");
    return ok(clean({
      target: { type, id },
      ...(first && {
        createdBy: {
          at: first.ts,
          actorType: first.actor.type,
          userId: first.actor.userId,
          channel: first.channel,
          agentClientId: first.actor.agent?.clientId,
          agentName: first.actor.agent?.name,
          action: first.action,
          auditId: first.id,
        },
      }),
      count: list.length,
      events: list,
      truncated: events.length > LIMIT || beforeSeq !== undefined,
    }) as never);
  },
});

export const verifyAuditChain = defineOperation({
  name: "verifyAuditChain",
  title: "Verify Audit Trail Integrity",
  description:
    "Recompute the audit trail's hash chain over every retained event and report whether it is intact, and " +
    "where it breaks if not. `durable: false` means events are only in this server instance's memory. Admin only.",
  permission: "read",
  roles: ["admin"],
  module: "admin.audit",
  inputSchema: {},
  outputSchema: {
    ok: z.boolean(),
    checked: z.number().int(),
    firstSeq: z.number().int().optional(),
    lastSeq: z.number().int().optional(),
    brokenAt: z.object({
      seq: z.number().int(),
      id: z.string(),
      reason: z.enum(["hash_mismatch", "link_mismatch", "seq_gap"]),
    }).optional(),
    durable: z.boolean(),
  },
  audit: { target: () => null },
  async handler(_input, _ctx) {
    const s = svc();
    if (!s) return UNAVAILABLE();
    return ok(clean(await s.verifyAudit()) as never);
  },
});

export const getUsageMetrics = defineOperation({
  name: "getUsageMetrics",
  title: "Get Usage Metrics",
  description:
    "How the application is being used, and by whom: calls split by human / agent / system and by channel, the " +
    "share of changes made by agents, active users and agent clients, top operations, error and denial rates, " +
    "calls per request, latency percentiles against the 200 ms p99 target, live connections, and a time series. " +
    "Default range: the last 24h. Admin only.",
  permission: "read",
  roles: ["admin"],
  module: "admin.monitoring",
  inputSchema: UsageQueryShape,
  outputSchema: {
    range: z.object({ from: z.string(), to: z.string(), resolution: z.enum(["minute", "hour"]) }),
    totals: z.object({
      calls: z.number(), topLevelCalls: z.number(), writes: z.number(), errors: z.number(), denials: z.number(),
      errorRate: z.number(), denialRate: z.number(), callsPerRequest: z.number().nullable(),
    }),
    adoption: z.object({
      activeUsers: z.number(), activeAgentClients: z.number(),
      agentShareOfWrites: z.number().describe("0..1"), agentShareOfCalls: z.number().describe("0..1"),
    }),
    byActorType: z.object({ human: ActorUsage(), agent: ActorUsage(), system: ActorUsage() }),
    byChannel: z.record(z.string(), z.object({ calls: z.number(), writes: z.number(), errors: z.number(), denials: z.number() })),
    operations: z.array(z.object({
      operation: z.string(), kind: z.string(), calls: z.number(), errors: z.number(), denials: z.number(),
      byActorType: z.object({ human: z.number(), agent: z.number(), system: z.number() }),
      ...Latency(),
    })),
    latency: z.object({ ...Latency(), sloMs: z.number(), sloMet: z.boolean() }),
    connections: z.object({ humanSessions: z.number(), agentClients: z.number() }).optional(),
    series: z.array(z.object({
      t: z.string(), human: z.number(), agent: z.number(), system: z.number(), errors: z.number(), denials: z.number(),
    })),
  },
  audit: { target: () => null },
  async handler(input, _ctx) {
    const s = svc();
    if (!s) return UNAVAILABLE();
    return ok(clean(await s.usageSummary(input)) as never);
  },
});

export const listUserSessions = defineOperation({
  name: "listUserSessions",
  title: "List Sign-in Sessions",
  description:
    "Human sign-in sessions with when they started, last activity, IP / user agent, and whether they're " +
    "connected now or were ended (logout / revoked). Admin only.",
  permission: "read",
  roles: ["admin"],
  module: "admin.access",
  inputSchema: {
    userId: Id().optional().describe("Only this user's"),
    connectedOnly: z.boolean().optional().describe("Only sessions active in the last 5 minutes"),
  },
  outputSchema: { count: z.number().int(), sessions: z.array(SessionOut()) },
  audit: { target: () => null },
  async handler({ userId, connectedOnly }, _ctx) {
    const s = svc();
    if (!s) return UNAVAILABLE();
    const sessions = (await s.listSessions({ userId })).filter((x) => !connectedOnly || x.connected);
    return ok(clean({ count: sessions.length, sessions }) as never);
  },
});

export const listAgentClients = defineOperation({
  name: "listAgentClients",
  title: "List Agent Clients",
  description:
    "Every agent connection users have authorised (MCP clients), with the agent software it reports, last " +
    "activity, and whether it's connected or revoked. Admin only.",
  permission: "read",
  roles: ["admin"],
  module: "admin.access",
  inputSchema: {
    userId: Id().optional().describe("Only this user's"),
    connectedOnly: z.boolean().optional().describe("Only agents active in the last 5 minutes"),
  },
  outputSchema: { count: z.number().int(), clients: z.array(ClientOut()) },
  audit: { target: () => null },
  async handler({ userId, connectedOnly }, _ctx) {
    const s = svc();
    if (!s) return UNAVAILABLE();
    const clients = (await s.listClients({ userId })).filter((x) => !connectedOnly || x.connected);
    return ok(clean({ count: clients.length, clients }) as never);
  },
});

function actorOf(ctx: OperationContext) {
  return ctx.actor ?? { type: "system" as const, userId: ctx.userId, role: ctx.role, assurance: "asserted" as const };
}

function revokeInfo(ctx: OperationContext) {
  return { channel: ctx.meta?.channel, ip: ctx.meta?.ip, userAgent: ctx.meta?.userAgent };
}

export const revokeAgentClient = defineOperation({
  name: "revokeAgentClient",
  title: "Revoke Agent Client",
  description:
    "Disconnect an agent: its token is rejected from its next call. Other agents of the same user are not " +
    "affected. Audited. Requires confirm: true. Admin only.",
  permission: "write",
  roles: ["admin"],
  module: "admin.access",
  requiresConfirmation: true,
  inputSchema: {
    clientId: z.string().min(1).max(100).describe("Agent client id (from listAgentClients)"),
    confirm: z.boolean().describe("Must be true"),
  },
  outputSchema: { clientId: z.string(), revoked: z.boolean().describe("false if it was already revoked") },
  audit: { target: (input) => ({ type: "agentClient", id: String(input.clientId) }) },
  async handler({ clientId, confirm }, ctx) {
    if (!confirm) return fail("CONFIRMATION_REQUIRED", "Pass confirm: true to revoke this agent client.");
    const s = svc();
    if (!s) return UNAVAILABLE();
    const r = await s.revokeClient(clientId, actorOf(ctx), revokeInfo(ctx));
    if (!r.found) return fail("NOT_FOUND", `No agent client ${clientId}`);
    return ok({ clientId, revoked: r.revoked });
  },
});

export const revokeSession = defineOperation({
  name: "revokeSession",
  title: "Revoke Sign-in Session",
  description:
    "End a user's sign-in session: it stops working on its next request, and agent tokens it authorised stop " +
    "too (unlike a logout). Audited. Requires confirm: true. Admin only.",
  permission: "write",
  roles: ["admin"],
  module: "admin.access",
  requiresConfirmation: true,
  inputSchema: {
    sessionId: Id().describe("Session id (from listUserSessions)"),
    confirm: z.boolean().describe("Must be true"),
  },
  outputSchema: { sessionId: z.string(), revoked: z.boolean().describe("false if it was already revoked") },
  audit: { target: (input) => ({ type: "session", id: String(input.sessionId) }) },
  async handler({ sessionId, confirm }, ctx) {
    if (!confirm) return fail("CONFIRMATION_REQUIRED", "Pass confirm: true to revoke this session.");
    const s = svc();
    if (!s) return UNAVAILABLE();
    const r = await s.revokeSession(sessionId, actorOf(ctx), revokeInfo(ctx));
    if (!r.found) return fail("NOT_FOUND", `No session ${sessionId}`);
    return ok({ sessionId, revoked: r.revoked });
  },
});
