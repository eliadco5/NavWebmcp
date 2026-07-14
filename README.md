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

## Progressive tool disclosure (MCP HTTP surface)

The MCP HTTP surface intentionally keeps the tool list lean. Only always-on meta-tools appear in `tools/list` by default — business operations are hidden until discovered. This prevents context-window bloat when an agent connects.

**Path A — load for the session (repeated calls):**
```
explore()                           → see the module tree
explore("reservation.booking")      → see functions in that module
load_tools({ names: ["book", ...] }) → promote to native tools
# re-fetch tools/list — book now appears
book({ date, time, partySize, name })
```

**Path B — invoke once without loading:**
```
explore("reservation.booking")
invoke({ name: "book", args: { date, time, partySize, name } })
```

The always-on `invoke` tool is a zero-overhead escape hatch — no session state, no re-fetch required.

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
infographic-book-comparison.html  ← visual benchmark results
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
