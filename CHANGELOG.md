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

## 2.7.0

Optional pagination and field selection on list operations, so a long list no longer has
to fill the agent's context. **Everything is opt-in**: a call that passes none of the new
fields gets exactly the answer it got before.

- **17 list operations** (`listAllReservations`, `listPayments`, `searchTasks`,
  `listUserSessions`, …; the "Paged" column in `docs/operations.md`) accept three new
  optional fields:
  - `limit` (1–200): answer one page. Without it, the full list, as before.
  - `cursor`: the previous page's `nextCursor`. It remembers the page size, so `limit`
    may be left out on later pages. It is signed and bound to the caller, the agent
    client, the operation and the other arguments: a tampered cursor, or one sent with
    other filters, is `INVALID_INPUT` (`details[0].path: "cursor"`).
  - `fields`: only these item properties (the item's id is always kept). An unknown name
    is `INVALID_INPUT`.
- **Output:** the list keeps its name (`reservations`, `tasks`, …), and the existing
  `count` / `total` still counts every match, not the page. `nextCursor` is added when
  another page exists. In the published `outputSchema`, item properties other than the id
  become optional (a projection leaves them out); handlers are still checked against the
  complete item shape.
- **Paging follows items, not positions:** the next page starts right after the last item
  returned, so a booking added or removed meanwhile doesn't make one repeat or go missing.
- **New filters:** `status`, `from`, `to` on `listAllReservations`; `status` on
  `listReservations`. `listFrontDeskReservations` gains `count`.
- `getCreditLedgers` keeps its default of 50 rows; its `limit` is now the shared one and it
  pages with `cursor`. `queryAudit` keeps its own `limit` / `beforeSeq` paging.
- `capabilityHash` changes for these operations (new input fields), as intended.

## 2.6.0

Confirmation that shows what will happen, and can prove it was approved. Until now the
gate only proved the agent had read the schema: it could send `confirm: true` on its own,
and nobody saw what the action would do.

- **Previews.** Destructive operations have a `preview(input, ctx)` that reads but never
  writes. A call without approval answers `CONFIRMATION_REQUIRED` carrying
  `confirmation: { preview: { summary, data }, token, expiresAt }`: the reservation being
  cancelled, the refund amount, the fee. A preview that fails (`NOT_FOUND`,
  `ALREADY_REFUNDED`, …) is the answer instead.
- **Confirmation tokens.** Re-calling with `confirmationToken` (a new optional field on
  every `requiresConfirmation` operation) runs exactly that call. The token is an HMAC over
  the user, the agent client, the operation, the arguments' hash and a 5-minute expiry, and
  works once (shared across instances through Redis).
- **New error code `CONFIRMATION_STALE`**: the arguments changed, or the token expired, was
  used, or isn't for this caller or operation. It carries a new preview and token.
- **`confirm` is optional** on the 9 destructive operations. Omitting it now answers
  `CONFIRMATION_REQUIRED` (it was `INVALID_INPUT`). `confirm: true` keeps
  working as before.
- **Opt-in enforcement:** with `REQUIRE_CONFIRMATION_TOKEN=true`, an agent's bare
  `confirm: true` is refused with `CONFIRMATION_REQUIRED` (preview and token included). A
  person in the UI is not affected. Off by default, which is why this is MINOR: no call that
  worked before is refused.
- **MCP elicitation.** When the client declares `elicitation`, the server asks the user
  itself: on 2026-07-28 the call answers `input_required` with an `elicitation/create` form
  showing the preview, and the tokens as `requestState`; the client re-sends the call with
  the answer. Nothing is held open, so it works on serverless. Declining is
  `CONFIRMATION_DENIED`. One form covers every destructive call of a batch; a batch that
  already wrote something in that round gets the tokens back instead of being re-run.
- **WebMCP:** the in-page confirmation dialog shows the server's preview, and approving
  re-sends the call with the token.
- **`dryRun: true`** on every write that runs on the server (a new optional field): the
  usual gates and the preview, never the handler. Returns `{ dryRun: true, preview,
  confirmation? }`, charged as a read, claims no idempotency key.
- **Audit:** approved destructive calls record `approvedBy` (`human`, `asserted`,
  `confirmation-token` or `user-elicitation`); dry runs record `dryRun: true`.
- `capabilityHash` changes for every role (new input fields, new descriptions).
- New settings: `CONFIRMATION_SECRET` (falls back to `AUTH_SECRET`),
  `CONFIRMATION_TTL_SECONDS` (300), `REQUIRE_CONFIRMATION_TOKEN`.

## 2.5.0

A smaller connect cost. On MCP, `tools/list` for a new connection (the 12 always-on tools)
falls from about **6,600 to about 2,000 tokens** (−70 %, measured as characters ÷ 4).

- **No `outputSchema` for the always-on tools on MCP.** `explore`, `search`,
  `describe_tool`, `invoke`, `load_tools`, `unload_tools`, `getContext`,
  `getCapabilities` and the four `ui_*` tools no longer publish an output schema in
  `tools/list`. Those schemas were most of the connect cost (`explore`'s recursive
  module tree alone was about 1,500 tokens). The tools still return `structuredContent`,
  and `describe_tool` still returns their output schema on request. Business operations
  promoted with `load_tools` keep theirs. In-page WebMCP is unchanged.
- **Shorter descriptions** for the same 12 tools and their parameters. The contract
  is unchanged; the detail lives in `AGENT_INSTRUCTIONS` and the agent skill.
- `capabilityHash` changes for every role, since the descriptions are part of the
  fingerprint.
- `tests/unit/mcp-connect-cost.test.ts` pins the connect cost under a 2,200-token budget.
- What's left is mostly JSON-Schema structure in the input schemas (`type`,
  `additionalProperties`, length limits) and the SDK's per-tool `execution` field.

