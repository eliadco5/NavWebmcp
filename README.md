# WebMCP / AgentBridge

**Business logic exposed to AI agents as structured tools, through the WebMCP standard and over MCP.**

- **WebMCP** (`document.modelContext`) is a draft browser API that lets a page register tools for AI agents, much as it registers event listeners for users.
- **NavWebMcp** is the protocol this repo layers on top. It adds progressive tool disclosure, RBAC, composite operations, structured errors, idempotent writes, dependent batches and credit-based flow control.
- **AgentBridge** is this repo's reference implementation. The same operation registry is served in the page, through `document.modelContext` with a polyfill for today's browsers, and over MCP Streamable HTTP for external agents such as Claude Code, Claude Desktop and the MCP Inspector. The MCP endpoint speaks the 2026-07-28 revision and 2025-era clients alike.

It comes with a demo hospitality app (reservations, front desk, CRM, tasks, housekeeping, finance), a management layer that tells people's actions from agents', and an [agent skill](skills/navwebmcp-agent/SKILL.md) for any agent talking to any NavWebMcp server.

Protocol **2.5.0** · [Changelog](CHANGELOG.md) · [Roadmap](docs/plans/agent-protocol-roadmap.md) · Built on [Next.js](https://nextjs.org) and the [Model Context Protocol](https://modelcontextprotocol.io).

> This repo is also the implementation proof of the **AOD/ADD** methodology (AI-Oriented
> Development / AI-Driven Development): its code and docs were produced by framing intent
> specs up front, delegating work to agents, and verifying independently before anything
> was accepted. The methodology itself is documented separately in `add-aod`.

---

## The idea in one example

Most agent integrations make the **agent** orchestrate the calls:

```
Agent → searchAvailability()   →  parse the slot list, extract slotId
Agent → createReservation()    →  parse the result, decide to validate
Agent → getReservation()       →  finally confirm success
```

That's three round trips, three chances to get the domain wrong, and a context that grows with every call. NavWebMcp moves that orchestration into a **composite operation**:

```
Agent → book({ date, time, partySize, name })  →  { reservation, validated: true }
```

Measured on the booking flow over real MCP HTTP, the composite uses **67 % fewer tokens** and is **67 % faster** than three separate calls ([benchmarks](docs/benchmarks.md)). When no composite exists, a **dependent batch** runs the same three steps in one round trip by passing results along with `$ref`.

## Features

| Feature | What it gives you | Guide |
|---|---|---|
| Progressive tool disclosure | 12 small always-on tools at connect (about 2,000 tokens); the other 61 operations are found with `explore` / `search` and called with `invoke`, or loaded as native tools | [Protocol § 4](docs/protocol.md#4-discover) |
| Composite operations | `book`, `seatGuest`, `hostVipGuest`: multi-step flows with validation, in one call | [Protocol § 1](docs/protocol.md#1-the-core-idea) |
| One registry, two surfaces | Every operation on MCP and in-page WebMCP, with the same RBAC, validation and audit | [Protocol § 2](docs/protocol.md#2-one-registry-two-surfaces) |
| Gather first, ask once | `getContext` + `getCapabilities` at connect, so the agent asks the user one question | [Protocol § 3](docs/protocol.md#3-connect-and-preflight) |
| Structured errors | `{ code, message, retryable, details, hint, suggestions, requestId, callId }` on every surface | [Protocol § 8](docs/protocol.md#8-errors) |
| Safe retries (≥ 2.1.0) | `idempotencyKey` on every write: a retry never writes twice, across instances | [Protocol § 5](docs/protocol.md#5-execute) |
| Dependent batches (≥ 2.2.0) | `{ "$ref": "0.data.slots[0].id" }` threads one call's result into the next | [Protocol § 5](docs/protocol.md#5-execute) |
| Paged lists (≥ 2.7.0) | Optional `limit`, `cursor` and `fields` on the 17 list operations; without them, the whole list as before | [Protocol § 5](docs/protocol.md#5-execute) |
| Compact results (≥ 2.3.0) | `?format=compact` on the MCP URL: 16–40 % fewer tokens per flow | [Protocol § 6](docs/protocol.md#6-compact-text-results--230) |
| RBAC and confirmation gates | Per-operation roles; destructive operations show a preview and need a one-use token, `confirm: true` or the user's answer to an MCP elicitation; `dryRun` on any write | [Protocol § 7](docs/protocol.md#7-rbac-and-confirmation-gates) |
| Agent-operable UI (≥ 1.3.0) | Agents change what the user *sees* (filters, sort, tabs) through `ui_*` operations, not the DOM | [Build guide](docs/ui-components-guide.md) · [Spec](docs/ui-components.md) |
| Credits (≥ 1.4.0) | SMB-style flow control: no agent can flood the server, and results tell agents how to pace themselves | [Credits](docs/credits.md) |
| Management and SOC 2 audit | Who did what (person, agent, system), a hash-chained audit trail, usage telemetry, revocable sessions and agents | [Management](docs/management.md) · [SOC 2](docs/management-soc2.md) |
| Shared state | Redis when `REDIS_URL` is set (Vercel Marketplace); in memory otherwise | [Deployment](docs/deployment.md) |
| MCP 2026-07-28 (≥ 2.4.0) | Stateless, with `server/discover`; 2025-era `initialize` clients keep working on the same endpoint | [Protocol § 3](docs/protocol.md#3-connect-and-preflight) |
| Versioning | `protocolVersion` (the contract) and `capabilityHash` (the role's tool set), cached separately | [Protocol § 9](docs/protocol.md#9-versioning) |

## Quick start

```bash
npm install
npm run dev
# open http://localhost:3000 and sign in (demo users below)
```

State is in memory and resets when the server restarts, unless `REDIS_URL` is set ([deployment](docs/deployment.md)).

### Demo users

| Username | Password | Role |
|---|---|---|
| alice | password | customer |
| carol | password | support |
| bob | password | admin |

Sign-in is required; `DEMO_MODE` changes that ([deployment](docs/deployment.md#demo-mode)).

## Connect an agent

The MCP endpoint needs a bearer token. Sign in, then copy your agent token from the **Connect an AI Agent** card. It's audience-bound (RFC 8707) and lasts 8 hours.

**Claude Code:**

```bash
claude mcp add --transport http booking "http://localhost:3000/api/mcp?format=compact" \
  --header "Authorization: Bearer <your-agent-token>"
```

Drop `?format=compact` to get indented JSON in results, which is the default and easier to read by eye ([§ 6](docs/protocol.md#6-compact-text-results--230)). Then ask: *"Book me a table for 2 tomorrow evening."*

- **Claude Desktop:** Settings → Connectors → Add custom connector → `http://localhost:3000/api/mcp`, then add the `Authorization: Bearer <token>` header.
- **MCP Inspector:** `npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp`, with the same header.
- **`.mcp.json`** (included in the repo) omits the header on purpose: a static token goes stale and can't be committed per user. Use `claude mcp add`, or add the header by hand.
- **In the browser:** after signing in, `document.modelContext.getTools()` in the console lists what your role can call ([operations reference](docs/operations.md#in-page-webmcp-browser-console)).

**One token per agent.** The Agent tab's token identifies a default agent client for your session. To connect several agents and revoke them separately, create a token for each:

```bash
curl -X POST http://localhost:3000/api/agent-clients \
  -H "Content-Type: application/json" -b "agentbridge_session=<your-session-cookie>" \
  -d '{"label":"Claude Desktop"}'
# → { "success": true, "clientId": "c_…", "agentToken": "ab1.…" }
```

Logging out of the browser doesn't disconnect your agents. Revoke one with `DELETE /api/agent-clients { "clientId": "c_…" }`; an admin can revoke any agent or session from the Management tab ([sessions and agent identity](docs/management.md#2-sessions-and-agent-identity)).

## Documentation

| If you want to… | Read |
|---|---|
| Understand the protocol, or build an agent or a server for it | [Protocol guide](docs/protocol.md), then the [agent skill](skills/navwebmcp-agent/SKILL.md) |
| Look up an operation, its roles or its module | [Operations reference](docs/operations.md) |
| Let agents operate your own app's UI components | [UI components build guide](docs/ui-components-guide.md) and [spec](docs/ui-components.md) |
| Understand credits and pacing | [Credits](docs/credits.md), and its [test report](docs/credits-test-report.md) |
| Run it for real: Redis, secrets, limits, every environment variable | [Deployment and configuration](docs/deployment.md) |
| Audit agent activity, or prepare for SOC 2 | [Management layer](docs/management.md) and [SOC 2 mapping](docs/management-soc2.md) |
| See the numbers, or reproduce them | [Benchmarks](docs/benchmarks.md) |
| Add an operation, a composite or an operable component; test a change | [Development guide](docs/development.md) |
| Compare with the WebMCP draft | [WebMCP alignment](docs/webmcp-alignment.md) |
| See what's planned | [Roadmap](docs/plans/agent-protocol-roadmap.md) and [changelog](CHANGELOG.md) |

Also in `docs/`: a not-yet-built [authorization design](docs/authorization-implementation-guide.md) and the [Devpost submission](docs/devpost-submission.md).

## Tech stack

Next.js 15 (App Router, React 19), TypeScript 5, Zod (validation and JSON Schema), `@modelcontextprotocol/server` (MCP SDK v2) and `mcp-handler` 2.x (the MCP server), `@modelcontextprotocol/client` (the scripts' client), `node-redis` (optional shared state), Vitest and Playwright (tests and benchmarks). Project layout: [development guide](docs/development.md#project-structure).

## License

MIT, see [LICENSE](LICENSE).
