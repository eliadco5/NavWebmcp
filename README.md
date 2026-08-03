# WebMCP / AgentBridge

**Business logic that lives in the browser page, exposed to agents as structured tools — one function call instead of many.**

WebMCP (`document.modelContext`) is a browser-native API letting a page register callable tools for AI agents. **NavWebMcp** is the protocol layered on top — progressive tool disclosure, RBAC, composite operations. **AgentBridge** is this repo's reference implementation, adding an MCP Streamable HTTP surface so external agents (Claude Code, Claude Desktop, MCP Inspector) can connect with no browser required.

Built on [Next.js](https://nextjs.org) and the [Model Context Protocol](https://modelcontextprotocol.io).

---

## Benchmarks — efficiency, cost, effectiveness

All numbers below are measured, not estimated: real MCP Streamable HTTP transport, a real headless browser for the WebMCP and UI-automation lanes, `n=5` runs, production build. Reproduce with the commands at the end of this section. Token model: 1 token ≈ 4 characters (`chars/4`).

### Composite calls vs. multi-call orchestration — booking flow

| Lane | Transport | Calls/booking | Avg latency | Tokens/booking* |
|---|---|---|---|---|
| Raw MCP (`load_tools` + native) | Real MCP HTTP | 3 | 49 ms | 366 |
| Raw MCP (`invoke`, no load step) | Real MCP HTTP | 3 | 59 ms | 418 |
| **`book()` composite** | Real MCP HTTP | **1** | **16 ms** | **91** |
| **`book()` composite** | Real browser (WebMCP) | **1** | **39 ms** | **75** |
| Playwright UI automation | Real browser, 7 clicks | 1 user action | 422 ms | 5,710† |

\* input + output tokens, excludes the one-time tool-schema cost of `load_tools`. † cumulative accessibility-tree tokens an agent would need to *read* the page before each click — not directly comparable to the other rows, but that's the point: it's the cost nothing else on this list pays.

**Composite call vs. raw multi-call: −78 to −80% tokens, per booking, on both surfaces.** Latency drops −67 to −73% over MCP; the WebMCP composite is a smaller −20 to −34% win since it's still driven from inside a real browser page. All lanes succeeded 5/5 — the savings cost nothing in reliability.

### It compounds with scope

| Scenario | Raw calls | Composite calls | Token saving | Latency saving |
|---|---|---|---|---|
| `book` — 3-op booking | 3 | 1 | −75% | −67% |
| `journey` — book + seat a guest (2 real actions, one session) | 6 | 2 | −80% | −65% |
| `vip` — 7-op chain across CRM + front desk | 7 | 1 | −68% | −84% |

The `journey` flow's Playwright lane (one continuous UI session doing both actions) costs **818 ms** and **11,292 cumulative tokens** of DOM reads — versus **35 ms** and **154 tokens** for the two composite calls. The `vip` flow has no Playwright row at all: CRM has no UI in this app, so there's nothing to click — a real limit of browser automation that composite calls don't have.

### Testing the architecture, not just the agent

A separate question from the above: how long does it take to *test* the business logic itself? `runOne()` (`lib/operations/dispatch.ts`) called in-process — zero HTTP, zero MCP, zero browser — versus a Playwright script driving the same scenario through the UI:

| Scenario | Function call | Playwright | Speedup |
|---|---|---|---|
| `book()` | 0.89 ms | 388 ms | **437×** |
| `seatGuest()` | 0.35 ms | 459 ms | **1,314×** |
| `hostVipGuest()` | 0.18 ms | — (no UI exists) | — |

Same Zod validation, same RBAC, same handler code as every other lane — no transport at all. This is the argument for testing the Operation layer directly instead of only through end-to-end browser tests.

### Reproduce

```bash
npm run build && npm start          # separate terminal — both scripts need a running server

node scripts/bench.mjs --n=5        # agent-transport comparison: booking, checkin, journey, vip
node scripts/speedbase.mjs --n=5    # test-execution speed: function call vs Playwright

node scripts/bench.mjs --flow=checkin --headed --slowmo=250 --demo   # watch a lane live
```

Both write their results to `docs/*-data.js` / `docs/*-results.json`. Open `docs/presentation.html` in a browser for the full slide deck with live numbers.

---

## How it works

Every raw-MCP approach makes the **agent** orchestrate multiple calls — parse a slot list, extract an ID, decide whether to validate, re-read growing context on every step. That sequencing knowledge lives in the prompt, re-processed on every call, and can hallucinate.

AgentBridge moves that orchestration into the page as a composite function registered on `document.modelContext`:

```
Agent → book({ date, time, partySize, name })  →  { reservation, validated: true }
```

One call. Zero reasoning gaps. The same orchestration (`lib/core/book.ts`) runs invisibly — in the browser (session-cookie auth) or in-process on the server (bearer-token auth) — with the same validation and rollback either way.

### One registry, two surfaces

| Surface | `call` implementation | Auth |
|---|---|---|
| In-page WebMCP | `serverCall` → `fetch("/api/call")` | Session cookie |
| MCP Streamable HTTP | `makeDispatch(ctx)` → handler in-process | Bearer token |

Adding an operation to `lib/operations/` and registering it in `lib/operations/index.ts` makes it available on both surfaces automatically, with RBAC, audit logging, and progressive disclosure.

### Progressive disclosure

Only 8 always-on meta tools (`explore`, `search`, `describe_tool`, `invoke`, `load_tools`, `unload_tools`, `getContext`, `getCapabilities`) appear at connect — about 180 tokens. Business operations are discovered on demand and either `invoke`d directly or promoted to native tools via `load_tools`. This cost stays flat regardless of registry size — the deck's slide 6 shows ~200 tokens at 50 operations vs. ~5,000 if all tools were dumped upfront.

### RBAC and confirmation

Every operation carries a `roles` array checked on every call: `customer` (own data), `support` (customer ops + cross-user read), `admin` (all ops). Destructive operations carry `requiresConfirmation: true`; for `cancelReservation`/`cancelAnyReservation` this is server-enforced via a `confirm` parameter — omitting it returns `CONFIRMATION_REQUIRED`.

### Gather-first, ask-once

`getContext` + `getCapabilities`, called in parallel on connect, tell the agent who the user is and what their role allows *before* it asks anything. Combined with the connect-time instructions (`lib/agent-instructions.ts`), the agent identifies every required parameter up front and asks the user one consolidated question instead of a sequential back-and-forth.

---

## Quick start

```bash
npm install
npm run dev
# Open http://localhost:3000
```

State is in-memory — resets on server restart.

### Connect an agent

```bash
claude mcp add --transport http booking http://localhost:3000/api/mcp
```

Then ask: *"Book me a table for 2 tomorrow evening."* Or use the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp
```

Pass `Authorization: Bearer <token>` — your token is shown in the UI after login.

| Username | Password | Role |
|---|---|---|
| alice | password | customer |
| carol | password | support |
| bob | password | admin |

### In-page WebMCP (browser console)

```javascript
document.modelContext.getTools().map(t => t.name)
// as admin/support: ["book", "seatGuest", "hostVipGuest"]
// as customer:       ["book"]

await document.modelContext.executeTool("book", {
  date: "2026-07-23", time: "18:00", partySize: 2, name: "Alice"
})
// → { success: true, data: { reservation: {...}, validated: true } }
```

`hostVipGuest` has no UI button — the CRM domain has no screens in this app — but it's registered and callable the same way, which is exactly what the speedbase table above measures.

---

## Reference

### Operations

56 operations: 8 always-on meta tools + 48 business operations across 6 domains.

| Domain | Ops | Notable composites |
|---|---|---|
| `reservation.*` | 8 | `book` — availability + create + validate |
| `crm.*` | 10 | |
| `frontoffice.*` | 11 | `seatGuest`, `hostVipGuest` (spans CRM too) |
| `tasks.*` | 6 | |
| `housekeeping.*` | 6 | |
| `finance.*` | 7 | |

Full catalogue with permissions and roles: browse `lib/operations/` (one file per op) or call `explore()`/`search()` against a running server. Module tree defined in `lib/modules.ts`.

### Security model

| Control | Implementation |
|---|---|
| Browser authentication | Session cookie |
| MCP HTTP authentication | RFC 8707 audience-bound Bearer token, 8-hour TTL |
| Input validation | Zod schema on every call |
| RBAC | Per-operation `roles` array, checked at every call boundary |
| Destructive confirmations | `requiresConfirmation: true` — UI dialog + agent must pass `confirm: true` |
| Audit log | Every call recorded; last 100 entries streamed via SSE (`/api/events`) |
| Capability versioning | DJB2 hash over op fingerprints — agents detect registry changes |

### Extending

A plain operation is one file in `lib/operations/` (`defineOperation({...})`) registered in `lib/operations/index.ts` — see any existing op for the shape. A composite tool is three thin layers: a surface-agnostic orchestration in `lib/core/` (takes a `call` dependency, no `"use client"`), a browser wrapper in `lib/ui-tools/` injecting `serverCall`, and an MCP operation in `lib/operations/` injecting `makeDispatch(ctx)` — `lib/core/seatGuest.ts` / `lib/operations/seatGuest-op.ts` / `lib/ui-tools/seatGuest.ts` is the shortest real example to copy.

### Benchmark scripts

- `scripts/bench.mjs` — agent-transport comparison (raw MCP, composite MCP, WebMCP, Playwright) across 4 flows. `--flow=`, `--lane=`, `--n=`, `--headed`, `--slowmo=`, `--demo`, `--dev`, `--verbose`.
- `scripts/speedbase.mjs` — function-call vs. Playwright test-execution speed. `--n=`, `--headed`, `--slowmo=`, `--demo`, `--verbose`.
- `tests/bench/operation-speed.test.ts` — the in-process timing `speedbase.mjs` spawns; runnable standalone via `npx vitest run tests/bench/operation-speed.test.ts --reporter=verbose`.
- `benchmark.mjs` (root) — an earlier, `/api/call`-only harness kept for provenance; superseded by the two above.

### Tech stack

Next.js 15 (App Router, React 19) · TypeScript 5 · Zod · `@modelcontextprotocol/sdk` · `mcp-handler` · `zod-to-json-schema` · Playwright · Vitest

---

## License

MIT