**Note for clients:** a client that validated an always-on tool's `structuredContent`
against its published `outputSchema` now has none to validate against. That's allowed by
MCP (`outputSchema` is optional), and the data is unchanged.

## 2.4.0

The MCP surface moves to the MCP **2026-07-28** revision (mcp-handler 2.x on the MCP
SDK v2). Clients on that revision connect natively; 2025-era clients keep working
unchanged. Nothing changes for an agent beyond the two points marked **Observable**.

- **Both MCP generations on `/api/mcp`.**
  - 2026-07-28: stateless, with the protocol version, client info and client
    capabilities in each request's `_meta`, and `server/discover` for the server's
    identity, capabilities and instructions. A version the server doesn't speak gets
    `UnsupportedProtocolVersionError`, listing the supported ones.
  - 2025-era Streamable HTTP clients (the `initialize` handshake) are served by the
    SDK's stateless fallback from the same handler. Same tools, schemas and results.
  - `serverInfo.version` is still the NavWebMcp semver, and `AGENT_INSTRUCTIONS` is
    still sent: in `server/discover` on 2026-07-28, in `initialize` before.
- **Observable: native tools answer bad arguments with NavWebMcp's `INVALID_INPUT`.**
  A natively called (promoted) tool used to be checked by the SDK first, which answered
  a bare text line (since 1.1.0) without naming the field. Now `execute()` checks it, so
  the error is `{ code: "INVALID_INPUT", retryable, details, hint, requestId, callId }`,
  the same as on `invoke` and `/api/call`. `INVALID_INPUT` keeps its meaning.
- **Observable: the old HTTP+SSE transport is gone.** `/api/sse` and `/api/message`
  answer 404 (the transport was already switched off in 1.x config). GET on
  `/api/mcp` is 405: serving is stateless, and nothing pushes yet (MCP Events is planned
  for a later release). `subscriptions/listen` is refused.
- **Unchanged:** every tool name, input and output JSON Schema (`tools/list` now
  publishes exactly what `describe_tool` and WebMCP publish, from one converter),
  `capabilityHash`, credits and their `_meta`, idempotency, `$ref` batches, the
  `format` option, bearer-token auth, body limits and the audit trail.
- Not a protocol change, but measured: per-call latency on the MCP lanes of
  `scripts/bench.mjs` is roughly halved, with identical token counts.

## 2.3.0

Compact text blocks on MCP: fewer tokens for the same result. Opt-in; the default is the
indented JSON every client gets today.

- **`format`: `"pretty"` (default) or `"compact"`.** Decides how the JSON in a tool
  result's text block is written: `JSON.stringify(x, null, 2)` or `JSON.stringify(x)`.
  Success data, errors, and the in-band credit refusals at the door all follow it.
- **Chosen per connection** with the `X-NavWebMcp-Format` header or `?format=` on the MCP
  URL (the header wins), so a user can set it once where the server is configured; a model
  can't. **Per call**, `_meta["navwebmcp/format"]` overrides the connection, both ways.
  Unknown values are ignored, never an error.
- **Unchanged:** `structuredContent`, `_meta`, the `[credits]` and `[idempotency]` text
  notes, credit charges (`bytesOf` already measures compact JSON), `/api/call` (already
  compact) and the in-page WebMCP surface (returns objects, not text).
