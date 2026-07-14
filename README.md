# AgentBridge — Frontend-Orchestrated WebMCP

A reference implementation and proof-of-concept for a new approach to AI-agent integration: **business logic that lives in the browser page, exposed to agents as structured tools through the WebMCP standard.**

Built on [Next.js](https://nextjs.org) and the [Model Context Protocol](https://modelcontextprotocol.io).

---

## The core idea

Every existing approach to AI-agent integration makes the **agent** do the work:

```
Agent → searchAvailability()  →  parse slot list, extract slotId
Agent → createReservation()   →  parse result, decide to validate
Agent → getReservation()      →  finally confirm success
```

Three round-trips. Three reasoning gaps. Growing context window. The agent must understand your domain well enough to sequence the calls correctly.

**AgentBridge flips this.** Business logic lives in the frontend as a composite function registered into `document.modelContext` (the WebMCP browser API). The agent calls one tool and receives a validated result:

```
Agent → book({ date, time, partySize, name })  →  { reservation, validated: true }
```

One call. Zero reasoning gaps. The orchestration runs in the browser, invisible to the agent.

---

## Why this is the right protocol

### Problem with existing approaches

| Approach | Fragility | Token cost | Agent burden |
|---|---|---|---|
| Browser automation (Playwright, Puppeteer) | Breaks on any UI change | Very high — DOM inspection | Must map UI → intent |
| Raw MCP tool calls | Stable, but coarse | High — 3+ calls per business action | Must understand domain logic |
| AgentBridge frontend tools | Stable — API contract | **Low — 1 call per action** | Calls one named function |

The deeper problem with raw tool calls: **the agent carries your business logic as tokens**. It must know that booking requires availability first, that the slotId from one response must be passed to the next, that a post-condition check is needed. This knowledge lives in the prompt, re-processed on every call, and can hallucinate.

### The AgentBridge insight

Websites already contain business logic — it lives in the frontend, wired to the same backend your users interact with. Instead of asking agents to re-derive that logic from tool schemas, **register it as a callable function**.

The result:

| Metric | 3-call MCP | book() | Saving |
|---|---|---|---|
| Agent-facing HTTP calls | 3 | 1 | 66.7% |
| Input tokens | 58 | 24 | 58.5% |
| Output tokens | 184 | 56 | 69.6% |
| Context accumulation | 325 | 0 | 100% |
| Reasoning tokens (est.) | 180 | 0 | 100% |
| **Total tokens** | **747** | **80** | **89.3%** |
| Wall-clock (100ms RTT + reasoning) | 2,100ms | 310ms | 6.8× faster |

*Measured with the included [benchmark](#benchmark), timing adjusted for 100ms network RTT and 900ms LLM reasoning gap per tool call.*

### Two surfaces, one registry

The same operation registry exposes tools on two surfaces simultaneously:

| Surface | How agents connect | What's exposed |
|---|---|---|
| **In-page WebMCP** | Browser / in-page agents via `document.modelContext` | Composite frontend tools (e.g. `book`) + atomic ops |
| **MCP Streamable HTTP** | Claude Code, Claude Desktop, MCP Inspector | Atomic ops via progressive disclosure |

Frontend-orchestrated tools like `book()` live exclusively on the in-page surface — that's where business logic belongs. The HTTP surface exposes atomic ops for external agents that lack page context.

---

## Architecture

```
lib/operations/          ← single source of truth for all operations
  types.ts               ← Operation descriptor type + defineOperation helper
  index.ts               ← registry array
  *.ts                   ← one file per operation

lib/ui-tools/            ← frontend-orchestrated composite tools
  book.ts                ← book() — chains availability + create + validate

lib/adapters/
  mcp.ts                 ← registry → MCP tools (McpServer.registerTool)
  webmcp.ts              ← registry → in-page document.modelContext

app/
  providers.tsx          ← registers book() into document.modelContext after auth
  api/[transport]/       ← MCP Streamable HTTP endpoint
  api/call/              ← UI call route (used by frontend + book())

lib/agentbridge.ts       ← AgentBridge SDK (register, call, describe, subscribe)
lib/webmcp-polyfill.ts   ← document.modelContext shim for pre-standard browsers
lib/modules.ts           ← module tree for progressive tool disclosure
lib/store.ts             ← in-memory reservation state + event emitter
lib/auditlog.ts          ← audit log (agent + UI calls, shown in UI)
lib/auth.ts              ← RBAC: customer / support / admin roles
lib/capabilities.ts      ← version-hashed capability manifest
```

### How book() works

```
book({ date, time, partySize, name })
  │
  ├─ 1. AVAILABILITY  → searchAvailability(date, partySize)
  │                       pick slot matching time
  │                       none? → fail("NO_AVAILABILITY")
  │
  ├─ 2. RESERVATION   → createReservation(slotId, name, partySize)
  │                       fail? → propagate error
  │
  └─ 3. VALIDATE      → Promise.all([
                           getReservation(reservationId),    // exists?
                           searchAvailability(date, partySize) // slot gone?
                         ])
                         inconsistent? → cancelReservation (rollback)
                                       → fail("VALIDATION_FAILED")
                         ok? → return { reservation, validated: true }
```

The agent sees none of steps 1–3. It sends one `book()` call and receives a validated booking.

---

## Available operations

### Always-on (always in tools/list)

| Name | Description |
|---|---|
| `explore` | Navigate the platform module tree to discover functions |
| `describe_tool` | Get full input schema for a named function |
| `invoke` | Call any function once without loading it (single or batch) |
| `load_tools` | Promote functions to native MCP tools for the session |
| `unload_tools` | Remove promoted tools from tools/list |
| `getContext` | Current page context (page, authenticated, locale) |
| `getCapabilities` | Role-scoped manifest with version hash |

### Business operations (discovered via `explore`, loaded via `load_tools`)

| Name | Permission | Roles |
|---|---|---|
| `searchAvailability` | read | customer, support, admin |
| `listReservations` | read | customer, support, admin |
| `getReservation` | read | customer, support, admin |
| `createReservation` | write | customer, support, admin |
| `cancelReservation` | write ⚠️ confirm | customer, support, admin |
| `listAllReservations` | read | support, admin |
| `cancelAnyReservation` | write ⚠️ confirm | admin |

### Frontend-orchestrated composite tools (in-page WebMCP only)

| Name | Description |
|---|---|
| `book` | Book a table in one step — availability + reservation + validation |

### Demo users

| Username | Password | Role |
|---|---|---|
| alice | password | customer |
| carol | password | support |
| bob | password | admin |

---

## Quick start

```bash
npm install
npm run dev
# Open http://localhost:3000
```

State is in-memory — resets on server restart.

---

## Connect an agent

### Claude Code

```bash
claude mcp add --transport http booking http://localhost:3000/api/mcp
```

Or add to `.mcp.json` (already included in this repo for local use):
```json
{
  "mcpServers": {
    "agentbridge-booking": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp"
    }
  }
}
```

Then ask Claude: *"Book me a table for 2 tomorrow evening"*

### Claude Desktop

Settings → Connectors → Add custom connector → `http://localhost:3000/api/mcp`

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp
```

Pass `Authorization: Bearer <token>` (your agent token is shown in the UI after login).

---

## In-page WebMCP (browser console)

After signing in, the page registers all tools into `document.modelContext`. Open the browser console:

```javascript
// List all tools the agent can call
document.modelContext.getTools().map(t => t.name)
// → [..., "book", "searchAvailability", "createReservation", ...]

// Use the composite book() tool (one call — full orchestration)
await document.modelContext.executeTool("book", {
  date: "2026-07-15",
  time: "18:00",
  partySize: 2,
  name: "Alice"
})
// → { success: true, data: { reservation: {...}, validated: true } }

// Or use the AgentBridge SDK (higher-level)
agentBridge.describe()
await agentBridge.call("searchAvailability", { date: "2026-07-15", partySize: 2 })

// Or call the same composite tool via window shorthand
await bookTool({ date: "2026-07-15", time: "18:00", partySize: 2, name: "Alice" })
```

---

## How the platform exposes its functions

Every operation in this project has a `module` field — a dot-path string that places it in a navigable tree. The tree is defined in `lib/modules.ts` and is the mechanism by which an agent discovers what the platform can do without receiving the entire schema catalogue upfront.

### The module tree

```
(platform root)
└── reservation                    "Create and manage table reservations"
    ├── reservation.availability   "Search for open time slots"
    │     searchAvailability         read, parallelSafe
    ├── reservation.booking        "Create and cancel reservations"
    │     createReservation          write
    │     cancelReservation          write, requiresConfirmation
    ├── reservation.search         "Look up existing reservations"
    │     listReservations           read, parallelSafe
    │     getReservation             read, parallelSafe
    └── reservation.admin          "Cross-user management (support/admin only)"
          listAllReservations        read, parallelSafe
          cancelAnyReservation       write, requiresConfirmation
```

Modules are pure metadata — a flat list of `{ path, title, description }` entries in `lib/modules.ts`. Parent/child relationships are inferred from dot-path prefixes: `reservation.booking` is a child of `reservation` because it starts with `reservation.`. You never declare a parent explicitly; the tree builds itself.

An operation is placed in the tree by setting `module: "reservation.booking"` in its `defineOperation` descriptor. That is the only coupling between an operation and the tree.

### What the agent sees when it connects

When an agent first connects to the MCP HTTP endpoint, **only the always-on tools appear in `tools/list`**:

```
explore          describe_tool    invoke
load_tools       unload_tools     getContext    getCapabilities
```

That is 7 tools. The 7 business operations (`searchAvailability`, `createReservation`, etc.) are not visible. This is intentional: dumping every tool schema into the agent's context on connection wastes tokens on capabilities the agent may never need. The always-on tools are the navigation layer — they let the agent discover exactly what it needs.

Token cost of the default tools/list: **~180 tokens** for 7 lean meta-tool schemas.  
Token cost if all 14 ops were loaded upfront: **~700 tokens** — and those tokens are paid on every single request.

---

## Progressive tool disclosure (MCP HTTP surface)

The agent navigates the platform in a small number of structured calls, loading only the tools it will actually use. There are two paths.

### Step 1 — understand the platform

```json
// Agent calls: explore()  (no arguments)
{
  "app": "AgentBridge Booking",
  "description": "A booking platform for managing reservations. Navigate the module tree with explore() to discover available functions before invoking them.",
  "modules": [
    {
      "path": "reservation",
      "title": "Reservation",
      "description": "Create and manage table reservations, search availability, and handle cancellations."
    }
  ]
}
```

Cost: **~92 tokens**. The agent now knows the platform has one top-level domain (`reservation`) and what it covers. It has not paid for any operation schema yet.

### Step 2 — navigate to a module

```json
// Agent calls: explore({ path: "reservation" })
{
  "path": "reservation",
  "title": "Reservation",
  "submodules": [
    { "path": "reservation.availability", "title": "Availability", "description": "Search for open time slots by date and party size." },
    { "path": "reservation.booking",      "title": "Booking",      "description": "Create and cancel reservations. Write operations — confirmation required for destructive actions." },
    { "path": "reservation.search",       "title": "Search",       "description": "Look up existing reservations by ID or list all reservations for the current user." },
    { "path": "reservation.admin",        "title": "Admin",        "description": "Cross-user reservation management. Available to support and admin roles only." }
  ],
  "functions": []
}
```

Cost: **~194 tokens** cumulative. The agent can see all four sub-modules and their descriptions. No schemas yet.

### Step 3 — inspect a leaf module

```json
// Agent calls: explore({ path: "reservation.booking" })
{
  "path": "reservation.booking",
  "title": "Booking",
  "submodules": [],
  "functions": [
    {
      "name": "createReservation",
      "title": "Create Reservation",
      "description": "Book a specific available slot. Requires a slotId from searchAvailability, the guest name, and party size.",
      "permission": "write",
      "parallelSafe": false
    },
    {
      "name": "cancelReservation",
      "title": "Cancel Reservation",
      "description": "Cancel an existing reservation by ID. This is a destructive action — confirmation is required.",
      "permission": "write",
      "parallelSafe": false,
      "requiresConfirmation": true
    }
  ]
}
```

Cost: **~385 tokens** cumulative (all three explore calls). The agent now knows what functions exist, their permission level, and which require confirmation — without receiving a single `inputSchema`.

**Wildcard shortcut** — skip straight to all sub-modules at once:

```json
// Agent calls: explore({ path: "reservation.*" })
// Returns all four sub-module nodes with their functions in one response
// Cost: ~446 tokens — useful when the task spans multiple modules
```

**Multi-path shortcut** — fetch several nodes in one call:

```json
// Agent calls: explore({ path: ["reservation.booking", "reservation.search"] })
// Returns both nodes. One round-trip, two modules.
```

### Step 4 — get the full schema before calling

`explore()` returns a lightweight function summary (name, description, permission, parallelSafe). To get the exact `inputSchema` before invoking, call `describe_tool`:

```json
// Agent calls: describe_tool({ name: "searchAvailability" })
{
  "name": "searchAvailability",
  "description": "Search available booking slots for a given date and party size.",
  "permission": "read",
  "parallelSafe": true,
  "inputSchema": {
    "type": "object",
    "properties": {
      "date":      { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$", "description": "Date to search in YYYY-MM-DD format" },
      "partySize": { "type": "integer", "minimum": 1, "maximum": 20, "description": "Number of people in the party" }
    },
    "required": ["date", "partySize"]
  }
}
```

You can describe multiple tools in one call: `describe_tool({ name: ["searchAvailability", "createReservation"] })`.

### Path A — load tools for the session

Use this when the agent will call the same operations repeatedly. After loading, the operations appear as native MCP tools in `tools/list` and the agent can call them directly.

```
1. explore()                                    → see platform manifest (92 tokens)
2. explore({ path: "reservation.booking" })     → see booking functions (191 tokens)
3. load_tools({ names: ["createReservation",    → promote to native tools
                         "searchAvailability"] })
4. [re-fetch tools/list]                        → both ops now appear
5. searchAvailability({ date, partySize })       → call natively
6. createReservation({ slotId, name, partySize }) → call natively
```

Load state is **per-token, per-session**. Loaded tools persist for the duration of the agent's bearer token (8 hours) and survive across multiple requests in the same session. Different agents get independent load states even if they connect simultaneously.

To clean up: `unload_tools({ names: ["createReservation"] })` removes the tool from `tools/list` for that session. Useful when an agent finishes a task and wants to reduce its active surface area.

**Token cost of Path A:**  
- Discovery: ~385 tokens (3 explore calls)  
- Per-call after loading: only the call itself — no schema overhead  
- Total for 5 subsequent calls: 385 + (5 × ~50) = ~635 tokens

### Path B — invoke once without loading

Use this for one-off calls where loading and re-fetching tools/list would cost more than it saves. `invoke` is always-on and requires no session state.

```json
// Single call:
invoke({ "name": "searchAvailability", "args": { "date": "2026-07-15", "partySize": 2 } })

// Batch — read operations run in parallel, writes run sequentially:
invoke({
  "calls": [
    { "name": "searchAvailability", "args": { "date": "2026-07-15", "partySize": 2 } },
    { "name": "listReservations",   "args": {} }
  ]
})
// → { "results": [ <availability>, <reservations> ] }
// Both read ops ran concurrently — one round-trip, two results.
```

The batch form is smart about ordering: `parallelSafe: true` operations (all reads) run concurrently; `parallelSafe: false` operations (writes) run sequentially in submission order. Mixed batches are fine — reads fire in parallel while writes queue.

**Token cost of Path B (single call):**  
- No discovery needed if the agent already knows the function name  
- One call, one response: ~50 input tokens + ~150 output tokens  
- Total: ~200 tokens

### Choosing between Path A and Path B

| Situation | Use |
|---|---|
| Agent will call the same operations 3+ times in a session | Path A — load once, call cheaply |
| Agent needs one result and moves on | Path B — invoke directly |
| Agent doesn't know what the platform offers yet | `explore()` first, then either path |
| Agent knows the function name, not the schema | `describe_tool()` then Path B |
| Agent needs two read results simultaneously | Path B batch — one round-trip |

### Token cost: progressive vs dump-all

The reason this matters at scale:

| Strategy | Tokens in context (7-op platform) | Tokens in context (50-op platform) |
|---|---|---|
| Dump all ops at connect | ~700 every request | ~5,000 every request |
| Progressive — load 2 ops | ~385 discovery + ~100 per call | ~385 discovery + ~100 per call |
| Progressive — invoke once | ~200 for the call | ~200 for the call |

A 50-operation enterprise platform (CRM, finance, housekeeping, front-office) costs **5,000 tokens per request** if all tools are loaded. With progressive disclosure, an agent doing a single booking task pays ~200 tokens regardless of how large the platform grows.

### Adding a module to the tree

In `lib/modules.ts`, add an entry to `MODULE_DEFS`:

```typescript
{
  path: "crm",
  title: "CRM",
  description: "Guest profiles, loyalty status, and communication history.",
},
{
  path: "crm.guests",
  title: "Guests",
  description: "Search and update guest records.",
},
```

Then set `module: "crm.guests"` on each operation that belongs there. The tree builds automatically — `explore({ path: "crm" })` will return `crm.guests` as a submodule, and `explore({ path: "crm.guests" })` will list its functions.

---

## Benchmark

Run a live comparison of the 3-call MCP approach vs the composite `book()` tool:

```bash
# Start the server
npm run dev

# Login and get your session cookie, then:
node benchmark.mjs <session-cookie>
```

Results from a typical run (local, near-zero latency):

```
  TOTALS (10 reservations each)
  ─────────────────────────────────────────────────────────────────────────────────────
  Metric                           3-call MCP         book()        Savings
  ─────────────────────────────────────────────────────────────────────────────────────
  HTTP calls (total)                       30             10          66.7%
  Input tokens (new per call)             581            241          58.5%
  Output tokens                          1842            560          69.6%
  Cumulative context tokens              3251              0         100.0%
  TOTAL TOKENS                           5674            801          85.9%
```

Token model: 1 token ≈ 4 characters. Cumulative = prior context the model re-reads on each subsequent call. Timing in the infographic uses 100ms RTT + 900ms LLM reasoning per inter-call gap.

Open `docs/infographic-book-comparison.html` in a browser for a visual breakdown with annotated call timelines.

---

## Adding your own composite tool

1. **Create `lib/ui-tools/your-tool.ts`** — a plain async function that calls `serverCall()` and returns `Result<T>`:

```typescript
"use client";
import { serverCall } from "@/app/providers";
import { ok, fail } from "@/lib/result";

export async function yourTool(input: YourInput) {
  // step 1
  const a = await serverCall("existingOp", { ...input });
  if (!a.success) return fail(a.error.code, a.error.message);

  // step 2
  const b = await serverCall("anotherOp", { id: a.data.id });
  if (!b.success) return fail(b.error.code, b.error.message);

  return ok({ result: b.data, validated: true });
}
```

2. **Register it in `app/providers.tsx`** — inside the `useEffect` that fires after auth:

```typescript
import { yourTool } from "@/lib/ui-tools/your-tool";

// inside the useEffect:
document.modelContext.registerTool({
  name: "yourTool",
  title: "Your Tool",
  description: "Does X in one step — prefer this over calling A + B separately.",
  inputSchema: { /* JSON Schema */ },
  execute: (input) => yourTool(input as unknown as YourInput),
});
```

3. **Use the same function in your UI** — one code path, one source of business logic.

That's it. The tool is now discoverable by in-page agents via `document.modelContext.getTools()` and callable via `document.modelContext.executeTool("yourTool", {...})`.

---

## Adding a server-side operation

For operations that should also appear on the MCP HTTP surface (external agents):

1. **Create `lib/operations/your-op.ts`** using `defineOperation`:

```typescript
import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok, fail } from "@/lib/result";

export const yourOp = defineOperation({
  name: "yourOp",
  title: "Your Op",
  description: "...",
  permission: "read",           // "read" | "write"
  roles: ["customer", "admin"], // who can call it
  module: "reservation.search", // where explore() shows it
  tags: ["booking"],
  inputSchema: {
    id: z.string().describe("Resource ID"),
  },
  async handler({ id }, ctx) {
    const result = store.getItem(id, ctx.userId);
    if (!result) return fail("NOT_FOUND", `Item ${id} not found`);
    return ok({ result });
  },
});
```

2. **Register it in `lib/operations/index.ts`**:

```typescript
import { yourOp } from "./your-op";
registry.push(yourOp);
```

The operation automatically appears on both the MCP HTTP surface and the in-page WebMCP surface (via the adapters in `lib/adapters/`), with full RBAC, audit logging, and progressive disclosure.

---

## Security model

| Control | Implementation |
|---|---|
| Authentication | Session cookie (UI) + Bearer token (MCP HTTP) |
| RBAC | Per-operation `roles` array; checked on every call |
| Destructive confirmations | `requiresConfirmation: true` — UI shows dialog, agent must pass `confirm: true` |
| Audit log | Every call (agent + UI) recorded with tool name, success, caller type |
| Capability versioning | `getCapabilities()` returns a hash — agent can detect registry changes |

---

## WebMCP standard relationship

This project implements the WebMCP draft standard (`document.modelContext`), incubated by the W3C Web Machine Learning Community Group (Microsoft + Google).

**What WebMCP provides:**
- Browser-native `document.modelContext` object
- `registerTool(tool, options)` — registers a named tool with a JSON Schema and `execute` function
- `ontoolchange` event — fires on tool registration/unregistration
- `SecureContext` enforcement (HTTPS only)
- `Permissions-Policy: tools` feature flag

**What AgentBridge adds on top:**
- `permission` scopes (`read` / `write`)
- RBAC (`roles` per operation)
- `requiresConfirmation` gates
- Audit logging
- Progressive tool disclosure (`explore` / `load_tools`)
- Capability version hashing
- `executeBatch` for parallel/sequential multi-call
- Polyfill for browsers without native `document.modelContext`

The polyfill (`lib/webmcp-polyfill.ts`) installs a full `ModelContextImpl` on `document.modelContext` if the browser doesn't provide one natively, and is a no-op once the standard ships.

---

## Project structure

```
app/
  page.tsx              ← root page (Providers + BookingApp)
  providers.tsx         ← auth context, book() registration, SSE events
  layout.tsx
  login/page.tsx
  api/
    [transport]/route.ts ← MCP Streamable HTTP (GET/POST)
    call/route.ts        ← UI op dispatcher
    events/route.ts      ← SSE stream (store + audit events)
    me/route.ts          ← session → user + agent token
    login/route.ts
    logout/route.ts
    admin/users/route.ts
    audit/route.ts

components/
  BookingApp.tsx         ← main UI (uses book() for the booking form)
  AvailabilityList.tsx
  ReservationList.tsx
  ActivityLog.tsx
  UsersPanel.tsx

lib/
  operations/            ← server-side op registry (see above)
  ui-tools/
    book.ts              ← composite frontend-orchestrated booking tool
  adapters/
    mcp.ts               ← registry → MCP server tools
    webmcp.ts            ← registry → document.modelContext
  agentbridge.ts         ← AgentBridge SDK class
  webmcp-polyfill.ts     ← document.modelContext shim
  modules.ts             ← module tree + explore() helpers
  capabilities.ts        ← version-hashed capability manifest
  store.ts               ← in-memory BookingStore singleton
  auditlog.ts            ← AuditLog singleton
  auth.ts                ← users, sessions, tokens, RBAC
  result.ts              ← ok() / fail() result envelope

benchmark.mjs            ← 3-call vs book() token + timing benchmark
docs/
  infographic-book-comparison.html  ← visual benchmark results (open in browser)
```

---

## Tech stack

- **Next.js 15** (App Router, React 19)
- **TypeScript 5**
- **Zod** — runtime input validation, JSON Schema generation
- **`@modelcontextprotocol/sdk`** — MCP server + transport
- **`mcp-handler`** — Next.js MCP route handler
- **`zod-to-json-schema`** — Zod → JSON Schema for WebMCP tool registration

---

## License

MIT
