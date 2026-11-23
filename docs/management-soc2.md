# Management layer and SOC2

How NavWebMcp's management layer (monitoring, telemetry, audit) supports a SOC 2
Type II control environment, what it does *not* cover, and how to run it in a
configuration an auditor will accept.

It answers three questions for every action in the app:

- **Who did it?** A person in the app, an AI agent acting for a person, or the
  platform. If it was an agent: which one, and which user authorised it.
- **What did it touch?** The operation, the record (e.g. `reservation res_…`), and
  the outcome (`success`, `failure`, `denied`).
- **Can we prove it?** Every event is in an append-only, hash-chained audit trail
  that detects any edit, deletion, reordering or truncation.

## Architecture in one paragraph

Every operation call, from any surface (the UI, the in-page WebMCP agent, an
external MCP agent, or a composite calling other operations), goes through one
function, `execute()` (`lib/operations/execute.ts`). It enforces RBAC and input
validation, runs the handler, and then writes one audit event
(`lib/audit/`) and one telemetry observation (`lib/telemetry/`). Sign-ins, logouts,
role switches, agent-token issuance and revocations are audited by the routes that
perform them. Records the operations create or change carry a `createdBy` /
`lastModifiedBy` stamp (`lib/provenance.ts`) that points at the audit event for that
change.

## Telling people from agents

| Surface | Actor type | How it's identified | Assurance |
|---|---|---|---|
| UI click (`/api/call`) | `human` | Signed session cookie (user + session id) | `asserted`: the browser declares it's the UI |
| In-page agent (WebMCP, `/api/call`) | `agent` | Signed session cookie, plus the page's `x-navwebmcp-channel: webmcp` header | `asserted` |
| External agent (MCP) | `agent` | Server-issued bearer token naming the agent client and authorising session | `verified` |
| In-process / scripts | `system` | No caller context | `asserted` |

The cookie proves *who* in every case. For `/api/call`, *whether a person or the
in-page agent pressed the button* is the browser's word, so it is recorded as
`asserted`, not `verified`, and an auditor can filter on that. In-page `ui_*` writes
run entirely in the browser and are reported to `/api/audit/report`; they are stored
with `reportedBy: "client"`.

Each agent connection is its own **agent client** with its own token, so two agents
of the same user are distinguishable in the trail and revocable separately.

## Control mapping

