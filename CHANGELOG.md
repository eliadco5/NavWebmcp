# Protocol changelog

Versions the **NavWebMcp wire protocol** (`PROTOCOL_VERSION` in `lib/protocol.ts`).
Not the app version (`package.json`) — the two are deliberately independent.

## When to bump

The protocol surface is: the capability manifest shape (`lib/capabilities.ts`), the
always-on meta-op names and input schemas (including the `ui_*` ops), the UI component
kinds and contract (`lib/ui-components/contract.ts`), the `Result` envelope
(`lib/result.ts`), and the error-code vocabulary.

| Bump | Trigger |
|---|---|
| MAJOR | Remove or rename a capability manifest field · remove/rename a meta-op or a required param · change the `Result` envelope · change the meaning of an existing error code · change confirmation semantics |
| MINOR | Add a capability manifest field · add a meta-op · add an *optional* param to a meta-op · add a new error code |
| PATCH | No observable wire change — descriptions, `AGENT_INSTRUCTIONS` wording, docs, internals |

**Not a protocol change:** adding, removing, or changing a *business* operation.
That moves `capabilityHash` only. `capabilityHash` is the registry-drift signal;
`PROTOCOL_VERSION` is the contract signal. Never bump one for the other.

Every `PROTOCOL_VERSION` change requires a heading here — enforced by
`tests/unit/protocol.test.ts`.

## 1.4.0

**Credits: SMB-style flow control.** Every top-level call is metered with credits, so one
agent can't flood the server with many calls, long calls or huge fan-outs. The full spec is
in `docs/credits.md`. All additive, and no client change is required. A client that has never
heard of credits is still paced correctly, and it is told what to do in plain language.

- **Cost of a call.** A fixed per-request cost, plus the operation's weight, plus request and
  response size, plus run time.
  - Only the top-level call pays; nested calls are covered by it.
  - Credits come back with each response, scaled down under server load, and a slow
    trickle refills over time.
  - The caller's window adapts (AIMD).
- **Optional `credits` field on the `Result` envelope:**
  `{ balance, window, charged, granted, retryAfterMs?, heldMs?, hint? }`.
  - It is present only when the caller should change course (low balance, debt, shrunk
    window, held call, refusal).
  - `hint` is one actionable sentence.
- **MCP:**
  - `_meta["navwebmcp/credits"]` carries the state on every metered result;
  - a `[credits] …` text block carries the hint;
  - optional `_meta["navwebmcp/credits"].request` asks for more credits.
- **HTTP:**
  - `X-NavWebMcp-Credits-{Balance,Window,Charged,Granted}` response headers;
  - optional `X-NavWebMcp-Credit-Request` request header;
  - a refusal is `429` with `Retry-After`.
- **`getContext` gains an optional `credits` snapshot.**
- **Every function shows its credit cost before it is called.** The function entries of
  `explore`, `search` and `describe_tool`, and the tools in the `getCapabilities` manifest,
  carry `credits`. That is the cost of one call on its own: 1 per request plus the
  operation's weight. On MCP, each tool in `tools/list` carries
  `_meta["navwebmcp/credits"] = { cost }`. The cost is part of the `capabilityHash`
  fingerprint, so a change in an operation's cost invalidates cached manifests.
- **Refusals at the door.** A caller over its in-progress limit (8 agents / 16 people per
  instance), or already out of credits, gets `INSUFFICIENT_CREDITS` with a hint before its
  request does any work. On MCP this is a tool result with `isError`; on HTTP it is 429.
- **Malformed MCP bodies** (not a JSON-RPC object or batch) get HTTP 400 with JSON-RPC
  `-32700`.
- **New error codes:**
  - `INSUFFICIENT_CREDITS`: refused, nothing ran;
  - `FANOUT_LIMIT`: nesting deeper than 3 levels, or more than 200 operations under one call;
  - `HANDLER_TIMEOUT`: the operation passed its deadline (15 s by default).

## 1.3.0

**Agent-operable UI components.** Agents can now change what the user *sees*, such as a
table's filters and sort or the active tab, without touching the DOM. Components publish a
typed state contract and agents patch it. The full spec is in `docs/ui-components.md`. All
additive.

- **Four new always-on meta-ops:** `ui_list`, `ui_get_state`, `ui_set_state`, `ui_action`.
  - They change only the view, never business data, so they never require confirmation.
  - `ui_set_state` and `ui_action` are `permission: "write"`, but they are not
    destructive or consequential.
- **Component contract:** `{ id, kind, title, stateSchema, state, version, actions, view }`.
  - There are two standard kinds. `table` is `{ filters, sort: [{column, direction}] }`, and
    `tabs` is `{ activeTab }`.
  - `version` supports optimistic concurrency through `expectedVersion`.
- **Patch semantics:** objects merge, arrays and scalars replace, and `null` clears a key.
  The merged state must validate against `stateSchema`.
- **Two reach paths with the same behaviour.**
  - The in-page agent goes straight to the page's component registry.
  - MCP clients go through a server relay to the caller's own open tab. The relay endpoints
    are `POST /api/ui/snapshot` and `POST /api/ui/relay`, and they use Redis when
    `REDIS_URL` is set.
