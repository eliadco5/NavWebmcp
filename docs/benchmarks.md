# Benchmarks: efficiency, cost, effectiveness

Every number here is measured, not estimated:
- MCP lanes use the real MCP Streamable HTTP transport.
- WebMCP and UI-automation lanes use a real headless browser.
- Each lane runs `n=5` times on a production build, with `REDIS_URL` unset.
- Tokens are counted as 1 token ≈ 4 characters.

The numbers below come from NavWebMcp **2.5.0** (MCP SDK v2). The data is committed in [`bench-results.json`](bench-results.json) (default format), [`bench-results-compact.json`](bench-results-compact.json) (compact text, MCP lanes only) and [`speedbase-results.json`](speedbase-results.json). Latency depends on the machine, so compare lanes within one run, not across machines. Every lane succeeded 5/5.

## The lanes

| Lane | What it does | Transport |
|---|---|---|
| A-native | `load_tools([...])` once, then one native tool call per step | MCP HTTP |
| A-invoke | `invoke({ name, args })` per step, no load step | MCP HTTP |
| A-invoke-chained | All the steps as one dependent batch, `invoke({ calls })` with `$ref` (≥ 2.2.0) | MCP HTTP |
| B | The composite operation (`book`, `seatGuest`, `hostVipGuest`) | MCP HTTP |
| C-raw | The primitive operations, one at a time, from a loaded page | Real browser |
| C | The composite through `document.modelContext` (WebMCP) | Real browser |
| D | Playwright drives the real UI, click by click | Real browser |

## Composite vs. multi-call: the booking flow

| Lane | Calls | Avg latency | Tokens per booking* |
|---|---|---|---|
| A-native | 3 | 12 ms | 586 |
| A-invoke | 3 | 12 ms | 582 |
| A-invoke-chained | 1 | 5 ms | 580 |
| **B: `book()` composite** | **1** | **4 ms** | **192** |
| C-raw | 3 | 38 ms | 419 |
| **C: `book()` composite (WebMCP)** | **1** | **17 ms** | **158** |
| D: Playwright | 7 clicks | 449 ms | 9,295† |

\* Input + output tokens. This excludes the one-time tool-schema cost of `load_tools` (80 tokens for A-native, 41 for B).
† Cumulative accessibility-tree tokens an agent would read before each click. It isn't directly comparable with the other rows, but that's the point: no other lane pays it.

**On MCP, the composite uses 67 % fewer tokens and is 67 % faster than three `invoke` calls. On WebMCP, it uses 62 % fewer tokens and is 55 % faster than three calls from the same page.**

A dependent batch (A-invoke-chained) is close to the composite on latency (one round trip), but not on tokens: its reply carries every call's full result. To save tokens there, use compact text (below).

## It compounds with scope

A-invoke (one call per step) against B (the composite), default text format:

| Flow | Calls | Tokens | Latency |
|---|---|---|---|
| `booking`: search, book, verify | 3 → 1 | 582 → 192 (−67 %) | 12 → 4 ms (−67 %) |
| `checkin`: occupancy, check in, verify | 3 → 1 | 420 → 63 (−85 %) | 11 → 4 ms (−64 %) |
| `journey`: book and seat a guest in one session | 6 → 2 | 998 → 254 (−75 %) | 24 → 8 ms (−67 %) |
| `vip`: 7 steps across CRM and the front desk | 7 → 1 | 982 → 349 (−64 %) | 36 → 6 ms (−83 %) |

In the `journey` flow, the Playwright lane (one continuous UI session doing both actions) takes **1,245 ms** and reads **18,450** accessibility-tree tokens. The two composite calls take **8 ms** and **254** tokens. The `vip` flow has no Playwright lane.

## Compact text (≥ 2.3.0)

MCP results carry their JSON twice: once as `structuredContent`, and once as a text block, which is what most hosts show the model. The text block is indented by default. With `?format=compact` on the MCP URL (see [protocol.md § 6](protocol.md#6-compact-text-results--230)), it isn't:

| Flow | A-invoke | A-invoke-chained | B (composite) |
|---|---|---|---|
| booking | 582 → 442 (−24 %) | 580 → 383 (−34 %) | 192 → 155 (−19 %) |
| checkin | 420 → 315 (−25 %) | 575 → 344 (−40 %) | 63 → 53 (−16 %) |
| journey | 998 → 755 (−24 %) | 1,144 → 718 (−37 %) | 254 → 206 (−19 %) |
| vip | 982 → 763 (−22 %) | 1,297 → 815 (−37 %) | 349 → 270 (−23 %) |

Tokens are input + output per flow. The one-time schema cost of `load_tools` also drops, by 21–33 %. Nested replies gain the most, because indentation grows with nesting depth. With compact text, a dependent batch costs fewer tokens than one call per step in two of the four flows (booking and journey). Composites are still the cheapest.

## Testing the architecture, not just the agent

How long does it take to *test* the business logic? `runOne()` (`lib/operations/dispatch.ts`) called in-process (no HTTP, MCP or browser), against a Playwright script driving the same scenario through the UI:

| Scenario | Function call | Playwright | Speedup |
|---|---|---|---|
| `book()` | 1.41 ms | 435 ms | **308×** |
| `seatGuest()` | 0.52 ms | 646 ms | **1,252×** |
| `hostVipGuest()` | 1.40 ms | not measured | — |

It's the same Zod validation, the same RBAC and the same handler code as every other lane, just without a transport. This is the argument for testing the Operation layer directly instead of only through end-to-end browser tests. `hostVipGuest` has a button in the Front Desk tab, but the Playwright harness has no script for it.

## Reproduce

```bash
npm run build && REDIS_URL= npm start          # separate terminal; both scripts need a running server

node scripts/bench.mjs --n=5                   # agent transports: booking, checkin, journey, vip
node scripts/bench.mjs --n=5 --lane=a,b --format=compact   # MCP lanes with compact text
node scripts/speedbase.mjs --n=5               # test speed: function call vs Playwright

node scripts/bench.mjs --flow=checkin --headed --slowmo=250 --demo   # watch a lane live
```

- **Unset `REDIS_URL`.** `.env.local` may point at a remote Redis, which adds about 300 ms to every call.
- **Output files.** The scripts write `docs/bench-results.json` and `docs/speedbase-results.json`, plus `docs/*-data.js` (not committed). If you re-run them, update this page from the new files.
- **To compare a change against `master`,** build `master` in a temporary worktree, serve it on another port, and run `BENCH_BASE=http://localhost:3001 node scripts/bench.mjs` from that worktree.
- **Keep the Playwright lane (D) in step with the UI.** It drives the real, tabbed UI. Each step first selects its own tab (Reservations or Front Desk), including after a reload, and matches labels exactly. A loose match would also hit Activity Log rows such as `searchAvailability`, or the walk-in "Party size" input that shares the Reservations tab. If you rename a tab or a form label, update `scripts/bench.mjs` to match.