- Why: indentation grows with nesting depth, so batch replies (2.2.0 `$ref` chains) paid
  the most for it.

## 2.2.0

Dependent batches: a multi-step flow in one round trip. Additive; a batch without `$ref`
runs exactly as before.

- **`$ref` in `invoke({ calls })`.** Any argument value, at any depth, may be
  `{ "$ref": "<i>.<path>" }`: a value from earlier call `i`'s Result, e.g.
  `"0.data.slots[0].id"`. The path is `.key` and `[n]` steps only; no filters, wildcards
  or functions. Selection belongs in the operation's own inputs (see `searchAvailability`
  below), which keeps the grammar small for every implementation.
- **Checked first.** A ref that doesn't parse, or points at the same or a later call,
  makes the whole batch `INVALID_INPUT` with one `details` entry per bad ref
  (`calls.<i>.args.<path>`); nothing runs. Refs can't form cycles. `$ref` in the
  single-call form is `INVALID_INPUT`.
- **Order.** A call with a `$ref` waits for the calls it refers to. Otherwise the plain
  batch rules hold: parallel-safe calls run at once; the rest run in request order, after
  the parallel-safe calls that don't depend on them.
- **`DEPENDENCY_FAILED`** (new code, `retryable: false`): the referenced call failed, or
  the path isn't in its result (an empty list, a missing key). The call isn't run; its
  `details` name the ref and the reason. Calls depending on it fail the same way.