- **New error codes:** `UI_COMPONENT_NOT_FOUND`, `UI_INVALID_PATCH`, `UI_STALE_STATE`,
  `UI_UNKNOWN_ACTION`, `UI_NO_ACTIVE_PAGE`, `UI_TIMEOUT`.
- **New `Operation` field `runsInPage`.** On the in-page surface, ops with this field are
  served by the page, not by `/api/call`.
- **Reference components:**
  - `tasks.table` (Task Search), which also gains a sort control.
  - `app.nav` (the tab bar).
- **Business op change (moves `capabilityHash` only):** `searchTasks` takes optional
  `sortBy` and `sortDir`.

## 1.2.0

Closes the remaining in-page gaps against the WebMCP draft of 13 Nov 2026, and fixes the
composite rollback. All additive.

- **Cancellation.** `execute(input, {signal})` now receives an `AbortSignal`, and the
  polyfill's `executeTool(name, input, {signal})` supports cancelling, as in the spec.
  - Aborting rejects with the caller's reason, aborts the tool's own signal, fires
    `toolcancel`, and ignores any later result.
  - AgentBridge passes the signal on to the server request.
  - **New error code `CANCELLED`:** the caller cancelled while a confirmation dialog was
    open, so the op was never sent to the server.
- **Events.** `toolactivated` (`ToolActivatedEvent`) and `toolcancel` (`ToolCancelEvent`)
  are fired at `modelContext` with `toolName`. The `ontoolactivated` / `ontoolcancel`
  handler attributes work too.
- **Duplicate names.** Registering a duplicate tool name now rejects with
  `InvalidStateError`. Before this, it silently replaced the first tool.
- **`seatGuest` / `hostVipGuest` no longer try to roll back with `checkOutGuest`.** That
  call was missing `confirm`, so it was always rejected and never ran. And checking out
  isn't an undo anyway: it bills the visit and frees the table, which would be the wrong
  result for a guest who really was seated. Both composites now follow `book`:
  - If the check-in isn't visible afterwards, the result is `VALIDATION_FAILED`.
  - `seatGuest` reports a stale occupancy re-check as `validated: false` instead of
    failing.

## 1.1.0

Adopts the WebMCP `outputSchema` member (webmachinelearning/webmcp#254, in the draft of
13 Nov 2026) and the matching MCP `outputSchema` / `structuredContent` pair. All
additive; deliberate differences from the WebMCP spec are listed in
`docs/webmcp-alignment.md`.

- **Every operation declares an output schema** (the shape of its success `data`).
  - MCP `tools/list` publishes it as `outputSchema`. Successful `tools/call` results
    carry `structuredContent` (that same data), and still include the JSON text block.
  - In-page WebMCP tools publish it wrapped in the `Result` envelope, since that is what
    `execute()` resolves to: `{success: true, data} | {success: false, error}`.
  - `describe_tool` returns `outputSchema` next to `inputSchema`.
- **Tool annotations.**
  - WebMCP: `readOnlyHint`, `consequentialHint` (= requiresConfirmation) and
    `untrustedContentHint` (ops returning staff/guest-written text).
  - MCP: `readOnlyHint`, `destructiveHint` and `title`.
  - `invoke` is never marked read-only. It is declared `permission: "read"`, but it can
    dispatch any op, including destructive ones, so its annotations are
    `readOnlyHint: false`, `destructiveHint` / `consequentialHint: true`.
- **Unknown input keys are rejected** with `INVALID_INPUT` / `INVALID_ARGS`. Before this
  they were silently dropped, which contradicted the `additionalProperties: false` every
  published input schema already declared. A misspelt optional field used to "succeed"
  while doing nothing.
- **Tighter input validation.** Every input string now has a length limit or a format.
  `YYYY-MM-DD` dates are validated on the finance ops, `book.time` must be `HH:MM`, ids
  must be non-empty, and money/points fields are capped at 100000.
- **MCP error results** are always `{code, message}` in the text block. The
  `UNAUTHENTICATED` and `FORBIDDEN` paths used to send the whole `Result` envelope there
  instead.
- `capabilityHash` now also changes when an operation's output schema changes.

## 1.0.0

First versioned protocol. Named **NavWebMcp** — the layer of progressive tool
disclosure, RBAC, and composite operations on top of the W3C WebMCP draft standard.

- `getCapabilities` returns `{ protocolVersion, capabilityHash, count, tools }`.
- **Breaking vs. pre-1.0:** the single `version` field is removed. It conflated a
  semver contract with a content hash. `protocolVersion` is global (identical for
  every role); `capabilityHash` is role-scoped (a cache-bust key over the caller's
  visible operations).
- MCP `serverInfo.version` is the semver, not the hash.
- In-page: `document.modelContext.protocolVersion` (declared non-spec extension).
- `agentbridge.describe()` returns `protocol` + `protocolVersion`, replacing a
  hardcoded `"1.0"`.
- Ships alongside `skills/navwebmcp-agent/` — skill revision `1.0.0`, valid for
  protocol range `>=1.0.0 <2.0.0`.
