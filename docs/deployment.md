# Deploying and configuring

What changes between `npm run dev` and a real deployment: shared state, sign-in, the secrets and limits you can set, and the security controls that are on either way. For an auditable (SOC 2) configuration, also read [management-soc2.md](management-soc2.md#running-it-in-an-auditable-configuration).

## Shared state on Vercel (optional)

By default every store (reservations, CRM, tasks, housekeeping, finance, the audit log) is in-memory per process — fine for `npm run dev`, but on Vercel each serverless instance has its own memory, so an MCP-driven write and a browser's poll can land on different instances and never see each other's data.

To fix this on a real deployment, add a Redis database via the Vercel Marketplace (Project → Storage → Marketplace Database Providers) and connect it to Production/Preview/Development. That injects a `REDIS_URL` connection string, which `lib/shared-state/` (built on `node-redis`) picks up automatically — no code changes needed. Without it, the app transparently falls back to today's in-memory behavior; this is why `npm test` and local dev need zero setup. `vercel env pull .env.development.local` will only pick this up if the integration is also connected to the Development environment, not just Production.

If Redis is configured but unreachable, the app degrades to the same in-memory behaviour instead of hanging: the first connection attempt gives up after `REDIS_CONNECT_TIMEOUT_MS` (default 1500), after which requests skip Redis for `REDIS_RETRY_COOLDOWN_MS` (default 30000) while the client reconnects in the background. Commands on a dropped connection fail immediately rather than queueing (`lib/shared-state/redis.ts`). Keys are namespaced by `VERCEL_ENV`, so a preview deployment and production never share data even on the same Redis.

What Redis holds: the business stores, the audit trail, metrics, sessions and agent clients, credit ledgers, idempotency records and which tools each token has loaded. To test against a real Redis locally, see [development.md](development.md#testing-against-a-real-redis-locally).

## Demo mode

Sign-in is required: opening the app without a session takes you to `/login`.

| `DEMO_MODE` | Behaviour |
|---|---|
| unset (default) | Login required. Once signed in, the role switcher in the header works. |
| `true` | No login: a first-time visitor lands signed in as alice (customer). Role switcher works. |
| `false` | Login required, and the demo shortcuts (role switcher, "Reset demo data") are disabled. |

## Configuration reference

Every environment variable the app reads. All are optional: with none set, the app runs locally with in-memory state and demo secrets.

**Secrets and identity.** Set the first two on any deployment that isn't a local demo.

| Variable | Default | What it does |
|---|---|---|
| `AUTH_SECRET` | insecure built-in default | Signs session cookies and agent tokens |
| `AUDIT_HMAC_KEY` | `AUTH_SECRET`, then an insecure built-in default | Key for the audit hash chain. Keep it apart from `AUTH_SECRET` |
| `MCP_RESOURCE_URL` | `https://$VERCEL_PROJECT_PRODUCTION_URL/api/mcp`, else `http://localhost:3000/api/mcp` | The audience agent tokens are bound to (RFC 8707). Must match the URL agents connect to |
| `DEMO_MODE` | unset | See [Demo mode](#demo-mode) |

**Shared state.**

| Variable | Default | What it does |
|---|---|---|
| `REDIS_URL` | unset (in-memory, per process) | Shared state across instances |
| `REDIS_CONNECT_TIMEOUT_MS` | `1500` | Give up on the first connection after this |
| `REDIS_RETRY_COOLDOWN_MS` | `30000` | Skip Redis this long after a failure |
| `REDIS_COMMAND_TIMEOUT_MS`, `REDIS_SOCKET_TIMEOUT_MS`, `REDIS_PING_INTERVAL_MS` | `1000`, `3000`, `1000` | Detect a hung Redis and skip it instead of waiting |
| `STATE_LOCK_MAX_MS` | `30000` | Watchdog on the per-instance state lock |
| `VERCEL_ENV` | `dev` | Redis key namespace (set by Vercel) |

**Protocol limits.**

| Variable | Default | What it does |
|---|---|---|
| `OP_DEADLINE_MS` | `15000` | Handler deadline before `HANDLER_TIMEOUT` (an operation may set its own `deadlineMs`) |
| `MAX_BODY_BYTES` | `65536` | JSON request body cap |
| `IDEMPOTENCY_TTL_SECONDS` | `86400` | How long an idempotent result is kept for replay |
| `CONFIRMATION_SECRET` | `AUTH_SECRET`, then an insecure built-in default | Signs confirmation tokens (2.6.0). Must be the same on every instance |
| `CONFIRMATION_TTL_SECONDS` | `300` | How long a confirmation token stays valid |
| `REQUIRE_CONFIRMATION_TOKEN` | off | `true`: an agent's bare `confirm: true` is refused; it must use the preview's token (or MCP elicitation) |
| `IDEMPOTENCY_PENDING_TTL_MS` | `300000` | How long a claim for a call still running blocks its key (covers an instance that died) |
| `IDEMPOTENCY_REDIS_TIMEOUT_MS` | `500` | Longest an idempotency check waits on Redis before using memory |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_S` | `10`, `300` | Sign-in throttle: failed attempts per IP and username per window |

**Credits.** `CREDITS_ENABLED` (default on), the per-profile `CREDITS_AGENT_<FIELD>` and `CREDITS_HUMAN_<FIELD>` overrides, `CREDITS_MAX_INFLIGHT_AGENT` / `_HUMAN`, `CREDITS_CAPACITY`, `CREDITS_LAG_HIGH_MS` / `_LOW_MS`, `CREDITS_HOLD_STALE_MS`, `CREDITS_MEMORY_MAX_LEDGERS` and `CREDITS_REDIS_TIMEOUT_MS`: see [credits.md § 15](credits.md#15-configuration).

**Audit and telemetry export.**

| Variable | Default | What it does |
|---|---|---|
| `AUDIT_RETENTION_DAYS` | `365` | In-store audit retention |
| `AUDIT_WEBHOOK_URL`, `AUDIT_WEBHOOK_SECRET` | unset | Audit export webhook, and its HMAC signing secret |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OpenTelemetry collector: audit logs, traces and metrics |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | `k1=v1,k2=v2` sent with every OTLP request |
| `OTEL_SERVICE_NAME` | `navwebmcp` | OTLP `service.name` |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` | unset | Set to `none` to switch either off |

**Bug reports to Jira** (the in-app "Report a bug" inspector). All four of the first variables must be set, or reports are only stored in the app.

| Variable | Default | What it does |
|---|---|---|
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` | unset | Where and as whom to file the issue |
| `JIRA_ISSUE_TYPE` | `Bug` | Issue type to create |

**Scripts only.** `BENCH_BASE` (default `http://localhost:3000`) points `scripts/bench.mjs` and `scripts/speedbase.mjs` at another server; `REDIS_LIVE_URL` points `npm run test:redis` at an existing Redis.

## Security model

| Control | Implementation |
|---|---|
| Browser authentication | HMAC-signed session cookie carrying a session id; ended server-side on logout or admin revocation |
| MCP HTTP authentication | RFC 8707 audience-bound Bearer token, 8-hour TTL, naming an agent client that can be revoked on its own |
| Single execution path | `execute()` — every call from every surface gets the same RBAC, validation, audit and metrics |
| Input validation | Zod schema on every call |
| RBAC | Per-operation `roles` array, checked at every call boundary |
| Destructive confirmations | `requiresConfirmation: true` — preview + one-use token, MCP elicitation, UI dialog; `REQUIRE_CONFIRMATION_TOKEN=true` refuses a bare `confirm: true` |
| Actor attribution | Every call and every created/changed record says whether a person, an agent (which one) or the system acted, and on whose behalf |
| Audit trail | Append-only, HMAC hash-chained, redacted, 365-day retention, exportable to a SIEM; denials and sign-in events included |
| Admin access | `/api/admin/*` and `admin.*` operations behind one guard; denied attempts are audited |
| Activity feed scoping | `/api/audit` shows non-admins only their own calls in full |
| Flow control | SMB-style credits per agent client and per person: charged by op type, size and run time, granted back under server control; plain-language hints in results ([Credits](credits.md)) |
| Request shape limits | Nesting ≤ 3 levels and ≤ 200 operations per request (`FANOUT_LIMIT`), 15 s handler deadline, 64 KB JSON bodies |
| Sign-in throttle | 10 failed sign-ins per IP per 5 minutes, then HTTP 429 |
| Capability versioning | DJB2 hash over each operation's full schemas, flags and cost — agents detect registry changes |
| Idempotent writes | A keyed write runs at most once per user, operation and key, across instances ([protocol § 5](protocol.md#5-execute)) |
| Token audience binding | RFC 8707 — a token minted for this server cannot be replayed elsewhere |