| SOC 2 criterion | What the system does | Where |
|---|---|---|
| **CC6.1** Logical access: authorised users only | RBAC on every operation in `execute()`, on all surfaces. Admin APIs behind one guard (`requireAdmin`). The activity feed (`GET /api/audit`) shows non-admins only their own calls in full. | `lib/operations/execute.ts`, `lib/management/guard.ts`, `lib/auditlog.ts` (`scopeFeed`) |
| **CC6.2** Credentials issued to registered users | Per-session ids in signed cookies; per-agent client ids in bearer tokens. Token issuance and agent-client creation are audited. | `lib/auth-tokens.ts`, `app/api/agent-clients` |
| **CC6.3** Access removed when no longer needed | Logout ends the session server-side. Users revoke their own agents; admins revoke any session or agent client. Revocation takes effect on the next request, across all server instances. Revoking a session also disconnects the agents it authorised (a logout deliberately doesn't). | `lib/management/auth.ts`, `lib/management/sessions.ts`, `/api/admin/sessions`, `/api/admin/clients`, `revokeSession` / `revokeAgentClient` ops |
| **CC7.2** Monitoring for anomalies | Every denial is audited with outcome `denied` (RBAC, failed sign-in with IP and attempted username, use of a revoked session or agent token, non-admin hitting admin APIs). Usage metrics show error and denial rates, human vs agent activity, and latency against the SLO. Audit events can stream to a SIEM. | `lib/audit/`, `lib/telemetry/`, Management tab |
| **CC7.3** Evaluating security events | Search by actor, agent, session, request, record, outcome and time; full history of any record; export to CSV/NDJSON with the chain hashes. | `/api/admin/audit`, `/api/admin/audit/export`, `queryAudit`, `getEntityHistory` |
| **CC7.4** Incident response | Revoke a session or agent immediately; the trail shows everything that credential did (`sessionId` / `clientId` filters). | Management → Sessions & agents |
| **CC8.1** Change management (of data) | Every write is audited with before-the-fact authorisation; records carry who created / last changed them, linked to the audit event. | `lib/provenance.ts` |
| **Integrity of the audit trail** | Append-only Redis stream; HMAC-SHA256 hash chain keyed with `AUDIT_HMAC_KEY`; compare-and-set appends so concurrent instances can't fork it; `verifyAuditChain` / `/api/admin/audit/verify` recompute it. | `lib/audit/store.ts`, `lib/audit/chain.ts` |
| **Retention** | `AUDIT_RETENTION_DAYS` (default 365) in the store; trims are themselves audited. Longer retention via an export sink to WORM storage or a SIEM. | `lib/audit/store.ts`, `lib/audit/sinks` |
| **Confidentiality / privacy** | Inputs and outputs are redacted before hashing and storage: secrets (passwords, tokens) are dropped, personal data (email, phone, card numbers, address, …) masked, payloads capped. | `lib/audit/redact.ts` |

## Running it in an auditable configuration

`GET /api/admin/health` (shown at the top of the Management tab) reports each of
these and lists what's missing.

| Setting | Why | Required |
|---|---|---|
| `REDIS_URL` | Without it the audit trail, sessions and metrics live in each server instance's memory and are lost on restart. **Not auditable.** | Yes |
| `AUDIT_HMAC_KEY` | Keys the hash chain. Falls back to `AUTH_SECRET`, then to a public default that makes the chain forgeable. Store it apart from Redis credentials, so whoever can edit Redis can't recompute the chain. | Yes |
| `AUTH_SECRET` | Signs sessions and agent tokens. | Yes |
| `AUDIT_WEBHOOK_URL` (+ `AUDIT_WEBHOOK_SECRET`) or `OTEL_EXPORTER_OTLP_ENDPOINT` | An off-platform copy of the trail (SIEM, log platform, WORM bucket). The in-app store is the system of record; the sink is your independent copy and long-term archive. | Strongly recommended |
| `AUDIT_RETENTION_DAYS` | In-store retention; default 365. | Optional |
| `DEMO_MODE` unset or `false` | `DEMO_MODE=true` signs visitors in automatically and enables the one-click role switcher. Role switches are audited, but a production deployment must not have them. | Yes |
| `REDIS_CONNECT_TIMEOUT_MS`, `REDIS_RETRY_COOLDOWN_MS` | How fast the app falls back to memory when Redis is unreachable (default 1.5 s, then 30 s without retrying). During an outage, events are kept in memory and an error is logged; health reports it. | Optional |

## Known limits (state these to your auditor)

- **Demo identity.** The three users and their passwords are hard-coded
  (`lib/auth.ts`). A production deployment needs a real identity provider; the
  session, agent-client and audit model here is designed to sit behind one.
- **Browser-declared channel.** UI vs in-page agent on `/api/call`, and in-page `ui_*`
  reports, are `asserted` by the browser. MCP agent calls are `verified`.
- **Redis outage.** While Redis is unreachable, new audit events go to the serving
  instance's memory and are not in the durable trail. Pair it with an export sink, and
  monitor `/api/admin/health` or the logged errors.
- **Metrics are best-effort.** Unlike the audit trail, counters may undercount
  during an outage. Use the audit trail, not metrics, as evidence.
- **Cancelled reservations** are deleted, not soft-deleted; who cancelled one is in the
  audit trail (`cancelReservation` / `cancelAnyReservation` events), not on the record.
- **Seed data** has no `createdBy`.

## For agents

Admins' agents get the same capabilities as operations in the `admin.*` module
(admin role only, discoverable through `explore` / `search`):

| Operation | Purpose |
|---|---|
| `getEntityHistory` | Full history of one record, and who created it (person or agent, which agent, which surface) |
| `queryAudit` | Search the trail |
| `verifyAuditChain` | Check the trail's integrity |
| `getUsageMetrics` | Usage, adoption, human vs agent split, latency vs SLO |
| `listUserSessions`, `listAgentClients` | Who is signed in and which agents are connected |
| `revokeSession`, `revokeAgentClient` | Revoke (require `confirm: true`; audited) |

These are business operations: they change `capabilityHash`, not `PROTOCOL_VERSION`.