- **Nesting.** Refs inside a nested `invoke`'s own `calls` belong to that inner batch.
- **Unchanged:** fan-out limits (skipped calls don't count), the up-front credit charge,
  and idempotency: each write keeps its own `idempotencyKey`, hashed over the resolved
  arguments.
- `invoke`'s description and its `calls[].args` schema document the syntax, so
  `capabilityHash` changes for every role.

Business operation (not a protocol change; it moves `capabilityHash` only):
`searchAvailability` takes an optional `time` (HH:MM) and returns only the slot at that
time, so `"0.data.slots[0].id"` is the slot the guest asked for.

## 2.1.0

Idempotency keys: safe retries of writes. Additive; nothing an agent does today changes
unless it passes a key.

- **`idempotencyKey` on every server-side write.** Each `permission: "write"` operation
  accepts an optional `idempotencyKey` (1–128 chars). It is added centrally (in
  `defineOperation`), so it is published in every input schema (MCP `tools/list`,
  `describe_tool`, WebMCP) and the strict-input rule still holds. Not on reads, `invoke`
  (its nested writes take their own keys) or the in-page `ui_*` ops. `execute()` strips
  the key before the handler runs.
- **Semantics.** A key is scoped to (user, operation, key). The server stores a SHA-256 of
  the canonical arguments and, once the call succeeds, its full Result, for 24 h
  (`IDEMPOTENCY_TTL_SECONDS`).
  - Same key, same arguments: the stored Result, plus `idempotency: { key, replayed: true }`
    on the envelope. The handler does not run.
  - Same key, other arguments: `IDEMPOTENCY_CONFLICT` (new code, `retryable: false`).
  - Same key while the first call still runs: `IDEMPOTENCY_IN_PROGRESS` (new code,
    `retryable: true`).
  - A call that fails (any error, including `CONFIRMATION_REQUIRED` and a thrown
    `HANDLER_ERROR`) frees its key, so the corrected retry runs. Gate failures before the
    handler (input, RBAC, credits) never claim it.
  - `HANDLER_TIMEOUT` with a key keeps the key pending until the handler really finishes,
    then stores its outcome. The error is then `retryable: true`, with a hint to resend the
    same call. Without a key it is unchanged (`retryable: false`). A pending claim expires
    after 5 min (`IDEMPOTENCY_PENDING_TTL_MS`) in case an instance dies.
- **Storage.** Redis when `REDIS_URL` is set: the claim is one Lua script (read, else
  write with a TTL), so exactly one instance runs a key; completion and release only
  touch a claim they own. Per process otherwise, and while Redis is down (fail open, as for
  the rest of shared state).
- **Composites.** A write nested under a keyed call gets a derived key,
  `<key>/<operation>#<n>`, so a retried `book` is idempotent end to end.
- **Credits.** A top-level replay is charged the per-request cost (1) only; so is an
  `invoke` single call that relays a replay.
- **Manifest.** `describe_tool` and `getCapabilities` carry `idempotent: true` on these
  operations (absent otherwise). MCP annotations gain `idempotentHint: true`.
  `capabilityHash` changes for every role, since the write operations' input schemas grew.
- **Surfaces.** MCP: a replay also carries `_meta["navwebmcp/idempotency"]` and an
  `[idempotency] …` text block; `structuredContent` is the op's own data as before.
  `POST /api/call`: a replay is HTTP 200 with `Idempotent-Replayed: true`;
  `IDEMPOTENCY_CONFLICT` and `IDEMPOTENCY_IN_PROGRESS` are HTTP 409.
- **Audit.** SOC2 events carry `idempotencyKey`, and `replayed: true` on a replay, so a
  replayed create isn't mistaken for a second one.
- **Hints.** `HANDLER_ERROR` and `HANDLER_TIMEOUT` now point at `idempotencyKey`.

## 2.0.0

Fixes the contract traps that cost agents the most: the double envelope on `invoke`,
two spellings each for "bad input" and "no such operation", errors with nothing to act
on, a cache key that missed real schema changes, and no notion of "today". **Breaking**;
the migration notes are at the end. Credits (1.4.0) and UI components (1.3.0) are
unchanged.

- **`invoke` single call has no second envelope.** `invoke({ name, args })` now returns
  exactly what the operation returns: its data on success, its own error on failure.
  `success` always means "the operation succeeded".
  - MCP: a failed operation makes the `invoke` call `isError: true` with that
    operation's error. Success data is `structuredContent`, as for a native tool.
    Credits still travel in `_meta` and, when hinted, on the Result.
  - Batch (`{ calls }`) is unchanged: `{ results: [{ success, data | error }, …] }`, in
    request order.
  - Passing both `name` and `calls` is now `INVALID_INPUT`. Before, `calls` was ignored.
- **One set of codes on every surface.** `execute()` no longer takes per-surface codes:
  - Bad input is `INVALID_INPUT` everywhere. `INVALID_ARGS` (invoke, composites,
    `admin.setCreditPolicy`) and the domain code `INVALID_DATE` (`getWeeklyRevenueSummary`)
    are removed.
  - An unknown operation is `UNKNOWN_TOOL` everywhere. `POST /api/call` used to say
    `NOT_FOUND` (still HTTP 404). `NOT_FOUND` now only means a missing entity.
- **Structured errors.** Every operation error now has `{ code, message, retryable }`,
  plus optional fields:
  - `details`: one `{ path, message }` per invalid field (`INVALID_INPUT`)
  - `hint`: a one-line next step
  - `suggestions`: did-you-mean names for `UNKNOWN_TOOL`, only from operations the
    caller's role can see (also on `describe_tool`'s `UNKNOWN_TOOL` entries)
  - `requestId` / `callId`: the request and the call that failed, as recorded in the
    audit trail. When `invoke` relays a failure, `callId` is the inner call's.
  - `retryable` is `true` for `HANDLER_ERROR` and `INSUFFICIENT_CREDITS` (after
    `credits.retryAfterMs`), and `false` for `HANDLER_TIMEOUT`, whose write may have
    landed. The catalogue is `PROTOCOL_ERROR_CODES` in `lib/result.ts`.
  - `execute()` normalises every failure (gates, handlers, credit refusals, timeouts), so
    no operation can return a bare `{code, message}`. The `/api/call` and MCP pre-execute
    refusals (unauthenticated, out of credits, body too large) use the same shape.
- **`getContext` gives agents the platform clock.** New fields: `role`, `now` (ISO 8601),
  `today` (`YYYY-MM-DD`) and `timezone` (`UTC`). Resolve "tomorrow" against these,
  not the agent's own clock. `page` is now `null` on the server. It used to be a
  hardcoded `"booking"` that misled MCP agents.
- **`capabilityHash` covers the full contract.** It hashes each operation's complete
  published input and output JSON Schemas (types, required fields, enums, bounds,
  descriptions), its credit cost, and its `requiresConfirmation` / `untrustedOutput` /
  `alwaysOn` / `runsInPage` flags. Before, it hashed only the schema key names, so
  changing a field's type or making it required left agents on a stale cached schema.
  Expect every hash to change once.

**Migrating from 1.x**
- Drop any `result.data.success` / `result.data.data` unwrapping after a single
  `invoke`: read `result.success` and `result.data` directly.
- Match `INVALID_INPUT` wherever you matched `INVALID_ARGS` or `INVALID_DATE`, and
  `UNKNOWN_TOOL` wherever you matched `NOT_FOUND` for an unknown operation on `/api/call`.
- Errors carry new fields (`retryable` always, the others when they apply). If you
  compare whole error objects, compare `code` instead.
- `getContext().page` is `null` on the server. Use `today` / `timezone` for dates.

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
