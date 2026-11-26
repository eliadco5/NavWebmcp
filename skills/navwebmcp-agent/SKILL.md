---
name: navwebmcp-agent
version: 2.3.0
protocol: ">=2.0.0 <3.0.0"
description: >
  How to drive a NavWebMcp server efficiently. Use when connected to a server
  exposing progressive tool disclosure — the always-on meta operations explore,
  search, describe_tool, invoke, load_tools, unload_tools, getContext,
  getCapabilities — or when tools/list returns far fewer tools than the server
  claims. Covers the connect handshake, capability caching, discovery, sequential
  vs parallel vs bulk invocation, stateless invoke vs load_tools promotion,
  gather-first/ask-once, composite operations, the result and error shapes,
  operating on-screen UI components (ui_list, ui_get_state, ui_set_state,
  ui_action — filters, sort, tabs), and error handling. Consumer side only — not
  for building a server.
---

# NavWebMcp agent guide

NavWebMcp 2.x · skill revision 2.3.0. This document is valid for any server whose
`protocolVersion` satisfies `>=2.0.0 <3.0.0`. (On a 1.x server, a single `invoke` wraps
the result twice and bad input may be `INVALID_ARGS`; see the 2.0.0 changelog.) If the server reports a version outside
that range, trust its own `getCapabilities` / `describe_tool` output over this document —
the protocol may have changed shape.

## 1. What NavWebMcp is

```
WebMCP     — W3C Web Machine Learning CG draft standard (document.modelContext)
  └ NavWebMcp — progressive tool disclosure + RBAC + composite operations, layered on top
```

A NavWebMcp server exposes one operation registry over two possible surfaces — an MCP
Streamable HTTP endpoint (Bearer-token auth) and/or an in-page `document.modelContext`
(session auth) — with identical operation names and semantics on both. A reference
implementation exists (AgentBridge), but this guide is server-agnostic: any conformant
NavWebMcp server, in any language, behaves as described here.

## 2. Connect: preflight in one round-trip

On connect, before asking the user anything, call these two operations **in parallel**:

```json
getContext()        // → { authenticated, user, role, now, today, timezone, credits?, ... }
getCapabilities()   // → { protocolVersion, capabilityHash, count, tools: [...] }
```

`getContext` answers *who is this, and what day is it?* Resolve relative dates
("tomorrow", "next Friday") against its `today` and `timezone`, never against your own
clock, which may be in another timezone or simply wrong. `getCapabilities` answers *what may they do?* — every
operation visible to the caller, with `permission` and `requiresConfirmation`, and no input
schemas yet (cheap). Together they let you rule out unauthorized operations before fetching
a single schema. If the surface supports batching (see §5), issue both as one bulk call.

**Cache the manifest, keyed on `protocolVersion` + `capabilityHash`:**
- `capabilityHash` changed → the operation registry drifted (something added, removed, or
  reshaped). Refresh your tool list; the contract itself is unchanged.
- `protocolVersion` MAJOR component changed → the *contract* changed. Re-read this guide's
  assumptions rather than trusting your cached mental model.
- `protocolVersion` is **global** — identical for every caller regardless of role.
  `capabilityHash` is **role-scoped** — two different callers legitimately get different
  hashes for the same registry. **Never share a cached manifest across two different
  credentials.**

## 3. Why `tools/list` looks almost empty

A NavWebMcp server intentionally exposes only a small always-on set of meta-operations at
the top level — typically around 8: `explore`, `search`, `describe_tool`, `invoke`,
`load_tools`, `unload_tools`, `getContext`, `getCapabilities` (plus, since 1.3.0, the four
UI ops `ui_list`, `ui_get_state`, `ui_set_state`, `ui_action`, see §11). This is the design, not a
bug: the full operation catalogue can be large, and shipping every schema on every
connection is wasted context. The real catalogue is reachable through discovery (§4),
not through `tools/list`. Never guess operation names from what `tools/list` shows.

## 4. Discovery ladder

- **`explore(path?)`** — navigate the module tree. No args → platform overview and
  top-level modules. `explore("a.b")` → that node's sub-modules and operations.
  `explore("a.*")` or `explore("*")` → wildcard expansion of all descendants. Pass an
  array of paths to fetch multiple nodes in one call: `explore(["a.b", "c.d"])`.
