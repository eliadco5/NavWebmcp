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

The result (measured with `node benchmark.mjs`, localhost, in-memory store, 10 bookings each):

| Metric | 3-call MCP | book() WebMCP | book-op MCP | Saving (vs 3-call) |
|---|---|---|---|---|
| Agent-facing HTTP calls | 30 | 10 | 10 | 66.7% |
| Input tokens | 581 | 250 | 250 | 57.0% |
| Output tokens | 1,842 | 561 | 561 | 69.5% |
| Cumulative context tokens | 3,251 | 0 | 0 | 100.0% |
| **Total tokens** | **5,674** | **811** | **811** | **85.7%** |
| Wall-clock total (ms) | 911 | 984 | **300** | **67.1%** |
| Wall-clock avg per booking | 91ms | 98ms | **30ms** | **67.1%** |

**book() WebMCP** and **book-op MCP** are token-identical to the agent (same single-call schema, same compact response). Wall-clock differs: WebMCP still makes 3 HTTP sub-calls internally from the browser; book-op MCP dispatches all 3 ops in-process with zero additional network hops — **3× faster** than the WebMCP path, **3× faster** than 3-call MCP.

*Token model: 1 token ≈ 4 characters. Cumulative = prior tool results the model re-reads on each subsequent call.*

### Two surfaces, one registry

The same operation registry exposes tools on two surfaces simultaneously:

| Surface | How agents connect | What's exposed |
|---|---|---|
| **In-page WebMCP** | Browser / in-page agents via `document.modelContext` | All ops + composite tools (e.g. `book`) |
| **MCP Streamable HTTP** | Claude Code, Claude Desktop, MCP Inspector | All ops including `book` via progressive disclosure |

Both surfaces expose `book()`. The same orchestration logic runs on both — the only difference is how sub-operations are dispatched: `fetch("/api/call")` with a session cookie in the browser, in-process handler calls on the server. Business logic lives in one place (`lib/core/book.ts`) and is injected with the appropriate caller.

---

## Architecture

```
lib/core/                ← surface-agnostic business logic
  book.ts                ← bookOrchestration() — the 3-step booking logic, caller-injected

lib/operations/          ← single source of truth for all operations
  types.ts               ← Operation descriptor type + defineOperation helper
  index.ts               ← registry array
  *.ts                   ← one file per operation
  book-op.ts             ← book as an MCP-registered operation (uses lib/core/book.ts)
  dispatch.ts            ← in-process dispatcher: runOne(), makeDispatch(ctx)

lib/ui-tools/            ← thin browser wrappers over lib/core/
  book.ts                ← book() — injects serverCall into bookOrchestration

lib/adapters/
  mcp.ts                 ← registry → MCP tools (McpServer.registerTool)
  webmcp.ts              ← registry → in-page document.modelContext

app/
  providers.tsx          ← registers book() into document.modelContext after auth
  api/[transport]/       ← MCP Streamable HTTP endpoint
  api/call/              ← UI call route (used by frontend book wrapper)

lib/agentbridge.ts       ← AgentBridge SDK (register, call, describe, subscribe)
lib/webmcp-polyfill.ts   ← document.modelContext shim for pre-standard browsers
lib/modules.ts           ← module tree for progressive tool disclosure
lib/store.ts             ← in-memory reservation state + event emitter
lib/auditlog.ts          ← audit log (agent + UI calls, shown in UI)
lib/auth.ts              ← RBAC: customer / support / admin roles
lib/capabilities.ts      ← version-hashed capability manifest
```

### How book() works

The same three-step orchestration runs on both surfaces. The only difference is the `call` function injected into the shared core:

```
book({ date, time, partySize, name })
  │
  ├─ 1. AVAILABILITY  → call("searchAvailability", { date, partySize })
  │                       pick slot matching time
  │                       none? → fail("NO_AVAILABILITY")
  │
  ├─ 2. RESERVATION   → call("createReservation", { slotId, name, partySize })
  │                       fail? → propagate error
  │
  └─ 3. VALIDATE      → Promise.all([
                           call("getReservation", { reservationId }),  // exists?
                           call("searchAvailability", { date, partySize }) // slot gone?
                         ])
                         inconsistent? → call("cancelReservation", ...) (rollback)
                                       → fail("VALIDATION_FAILED")
                         ok? → return { reservation, validated: true }
```

The agent sees none of steps 1–3. It sends one `book()` call and receives a validated booking.

**How `call` is wired per surface:**

| Surface | `call` implementation | Auth |
|---|---|---|
| In-page WebMCP | `serverCall` → `fetch("/api/call")` | Session cookie |
| MCP Streamable HTTP | `makeDispatch(ctx)` → handler called in-process | Bearer token (ctx) |

