# NavWebMcp roadmap: the next tiers

**Starting point:** master with PR #21 merged (NavWebMcp 2.0.0: flat `invoke` results,
structured errors, the platform clock, a full-schema `capabilityHash`).

**Goal:** every feature here removes a turn, a retry, a wrong guess, or a risk that an
agent runs into today. Each one is measured the same way PR #21 was.

## Already done on master (not in this plan)

| Original recommendation | Where it landed |
|---|---|
| Rate limits and budgets | Credits, protocol 1.4.0 (`docs/credits.md`): metering, `INSUFFICIENT_CREDITS`, `retryAfterMs`, hints |
| Agent attribution in the audit log | SOC2 audit trail (`docs/management-soc2.md`): actor, agent identity, `requestId` / `callId`, hash chain |
| Agent sessions and revocation | Management layer: per-agent identity, liveness, revocation |
| One execution path | `execute()` (`lib/operations/execute.ts`) |

Still missing from those areas: a per-write `reason`, and tokens scoped below the role
(both on Day 8).

## Upstream MCP (checked 2026-11-26)

The roadmap now follows where MCP itself is going, so we build on its extensions
instead of inventing our own versions of them.

| Upstream | Status | Where it lands here |
|---|---|---|
| Spec **2026-07-28** (stateless; `server/discover`; protocol version in each request's `_meta`) | Current revision | Day 6, shipped in 2.4.0 (`mcp-handler` 2.4, `@modelcontextprotocol/server` 2.4) |
| [Events](https://modelcontextprotocol.io/extensions/events/overview) (`io.modelcontextprotocol/events`, SEP-3415) | Beta | Day 7, replaces our own push plan |
| [Skills over MCP](https://modelcontextprotocol.io/extensions/skills/overview) (`io.modelcontextprotocol/skills`, SEP-2640) | Spec final; SDK and app support still being built | Day 7, serves `skills/navwebmcp-agent` |
| Token binding to the client ([#1932](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1932)), agent identity for cloud agents ([#1933](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1933)) | Drafts | Day 8 aligns with them |
| Enterprise-Managed Authorization | Stable | Not scheduled (see open questions) |
| File uploads | Prototype | Not relevant to this app |
| Next spec release | March 2027 | Re-check this table then |

**Client support is thin.** The [client matrix](https://modelcontextprotocol.io/extensions/client-matrix)
shows no support for Events or Skills in Claude (web, Desktop or Code). ChatGPT has
partial support: webhook-only Events, and importing skills. Day 7 therefore pays off
mostly through other clients, the MCP Inspector and our own conformance kit, and its
tests can't rely on a real host.

## How every day runs

Each day is **one branch and one PR**, cut from the **latest master**, and merged before
the next day starts. PR #21 went wrong by branching from a stale branch, so every day also
ends with a "behind master?" check.

**Definition of done**, the same cycle as PR #21:
1. `git fetch` and confirm the branch is master plus this day's commits only
2. `npm test`, `npm run test:redis`, `npm run type-check`, `npm run build`
3. An end-to-end script over real MCP HTTP and `/api/call` for the day's feature
4. `credits-stress.mjs`: `--quick` on a single instance, plus a two-instance run on Redis
5. `bench.mjs` against master on the same machine, run with `REDIS_URL` unset
6. A `CHANGELOG.md` entry, a protocol version bump, and the matching lines in
   `AGENT_INSTRUCTIONS` and `skills/navwebmcp-agent/SKILL.md` (kept in sync)

**Versioning:** every day is additive, so it's a **2.x MINOR** bump. The one item that
would change confirmation semantics (enforcing confirmation tokens) is opt-in, so it
stays MINOR too. Making enforcement the default would be 3.0.0 (see open questions).

## Overview

In the order they ship. Day numbers are the original plan's; 2.3.0 went to an unplanned
feature, and Day 6 moved ahead of Day 3 so confirmation can use MCP elicitation.

| Day | Version | Status | Theme | Main agent win |
|---|---|---|---|---|
| 1 | 2.1.0 | Shipped (PR #24) | Idempotency keys | Safe retries of writes |
| 2 | 2.2.0 | Shipped (PR #26) | Dependent batches | Multi-step flows in one round trip |
| — | 2.3.0 | Shipped (PR #27) | Compact JSON in MCP text blocks (not in the plan) | Fewer tokens per result |
| 6 | 2.4.0 | This PR | MCP 2026-07-28 upgrade | Current MCP clients connect; unlocks elicitation and Day 7 |
| 3 | 2.5.0 | Next | Confirmation previews, tokens, dry-run, elicitation | Real human-in-the-loop; check a plan before asking |
| 4 | 2.6.0 | | Pagination, filters, field selection | Lists stop eating the context window |
| 5 | 2.7.0 | | Discovery quality | Find the right operation, and call it right, first time |
| 7 | 2.8.0 | | Events, skills over MCP, output safety | No polling; the skill comes from the server; prompt-injection-aware output |
| 8 | 2.9.0 | | Least-privilege agent tokens | Safe to hand an agent a token |
| 9–10 | — | | Spec, conformance kit, package | NavWebMcp usable outside this repo |
| Later | — | | Code mode, second implementation, real-LLM benchmark | Proof the protocol carries the claim |

---

## Day 1: Idempotency keys (2.1.0)

**Problem:** `HANDLER_ERROR` is retryable, but retrying `createReservation`, `issueRefund`
or `book` can do the write twice. `HANDLER_TIMEOUT` is worse: the write may have landed.

**Design**
- Every `permission: "write"` operation accepts an optional `idempotencyKey` (1–128 chars).
  It's injected centrally in `execute()`, not added to 30 schemas by hand. The input
  schema publishes it, so the strict-input rule still holds.
- The key is scoped to (user, operation, key). The record stores a hash of the arguments
  and the full `Result`.
  - Replay with the same arguments: return the stored result with
    `idempotency: { replayed: true }`. The handler doesn't run.
  - Same key, different arguments: `IDEMPOTENCY_CONFLICT`, not retryable.
  - A call still running under that key: `IDEMPOTENCY_IN_PROGRESS`, retryable.
- Storage: shared state (Redis when configured), 24 h TTL. The write and the record go
  under the same mutex `withSharedState` already uses, so two instances can't both run it.
- Credits: a replay is charged the per-request base cost only.
- Manifest: `idempotent: true` on write operations in `describe_tool` and
  `getCapabilities`. MCP annotations gain `idempotentHint: true`, which we can now
  honestly claim.
- Composites: `book` passes `${key}:create` down to `createReservation`, so a retried
  `book` is idempotent end to end.
- The hint for `HANDLER_ERROR` / `HANDLER_TIMEOUT` becomes "Retry with the same
  idempotencyKey".

**Tests:** replay; conflict; two concurrent calls on two instances (Redis, in
`redis-live.test.ts`); TTL expiry; a replay isn't double-charged; `book` retried after a
simulated timeout makes one reservation.

**Measure:** a stress scenario ("retry storm on writes") in which 0 duplicate rows is a
pass.

## Day 2: Dependent batches (2.2.0)

**Problem:** `invoke({ calls })` can't feed one call's output into the next call's input,
so search → create → verify costs a round trip per step unless someone wrote a composite.

**Design**
- In a batch, any argument value can be `{ "$ref": "<index>.<path>" }`. Examples:
  `{"$ref": "0.data.slots[0].id"}`, or `{"$ref": "0.data.slots[?available==true][0].id"}`
  for a small filter subset (to decide in open questions).
- A call that holds a `$ref` waits for the call it refers to. Independent calls still run
  in parallel. A `$ref` may only point to an earlier index, so there are no cycles.
- If the referenced call failed, or the path doesn't resolve, this call isn't run and gets
  `DEPENDENCY_FAILED`, whose `details` name the ref.
- The combination counts toward the existing `FANOUT` limits. Item 1 applies per call:
  each batch item can carry its own `idempotencyKey`.
- `describe_tool` for `invoke` documents the syntax. The skill's "never batch dependent
  calls" rule becomes "use `$ref`".

**Tests:** chains, diamonds, a failed dependency, bad paths, forward refs (rejected),
mixed read and write ordering, plus a fan-out limit check.

**Measure:** a new `bench.mjs` lane, "A-invoke-chained": the booking flow as one
dependent batch, against today's 3 calls. Expected: one round trip, with token savings
close to the `book` composite.

## Day 3: Confirmation previews, tokens and dry-run (2.5.0)

**Problem:** the confirmation gate only proves the agent read the schema; the agent can
send `confirm: true` on its own. There's also no way to check a write before asking the
user.

**Design**
- Destructive operations get an optional `preview(input, ctx)` next to `handler`. It says
  what will change: the refund amount, the reservation being cancelled, the fee.
  Composites build theirs from their steps.
- A call without `confirm` now returns `CONFIRMATION_REQUIRED` with:
  - `confirmation.preview`: what the action would do, in data and one sentence
  - `confirmation.token`: an HMAC over (actor, operation, arguments hash, expiry). It
    expires after 5 minutes and works once.
- `confirm: true` keeps working. Passing `confirmationToken` instead proves the
  arguments haven't changed since the user saw the preview. If they changed:
  `CONFIRMATION_STALE`.
- **Opt-in enforcement:** with `REQUIRE_CONFIRMATION_TOKEN=true`, a bare `confirm: true`
  is refused (`CONFIRMATION_REQUIRED`, plus the preview and a token).
- **MCP elicitation:** when the client advertises the elicitation capability, the server
  asks the user directly with the preview text and confirms on their answer. On
  2026-07-28 this is a multi round-trip request: the server answers the call with an
  `InputRequiredResult` carrying `elicitation/create` and a signed `requestState` (our
  confirmation token), and the client re-sends the call with the user's answer. Nothing
  is held open, so it works on serverless. The SDK v2 that Day 6 moved to exports the
  pieces (`inputRequired`, `createRequestStateCodec`); Day 3 is the first to use them. This is the
  only path where the server knows a person approved, and it's audited as
  `approvedBy: "user-elicitation"`.
- **WebMCP:** the existing dialog in `app/providers.tsx` shows the preview text.
- **`dryRun: true`** on any write runs validation, RBAC, credits admission and `preview`,
  never the handler, and returns `{ dryRun: true, preview }`. It's charged at read cost.

**Tests:** token binding (other arguments, other user, expired, reused); elicitation with
a fake client in the in-memory MCP transport; dry-run never mutates (check the store
snapshot before and after); audit records how each approval was given.

**Measure:** e2e checks for each of the 6 destructive operations, and a stress scenario in
which tokens are forged or replayed.

## Day 4: Pagination, filters and field selection (2.6.0)

**Problem:** `listAllReservations`, `listPayments`, `searchTasks` and the others return
everything. Response size costs credits and context. Only one admin operation has a
`limit` today.

**Design**
- Shared input helper: `{ limit?, cursor?, fields?, filter? }`.
  - `limit` defaults to 25, max 200
  - `cursor` is opaque, an HMAC'd offset plus a sort key
  - `fields` is a projection on the item schema
  - `filter` is equality and range on declared fields only
- Shared output: `{ items, nextCursor?, total }`. Item schemas don't change; `fields`
  makes item properties optional in the published schema.
- Applied to every list or search operation. The README catalogue gets a "paged" column.
- `capabilityHash` changes for those operations (expected and intended).

**Tests:** cursor round-trips, tampered cursors (`INVALID_INPUT`), projections pass the
output check, filters on undeclared fields are rejected, and the output-contract test gets
a paged case per operation.

**Measure:** response tokens for the list operations at the current seed size and at
10× seed size.

## Day 5: Discovery quality (2.7.0)

**Problem:** `search` only matches path globs, but agents think in intents ("refund a
guest"). Agents also get arguments wrong on the first try, which costs a turn.

**Design**
- **Ranked search:** `search({ query })` runs BM25 over each operation's name, title,
  description, tags and module description, and returns ranked results with a
  `matchedOn` field. Glob `pattern` keeps working, and an optional embedding re-rank can
  come later (open question). This covers PRD §7.7.
- **`describe_tool` gains:**
  - `examples`: one valid input/output pair. A test fails if an example doesn't
    validate against both schemas.
  - `relatedOps` / `nextSteps`, for example `searchAvailability → createReservation
    (slot.id)`
  - `sideEffects` and `preconditions`, each a line of plain text
  - `compensatedBy`: the undo operation, where one exists
- Examples are required for every operation, enforced by the test, like `.describe()`
  already is.

**Tests:** a fixed set of 30 intent queries, each with its expected top-3 operations
(committed, scored in CI); examples validate; related operations exist.

**Measure:** top-1 and top-3 accuracy on the query set, glob against BM25.

## Day 6: MCP 2026-07-28 upgrade (2.4.0, shipped first)

**Problem:** our MCP surface speaks the handshake-based revisions (`2025-11-25` and
earlier). Current clients speak 2026-07-28, and both Events and Skills over MCP require
it. This is a dependency migration, not a NavWebMcp feature, so it gets its own day and
its own PR before anything is built on top of it.

**Design**
- Move from `@modelcontextprotocol/sdk` 1.26 and `mcp-handler` 1.1 to `mcp-handler` 2.x,
  which now depends on the split `@modelcontextprotocol/server` 2.x package (2.4.0 at the
  time of writing). Start the day by reading both changelogs; the import paths and the
  handler API change.
- Serve **both** generations: 2026-07-28 requests (protocol version in `_meta`,
  `server/discover`) and handshake clients through the spec's backward-compatibility
  rules. Dropping the handshake path would cut off today's clients.
- `server/discover` returns what `initialize` returns today: `serverInfo.version`
  (the NavWebMcp semver), `AGENT_INSTRUCTIONS` and the capabilities. Agents still use
  `getContext` + `getCapabilities` for the platform clock and the manifest.
- Statelessness: confirm that nothing in our MCP layer depends on a session.
  `load_tools` is already per user in shared state, so it should carry over; the test
  proves it.
- Credits, `requestId` / `callId`, auth and the body-size limits keep working on both
  paths. The e2e and stress scripts run against both.

**Versioning:** if no NavWebMcp surface changes (manifest, meta-ops, envelope, error
codes), this is a **PATCH**. If `server/discover` adds anything of ours, it's MINOR.

**As shipped (2.4.0, MINOR):** natively called tools now answer bad arguments with
NavWebMcp's `INVALID_INPUT` instead of the SDK's text line, which is observable.
Two findings for later days:
- The SDK v2 only converts **Zod 4** schemas itself. We stay on Zod 3 and hand it our own
  JSON Schemas through `fromJsonSchema`, so `tools/list` now publishes exactly what
  `describe_tool` does. A Zod 4 migration is optional, not needed.
- `fromJsonSchema` compiles a validator immediately, and a server is built per request.
  Each operation's SDK schemas are therefore built once per process; doing it per
  request cut throughput about ninefold in the S13 soak.

**Tests:** the existing MCP suites on both protocol generations; an unsupported version
gets `UnsupportedProtocolVersionError` listing ours; `tools/list` matches across the two
paths; a promoted tool shows up on a later request without any session state.

**Measure:** `bench.mjs` and `credits-stress.mjs` before and after, to show no cost or
latency regression from the migration.

## Day 7: Events, skills over MCP and output safety (2.8.0)

Builds on Day 6. Both extensions are opt-in: a server advertises them in
`server/discover`, a client declares them per request, and nothing changes for a client
that doesn't.

**Design**
- **Events** (`io.modelcontextprotocol/events`). This replaces the earlier plan for our
  own push channel, and the open question about whether `mcp-handler` can push.
  - Event types in `events/list`, each with an `inputSchema` for subscription arguments
    and a `payloadSchema`: `reservation.created`, `reservation.cancelled`,
    `table.status_changed`, `task.assigned`. This covers PRD §7.5.
  - **Poll first** (`events/poll`). It keeps no per-client state on the server, which
    fits Next.js and our shared state. The cursor is an HMAC'd position in a per-type
    event log kept in shared state (Redis when configured), with a bounded retention;
    past it, `truncated: true`. Push (`events/stream`) only if `mcp-handler` 2.x supports
    long-lived requests; webhooks later.
  - `eventId` stays stable for deduplication. Payloads are minimal (an id and the fields
    needed to triage), and the agent fetches the rest with normal operations.
  - RBAC at subscribe time and again at delivery: a customer only sees their own
    reservations. A revoked agent's subscriptions end.
  - Credits: a poll is charged like a read.
- **Skills over MCP** (`io.modelcontextprotocol/skills`).
  - `skills/list` and `skills/get` serve `skill://navwebmcp-agent/SKILL.md` with its
    manifest (every file's SHA-256 and size), and `resources/read` serves the files.
    Needs the `resources` capability.
  - The digests are computed from the bytes at build time, and a test fails if the
    manifest and the file disagree.
  - Once hosts load the skill from the server, `AGENT_INSTRUCTIONS` can shrink to the
    rules that must be in every handshake, pointing at the skill for the rest. Measure
    before shrinking, since today no Claude host loads skills over MCP.
- **Field-level untrusted content:** outputs mark user-written fields (`specialNotes`,
  `body`, `note`) individually instead of flagging the whole operation with
  `untrustedOutput`. On the wire they become `{ "untrusted": "..." }`, so agents quote
  them as data. A schema helper does it, and a test checks every free-text field is
  wrapped. Event payloads use the same helper, as the Events spec requires.
- **`load_tools` returns the new tool list inline**, so agents stop re-fetching
  `tools/list` blindly. Stateless MCP only gets `list_changed` over a `subscriptions/listen`
  stream, which agents may not hold.

**Tests:** subscribe, poll and resume from a cursor; `truncated` past retention;
duplicates share an `eventId`; RBAC at delivery (another user's reservation is never
delivered); skill digests match the served bytes; `skills/get` for an unknown URI is
`-32602`; untrusted wrapping round-trips, and existing UI consumers unwrap correctly.
Use the MCP Inspector (it has partial Skills support) as a second, independent client.

**Measure:** an agent loop that waits for `reservation.created` by polling events,
against one that polls `listAllReservations`: calls, tokens and credits per detected
change.

## Day 8: Least-privilege agent tokens (2.9.0)

**Problem:** an agent token carries the user's whole role for 8 hours.

**Design**
- When minting a token (the "Connect an AI Agent" card and an admin API), the user can
  restrict it:
  - `permissions: ["read"]`
  - `modules: ["reservation.*"]`
  - `operations: [...]`
  - `limits: { maxRefundAmount, maxCallsPerHour }`
  - `expiresIn`
- `execute()` checks the token's scope after RBAC. `getCapabilities` and `search` show only
  what the token can call, and `capabilityHash` follows. A refusal is `FORBIDDEN` with
  `details: [{ path: "scope" }]`.
- Refresh tokens: short access tokens plus a refresh token that the management layer can
  revoke.
- Follow the two MCP auth drafts rather than invent our own versions: bind each token to
  the client that requested it ([#1932](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1932)),
  and leave room for cloud agents that sign in with their own identity
  ([#1933](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1933)).
  Re-read both at the start of the day, since they may have changed or merged.
- Event subscriptions (Day 7) obey the token's scope too, at subscribe time and at
  delivery.
- A per-write `reason` (optional, ≤ 200 chars), stored in the SOC2 audit trail, so an
  audit can answer "why did the agent refund this?".

**Tests:** every scope dimension; amount limits on `issueRefund`; refresh after revocation
fails; `getCapabilities` is filtered by scope.

## Days 9–10: Make it a protocol, not just this app

- **`SPEC.md`:** numbered MUST/SHOULD rules extracted from the PRD, README, changelog and
  skill, plus JSON Schemas for the 12 always-on operations, the `Result` envelope, the
  error object and the error-code catalogue. It becomes the normative source; the README
  links to it.
- **Conformance kit:** `npx navwebmcp-conformance <url> --token …` runs the spec's checks
  against any server. The e2e scripts from each day become its first checks.
- **Package:** extract the registry, `execute()`, the adapters, the polyfill and the
  result/error types as `@navwebmcp/server`. This repo becomes its first consumer.

## Later (not scheduled yet)

- **Code mode:** generate a typed TypeScript API from the registry, and let an agent send
  a short sandboxed script that calls several operations. Costed through credits.
- **A second implementation:** in another stack (Python or .NET), validated by the
  conformance kit.
- **Real-LLM benchmark:** task success, turns and tokens for real model agents with and
  without these features, alongside `bench.mjs`'s scripted lanes.

## Open questions for you

1. **Confirmation enforcement:** keep requiring tokens opt-in (2.x), or plan 3.0.0 with
   tokens required by default?
2. **`$ref` syntax:** plain paths only, or the small filter subset
   (`[?available==true]`)?
3. **Ranked search:** BM25 only, or also embeddings (needs a model call or a bundled
   model)?
4. **Handshake clients:** keep serving the pre-2026-07-28 handshake after Day 6
   (planned), and if so, for how long?
5. **Second implementation:** which stack, if any?
6. **Order:** answered. Day 6 went before Day 3, so confirmation is built once, on the
   new SDK, with elicitation.
7. **Events retention:** how far back may a cursor resume (planned: 24 h, like
   idempotency records)? Longer means more Redis memory.
8. **Enterprise-Managed Authorization:** now a stable extension. Worth a day after Day 8,
   or not needed for this app?