- **`search(pattern)`** — find operations/modules by glob when you know *what* you need
  but not *where* it lives. `**` crosses segment boundaries, `*` matches within one
  segment, `?` matches a single character. A bare keyword with no glob metacharacters and
  no slash (e.g. `search("refund")`) is treated as `**/*refund*`.
- **`describe_tool(name)`** — full input schema, output schema and metadata for one
  operation before calling it. The output schema describes the success `data`, so you can
  plan the next step without a trial call. Accepts an array too: `describe_tool(["opA", "opB"])` returns both in one
  call — never issue one call per name.

Use `explore` when you have a known path to walk, `search` when you have a keyword and no
path, and always finish with `describe_tool` before any write.

## 5. Call modes

NavWebMcp distinguishes several ways to invoke an operation — treat these as distinct
protocol features, not just syntax variants:

| Mode | Shape | Semantics |
|---|---|---|
| **Single** | `invoke({ name, args })` | One operation, stateless. Returns exactly the operation's own `Result` (see §8). |
| **Bulk / parallel** | `invoke({ calls: [{ name, args }, …] })` | The server partitions by parallel-safety: safe calls run concurrently, the rest run **in order**. Results are **re-indexed to input order**, so positional mapping onto your original call list is always safe. |
| **Dependent (≥ 2.2.0)** | `{ "$ref": "<i>.data.<path>" }` as an argument value inside `calls` | Call N uses a value from earlier call i's result, in the same round trip. See below. |
| **Sequential (forced)** | Separate `invoke` calls, or `parallelSafe: false` per call | Use when you need to *look at* a result before deciding the next call (and, on a server below 2.2.0, for any data dependency). |
| **Parallel (forced)** | `parallelSafe: true` per call | Override the default for a write operation you know to be independent of the others in the same batch. |
| **Composite** | one operation that internally orchestrates several steps | See §7 — the server does the sequencing, you make one call. |

Defaults, absent an explicit override: `permission: "read"` operations are parallel-safe;
`permission: "write"` operations are not. An operation may declare its own effective
`parallelSafe` value regardless of its permission — `describe_tool` reports the effective
value, so read it rather than assuming from `permission` alone.

### Dependent calls with `$ref` (≥ 2.2.0)

```js
invoke({ calls: [
  { name: "searchAvailability", args: { date: "2026-12-01", partySize: 2, time: "18:00" } },
  { name: "createReservation",  args: { slotId: { "$ref": "0.data.slots[0].id" },
                                        name: "Dana", partySize: 2, idempotencyKey: "…" } },
  { name: "getReservation",     args: { reservationId: { "$ref": "1.data.reservation.id" } } }
] })
```