Both use the same core in `lib/core/book.ts`. RBAC, validation, and audit logging apply on every sub-call regardless of surface.

---

## Available operations

### Always-on (always in tools/list)

| Name | Description |
|---|---|
| `explore` | Navigate the platform module tree by known path |
| `search` | Find functions/modules by Linux-style path glob, anywhere in the tree |
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

### Composite tools (both surfaces)

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

// Use the composite book() tool (one call — full orchestration runs in the browser)
await document.modelContext.executeTool("book", {
  date: "2026-07-15",
  time: "18:00",
  partySize: 2,
  name: "Alice"
})
// → { success: true, data: { reservation: {...}, validated: true } }

// Search across the whole tree by glob — no need to know which module
await document.modelContext.executeTool("search", { pattern: "**/*reservation*" })
// → { functions: [{ name, module, permission, … }], modules: [{ path, title }] }

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

### Search — find by pattern, not by location

`explore()` is navigation: you walk a path you already know (`reservation.booking`).
`search()` is discovery: you describe *what* you're looking for and get every matching
function and module back — no guessing which part of the tree holds it.

Patterns are Linux-style globs matched against `module/path/functionName` strings:
- `*` — any characters within one path segment
- `**` — any number of segments (any depth)
- `?` — exactly one character
- A bare keyword (no metachar, no `/`) is auto-expanded to `**/*keyword*`

```json
// "Give me everything related to reservations"
search({ "pattern": "**/*reservation*" })
// → {
//     "functions": [
//       { "name": "createReservation", "module": "reservation.booking",      "permission": "write", … },
//       { "name": "cancelReservation", "module": "reservation.booking",      "permission": "write", … },
//       { "name": "searchAvailability","module": "reservation.availability", "permission": "read",  … },
//       { "name": "listReservations",  "module": "reservation.search",       "permission": "read",  … },
//       { "name": "getReservation",    "module": "reservation.search",       "permission": "read",  … }
//     ],
//     "modules": [
//       { "path": "reservation",              "title": "Reservation" },
//       { "path": "reservation.availability", "title": "Availability" },
//       { "path": "reservation.booking",      "title": "Booking" },
//       …
//     ]
//   }

// Bare keyword — identical result (auto-expanded to **/*reservation*)
search({ "pattern": "reservation" })

// Scoped to a top-level domain
search({ "pattern": "finance/**" })

// Single function by name fragment
search({ "pattern": "*refund*" })
// → { functions: [{ name: "issueRefund", module: "finance.adjustments", … }], modules: [] }
```

Search is role-scoped: a `customer` token running `search({ pattern: "finance/**" })`
returns nothing — finance is admin-only and the results are filtered by the caller's role.

Search works identically on the in-page WebMCP surface:
```javascript
await document.modelContext.executeTool("search", { pattern: "**/*reservation*" })
```

Use `search()` to orient yourself quickly, then follow up with `explore("module.path")`
for sub-module detail or `describe_tool(name)` for full input schemas.

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

## Agent instructions (upfront information gathering)

Without explicit instructions, agents tend to ask one question at a time — a chatty sequential Q&A that wastes tokens and adds unnecessary round-trips before any work begins. The instructions feature solves this by delivering a behavioural contract to every agent at connect time, so they gather everything they need in one pass.

### How it works

Both surfaces share a single source of truth in `lib/agent-instructions.ts`. Each surface delivers the string via its own connect-time mechanism:

| Surface | Delivery mechanism | When the agent receives it |
|---|---|---|
| **MCP HTTP** | `initialize` handshake response (`result.instructions`) | Automatically at connect — no agent code needed |
| **WebMCP in-page** | `document.modelContext.instructions` | Readable by browser agents after page load |

```typescript
// MCP HTTP — received automatically at connect, no agent code needed
// lib/agent-instructions.ts → app/api/[transport]/route.ts → initialize.instructions

// WebMCP in-page — readable by browser agents
document.modelContext.instructions  // → string with behavioral rules
```

Both `app/api/[transport]/route.ts` (via `serverOptions.instructions`) and `lib/adapters/webmcp.ts` (via `initAgentBridge`) import from `lib/agent-instructions.ts`.

### What the instructions enforce

- Call `explore()` and/or `search()` first to discover all required parameters
- Identify every missing value in one pass before surfacing anything to the user
- Ask for ALL missing information in a single message — never sequential one-at-a-time questions
- Only execute write operations after all parameters are confirmed

### How to customise

Edit `lib/agent-instructions.ts` — the change flows automatically to both surfaces.

For the in-page surface you can also override per-bridge via `AgentBridgeOptions.instructions`:

```typescript
initAgentBridge({ instructions: "Your custom instructions here." });
```

---

## Benchmark

Run a live three-way comparison: 3-call MCP vs book() WebMCP vs book-op MCP:

```bash
# Start the server
npm run dev

# Login and get your session cookie, then:
node benchmark.mjs <session-cookie>
```

Results from a typical run (local, in-memory store, 10 bookings per approach):

```
  TOTALS (10 reservations each)
  ──────────────────────────────────────────────────────────────────────────────────────────
  Metric                              3-call MCP   book() WebMCP   book-op MCP   vs 3-call
  ──────────────────────────────────────────────────────────────────────────────────────────
  Wall-clock total (ms)                      911             984           300      67.1%
  Wall-clock avg (ms)                       91.1            98.4          30.0      67.1%
  HTTP calls (total)                          30              10            10      66.7%
  Input tokens                               581             250           250      57.0%
  Output tokens                             1842             561           561      69.5%
  Cumulative context toks                   3251               0             0     100.0%
  TOTAL TOKENS                              5674             811           811      85.7%
```

Token model: 1 token ≈ 4 characters. Cumulative = prior tool results the model re-reads on each subsequent call.

**What the numbers show:**
- Both `book()` approaches save ~85.7% of total tokens vs 3-call, and eliminate all context accumulation.
- `book-op MCP` is the fastest path (30ms avg): all 3 sub-operations run in-process with no additional HTTP hops.
- `book() WebMCP` (98ms avg) still makes 3 HTTP sub-calls internally from the browser, so wall-clock is similar to 3-call MCP despite the token savings.

Open `docs/infographic-book-comparison.html` in a browser for a visual breakdown with annotated call timelines.

---

## Adding your own composite tool

A composite tool has three layers: a surface-agnostic core, a thin browser wrapper, and an MCP operation. All three share the same orchestration logic.

### 1. Create `lib/core/your-tool.ts` — no `"use client"`, takes a `call` dependency

```typescript
import { ok, fail } from "@/lib/result";
import type { Result } from "@/lib/result";

export interface YourInput { /* ... */ }
export interface YourResult { /* ... */ }

export async function yourToolOrchestration(
  input: YourInput,
  call: (name: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<Result<YourResult>> {
  const a = await call("existingOp", { ...input }) as { success: boolean; data?: ...; error?: ... };
  if (!a.success) return fail(a.error?.code ?? "ERR", a.error?.message ?? "Failed");

  const b = await call("anotherOp", { id: a.data!.id }) as { success: boolean; data?: ...; error?: ... };
  if (!b.success) return fail(b.error?.code ?? "ERR", b.error?.message ?? "Failed");

  return ok({ result: b.data, validated: true });
}
```

### 2. Create `lib/ui-tools/your-tool.ts` — thin browser wrapper

```typescript
"use client";
import { serverCall } from "@/app/providers";
import { yourToolOrchestration } from "@/lib/core/your-tool";
export type { YourInput, YourResult } from "@/lib/core/your-tool";

export const yourTool = (input: YourInput) => yourToolOrchestration(input, serverCall);
```

### 3. Register it in `app/providers.tsx` — inside the `useEffect` that fires after auth

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

### 4. Create `lib/operations/your-tool-op.ts` — MCP surface

```typescript
import { z } from "zod";
import { defineOperation } from "./types";
import { yourToolOrchestration } from "@/lib/core/your-tool";
import { makeDispatch } from "./dispatch";

export const yourToolOp = defineOperation({
  name: "yourTool",
  title: "Your Tool",
  description: "Does X in one step.",
  permission: "write",
  roles: ["customer", "admin"],
  module: "your.module",
  tags: ["your-tag"],
  inputSchema: { /* zod shape */ },
  async handler(input, ctx) {
    return yourToolOrchestration(input, makeDispatch(ctx));
  },
});
```

### 5. Register in `lib/operations/index.ts`

```typescript
import { yourToolOp } from "./your-tool-op";
registry.push(yourToolOp);
```

The tool is now callable on both surfaces: in-page agents use `document.modelContext.executeTool("yourTool", {...})`; external agents discover it via `explore()`/`search()` and call it via `invoke()` or after `load_tools()`.

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
  core/
    book.ts              ← surface-agnostic booking orchestration (shared by both surfaces)
  operations/            ← server-side op registry (see above)
    book-op.ts           ← book as an MCP operation; injects makeDispatch(ctx)
    dispatch.ts          ← in-process dispatcher: runOne(), makeDispatch(ctx)
  ui-tools/
    book.ts              ← thin browser wrapper; injects serverCall into lib/core/book
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