- A `$ref` is `<i>` (an **earlier** call's index) followed by `.key` and `[n]` steps into
  that call's result, which starts with `data`. No filters, wildcards or functions.
- **Narrow with the operation's own inputs** so `[0]` is the item you want: above,
  `time` makes `slots[0]` the 18:00 slot. Never guess an index into an unfiltered list.
- A call with a `$ref` waits for the call it points at. Calls without one run as before:
  parallel-safe ones at once, writes in order.
- The referenced call failed, or the path isn't there (an empty list, a missing key): the
  call is **not run** and gets `DEPENDENCY_FAILED`, with `details` naming the ref. Calls
  that depend on it fail the same way. Check each entry of `results`.
- A ref to the same or a later call, or one that doesn't parse, makes the whole batch
  `INVALID_INPUT` before anything runs. `$ref` in the single-call form is `INVALID_INPUT`.
- Refs inside a nested `invoke`'s own `calls` belong to that inner batch.
- Each write can carry its own `idempotencyKey`; the key covers the resolved arguments.

Rules of thumb:
- Batch every independent read into one bulk `invoke` call.
- Put calls that depend on each other's results in one batch with `$ref`, rather than one
  round trip each. Use separate calls only when you must read a result before choosing
  the next call.
- Mixing reads and writes in one bulk call is fine; ordering is still honored for the
  non-parallel-safe subset.
- `load_tools`, `unload_tools`, and `describe_tool` all accept arrays of names — batch
  those too, one call instead of N.

## 6. Stateless `invoke` vs. `load_tools` promotion

`invoke({ name, args })` is stateless and the correct default — it costs nothing at connect
time and works for any operation immediately.

`load_tools([names])` promotes operations into the native tool list (`tools/list`) with
their full schemas. Once promoted, that schema is resent on **every subsequent request**
for the rest of the session — a recurring cost, not a one-time one. Promote only when
**all** of:
1. you will call the same operation **3 or more times** in this session, and
2. you already have its schema (no extra `describe_tool` round-trip needed), and
3. you keep the promoted set small (a handful of operations, not dozens) — a large
   promoted set defeats the point of progressive disclosure.

Call `unload_tools([names])` when that phase of work is done, and re-fetch `tools/list`
after either call to see the current promoted set.

`load_tools` returns **per-name statuses**, not a single top-level failure:
`LOADED` · `NO_OP` (operation is already always-on) · `UNKNOWN_TOOL` · `FORBIDDEN`
(caller's role can't access it).

Never promote an operation you'll call exactly once — a single call is
`invoke({ name, args })`; promoting it just to make one call pays the recurring schema
cost for no repeated benefit.

## 7. Prefer composite operations

Before hand-sequencing a chain of reads and writes (search for a resource → create against
it → verify the result), `search()` first for a single composite operation that already
does this. A composite runs its internal steps server- or page-side, performs its own
post-condition check, and returns one validated result — no intermediate results ever
enter your context.

This is the core efficiency argument for the protocol: collapsing a 3-call orchestrated
sequence into 1 composite call has been measured to cut agent-side HTTP calls by roughly
two-thirds and total token cost by roughly 85%, with cumulative re-read context reduced to
zero (a single result has nothing left to re-read on the next call). Always check for a
composite before orchestrating manually.

## 8. Read the envelope correctly

Every operation result follows one shape:

```json
{ "success": true, "data": <result> }
{ "success": false, "error": { "code": "...", "message": "...", "retryable": false, ... } }
```

A single `invoke` returns the operation's own result, with no extra wrapping (≥ 2.0.0):

```json
invoke({ "name": "someOp", "args": { "badField": true } })
// → { "success": false, "error": { "code": "INVALID_INPUT", "retryable": false,
//      "details": [{ "path": "", "message": "Unrecognized key(s) in object: 'badField'" }], ... } }
```

The bulk form returns one result per call: `{ success: true, data: { results: [ <Result>, ... ] } }`.
The outer `success` only says the batch ran, so check each element of `results`
individually.

A promoted native tool (via `load_tools`) called directly through the host's tool-call
mechanism, rather than through `invoke`, typically returns its `data` unwrapped on success
and signals failure via the call's own error/`isError` mechanism instead of a nested
envelope — read your specific transport's convention, but the *inner* `Result` shape from
the operation itself is the same either way.

On MCP (protocol ≥ 1.1.0), a successful native call also returns `structuredContent`:
the same `data` as the JSON text block, already parsed and matching the tool's
`outputSchema`. Prefer it over re-parsing the text.

Input is validated strictly (≥ 1.1.0): an unknown or misspelt parameter fails with
`INVALID_INPUT` rather than being silently ignored. Copy parameter names
from the input schema exactly.

## 9. Gather-first, ask-once

Before asking the user anything or executing a write, aggregate every required parameter
across the **whole task** by calling `describe_tool` on every operation you'll need, then
ask for every missing value in a **single message**. Never ask one question, wait for the
answer, then ask another — that turns a one-step task into a multi-turn negotiation and
costs the user far more than it costs you to look ahead.

## 10. Confirmation-gated operations

`getCapabilities` and `describe_tool` report `requiresConfirmation` on operations that are
destructive. **Read the operation's input schema, not just this flag, to know how
confirmation is actually enforced:**

- If the schema has an explicit `confirm: boolean` parameter: omitting it (or passing
  `false`) returns `CONFIRMATION_REQUIRED`. Ask the user for approval, then re-call the
  same operation with `confirm: true`.
- If `requiresConfirmation: true` is set but the schema has **no `confirm` parameter**:
  the server will not stop you from calling it. You must get explicit user approval
  yourself, before calling, because the protocol-level gate isn't there — never assume the
  flag alone means the server will block an unconfirmed call.
- `CONFIRMATION_DENIED` means the user (or a UI-side confirmation dialog) explicitly
  refused. Stop. Do not retry the same call.

## 10a. Safe retries with `idempotencyKey` (≥ 2.1.0)

Every write the server marks `idempotent: true` (in `describe_tool` and `getCapabilities`;
`idempotentHint` in MCP annotations) accepts an optional `idempotencyKey`:

```js
invoke({ name: "book", args: { date, time, partySize, name, idempotencyKey: "3f6c…" } })
```

- Make a new key (a UUID is fine) for each action the user asked for, and pass it on every
  write. Keys are scoped to you and the operation, and kept for 24 hours.
- Same key, same arguments → the first call's result, with
  `idempotency: { key, replayed: true }` (on MCP also `_meta["navwebmcp/idempotency"]` and an
  `[idempotency] …` note). Nothing runs again, and it costs the per-request credit only.
- Same key, other arguments → `IDEMPOTENCY_CONFLICT`. Nothing runs. Use a new key for a new action.
- The first call is still running → `IDEMPOTENCY_IN_PROGRESS` (`retryable: true`). Wait a
  second and resend the same call.
- A call that failed frees its key: fix the input and retry with the same key. That
  includes `CONFIRMATION_REQUIRED`: re-call with `confirm: true` and the same key.
- With a key, `HANDLER_TIMEOUT` is `retryable: true`: the server keeps the key until the
  write really finishes, so resending the same call returns its outcome and never writes twice.
- A keyed composite (`book`) passes derived keys to the writes it runs, so a retried
  composite is idempotent end to end.

## 11. Operating the UI (≥ 1.3.0)

Business operations return data **to you**. The user's screen does not change. When the
user should **see** the result ("show me the open tasks, highest priority first", "open the
Tasks tab"), operate the UI components instead. They are always-on, like the navigation ops:

- **`ui_list({ kind? })`**: the components mounted in the user's open app tab. For each one
  you get `id`, `kind`, `state`, `stateSchema`, `version`, `actions` and `view` (row counts),
  plus the page's `activeTab`.
- **`ui_set_state({ componentId, patch, expectedVersion? })`**: change the state as if the
  user had used the controls.
  - Plain objects merge, and arrays and scalars replace.
  - `null` clears a key.
  - The merged state must validate against `stateSchema`.
- **`ui_get_state({ componentId })`**: re-read the state after a change, e.g. to report the
  row count.
- **`ui_action({ componentId, action })`**: run a declared action such as `reset` or `refresh`.

Standard kinds:

- `table`: `{ filters: {…}, sort: [{ column, direction }] }`
- `tabs`: `{ activeTab }`. `app.nav` is the app's tab bar.

A component on another tab isn't mounted. Set `app.nav` first, then call `ui_list` again:

```json
ui_set_state({ "componentId": "app.nav", "patch": { "activeTab": "tasks" } })
ui_list({ "kind": "table" })
ui_set_state({ "componentId": "tasks.table",
  "patch": { "filters": { "status": "open" }, "sort": [{ "column": "priority", "direction": "desc" }] } })
```

`ui_*` ops change only the view, never business data, so no user confirmation is needed.
They are view-only even though they are `permission: "write"`.

Over MCP, they act on the user's own open browser tab through a relay:

- If the user has none open, you get `UI_NO_ACTIVE_PAGE`.
- If the tab didn't answer within about 8s, you get `UI_TIMEOUT`.

The user can change the same component while you work. Pass the `version` you read as
`expectedVersion` so you don't overwrite their change.

## 12. Credits and pacing (≥ 1.4.0)

The server meters every top-level call with credits, the way SMB does. You don't have to
track anything: the server does the accounting and tells you when to change course.

- **What a call costs.** A fixed per-request cost, plus the operation's weight (read 1,
  write 2, composites the number of operations they run), plus size (large arguments or
  results), plus run time (each full second a call runs). Nested calls inside `invoke` or
  a composite are paid for by the top-level call.
- **Seeing the cost before you call.** Every function listed by `explore`, `search`,
  `describe_tool` and `getCapabilities` carries `credits`: what one call costs on its own,
  before size and run time. For example, a read is 2 and `book` is 5. For `invoke` it is 1,
  plus what it runs. Use it to choose between a composite and hand-sequenced calls, and to
  size a batch to your balance.
- **How credits come back.** Each response hands credits back, usually what the call
  cost. A slow trickle also refills over time. Under heavy server load the server hands
  back less, and a long or expensive call shrinks how many credits you may hold.
- **The hint.** When you should change what you're doing, the result carries
  `credits: { balance, window, charged, granted, retryAfterMs?, heldMs?, hint }`. On MCP
  you also get a short `[credits] …` text block. Follow the `hint`: it says how long to
  wait or how to make the work cheaper. A result without `credits` means carry on.
- **Getting cheaper.** One `invoke({ calls: [...] })` batch pays the per-request cost
  once. N separate calls pay it N times. Prefer composites. Don't fire a long run of calls
  in parallel.
- **Backpressure.** If you're slightly short, the server may hold your call briefly and
  then run it, reporting `heldMs`. Treat that as "slow down".
- **Refusal.** `INSUFFICIENT_CREDITS` means nothing ran. Wait `retryAfterMs` (HTTP also
  sends `Retry-After`), then retry. Don't retry in a tight loop.
- **Planning ahead.** `getContext()` returns your current `credits` snapshot.
- **Optional, for protocol-aware clients.** On MCP, `_meta["navwebmcp/credits"]` carries
  the state on every result. Send `_meta["navwebmcp/credits"] = { request: n }` to ask for
  more credits back. Over HTTP, use the `X-NavWebMcp-Credits-*` and
  `X-NavWebMcp-Credit-Request` headers.
- **Compact results (≥ 2.3.0).** A result's text block is indented JSON unless the
  connection asks for compact (`?format=compact` on the MCP URL, or an
  `X-NavWebMcp-Format: compact` header). Send `_meta["navwebmcp/format"] = "compact"` to
  choose per call. Same data either way, fewer tokens compact; read it the same way.

## 13. Error codes and how to react

Every error has the same shape (≥ 2.0.0):

```json
{ "code": "INVALID_INPUT", "message": "date: Must be YYYY-MM-DD",
  "retryable": false,
  "details": [{ "path": "date", "message": "Must be YYYY-MM-DD" }],
  "hint": "Fix the fields in details, then retry once.",
  "requestId": "4f1c…", "callId": "9b2e…" }
```

- `retryable`: re-send the identical call only when this is `true`. Otherwise something
  has to change first (the arguments, the user's approval, or the state). For
  `INSUFFICIENT_CREDITS` it is `true`, but wait `credits.retryAfterMs` first.
- `details`: one entry per bad field. Fix exactly those fields; no need to re-read the schema.
- `hint`: the server's one-line next step. It takes precedence over the generic advice below.
- `suggestions`: on `UNKNOWN_TOOL`, near-miss names your role can call. Try them before `search()`.
- `requestId` / `callId`: quote them when reporting a problem. `callId` is the server's
  audit entry for the call that failed, even when `invoke` relayed it.

| Code | Meaning | React |
|---|---|---|
| `UNAUTHENTICATED` | Credentials missing or expired | Re-authenticate. Don't retry the same call as-is. |
| `FORBIDDEN` | Caller's role can't access this operation | Stop — `getCapabilities` already told you this was off-limits. Don't retry. |
| `INVALID_INPUT` | Arguments failed validation | Fix the fields in `details` (`describe_tool(name)` if unsure), retry once. |
| `UNKNOWN_TOOL` | You called an operation name that doesn't exist | You likely guessed a name. Check `suggestions`, else use `search()`. |
| `NOT_FOUND` | A referenced entity or module path doesn't exist | Not retryable with the same identifier. |
| `CONFIRMATION_REQUIRED` | A `confirm` parameter was omitted on a gated operation | Ask the user, re-call with `confirm: true`. |
| `CONFIRMATION_DENIED` | User explicitly refused | Stop. Never retry. |
| `CANCELLED` | You cancelled the call (≥ 1.2.0); nothing was sent to the server | Nothing to undo. Re-issue only if you still want it. |
| `VALIDATION_FAILED` | A composite's write could not be confirmed afterwards | Read the current state before retrying, so you don't repeat a write that landed. |
| `HANDLER_ERROR` | Unhandled server-side failure (`retryable: true`) | Transient or a bug. Retry at most once, with the same `idempotencyKey` on a write. |
| `HANDLER_TIMEOUT` | The operation didn't finish within the server's deadline (≥ 1.4.0) | With an `idempotencyKey` (≥ 2.1.0) it's `retryable: true`: resend the same call to get its outcome. Without one it may still have taken effect: read back before retrying a write. |
| `IDEMPOTENCY_IN_PROGRESS` | A call with this `idempotencyKey` is still running (≥ 2.1.0) | Wait a second, resend the same call. |
| `IDEMPOTENCY_CONFLICT` | This `idempotencyKey` was used with other arguments (≥ 2.1.0) | Nothing ran. Use a new key for a new action. |
| `INSUFFICIENT_CREDITS` | Out of credits; the call didn't run (≥ 1.4.0) | Wait `retryAfterMs`, then retry. Follow `credits.hint`. |
| `DEPENDENCY_FAILED` | A `$ref`'s earlier call failed, or its path isn't in that result (≥ 2.2.0); this call wasn't run | Fix the earlier call or the path in `details`, then resend the batch. |
| `FANOUT_LIMIT` | The request nested too deep or ran too many operations (≥ 1.4.0) | Flatten nested `invoke`s into one batch, or split the work. |
| `UI_COMPONENT_NOT_FOUND` | No mounted component with that id (≥ 1.3.0) | It's probably on another tab. Set `app.nav`, then `ui_list`. |
| `UI_INVALID_PATCH` | The merged state doesn't match the component's `stateSchema` | Fix the patch against `stateSchema`, retry once. |
| `UI_STALE_STATE` | `expectedVersion` is out of date because the user changed it | `ui_get_state`, then decide again. |
| `UI_UNKNOWN_ACTION` | The component has no such action | Use one listed by `ui_list`. |
| `UI_NO_ACTIVE_PAGE` | The user has no open app tab (MCP only) | Ask the user to open the app. |
| `UI_TIMEOUT` | The user's tab didn't answer in time (MCP only) | `ui_get_state` to see whether it applied. |

Servers may define additional domain-specific error codes beyond this protocol-level set.
Read the `message` field for those — don't blind-retry a code you don't recognize.

## 14. Anti-patterns

- Reading `tools/list` and guessing operation names from it, instead of using `explore`/`search`.
- Calling `explore()` on the whole tree when you already know the keyword — use `search()`.
- Calling `describe_tool` once per name instead of passing an array.
- Asking the user one question, waiting, then asking another.
- Promoting an operation via `load_tools` for a single call.
- Checking only a batch's outer `success` and missing a failed entry in `results`.
- Retrying a call whose error has `retryable: false` without changing anything.
- Working out "today" or "tomorrow" from your own clock instead of `getContext`.
- Sharing one cached capability manifest across two different credentials/roles.
- Making one round trip per step when the steps only pass ids along (use `$ref`).
- Guessing an index (`slots[3]`) into an unfiltered list instead of narrowing with the
  operation's inputs.
- Hand-orchestrating a multi-step sequence without first searching for a composite operation.
- Calling a business operation and narrating its result when the user asked to *see* it on
  screen. Use `ui_set_state` instead.
- Asking the user to confirm a `ui_*` change. It is view-only.

## 15. Installing this skill

Copy this directory into your own agent's skills location:

- Project-scoped: `<your-repo>/.claude/skills/navwebmcp-agent/`
- Machine-wide: `~/.claude/skills/navwebmcp-agent/`

Symlinks work on macOS/Linux. On Windows, `mklink /D` requires admin rights or Developer
Mode — a plain copy is simpler. Verify the install with `/skills` in Claude Code and
confirm `navwebmcp-agent` is listed.
