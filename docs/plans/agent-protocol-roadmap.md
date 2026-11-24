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
(both on Day 7).

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

| Day | Version | Theme | Main agent win |
|---|---|---|---|
| 1 | 2.1.0 | Idempotency keys | Safe retries of writes |
| 2 | 2.2.0 | Dependent batches | Multi-step flows in one round trip |
| 3 | 2.3.0 | Confirmation previews, tokens, dry-run | Real human-in-the-loop; check a plan before asking |
| 4 | 2.4.0 | Pagination, filters, field selection | Lists stop eating the context window |
| 5 | 2.5.0 | Discovery quality | Find the right operation, and call it right, first time |
| 6 | 2.6.0 | Push and safety | No polling; prompt-injection-aware output |
| 7 | 2.7.0 | Least-privilege agent tokens | Safe to hand an agent a token |
| 8–9 | — | Spec, conformance kit, package | NavWebMcp usable outside this repo |
| Later | — | Code mode, second implementation, real-LLM benchmark | Proof the protocol carries the claim |

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

## Day 3: Confirmation previews, tokens and dry-run (2.3.0)

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
  asks the user directly with the preview text and confirms on their answer. This is the
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

## Day 4: Pagination, filters and field selection (2.4.0)

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

## Day 5: Discovery quality (2.5.0)

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

## Day 6: Push notifications and output safety (2.6.0)

**Design**
- **`notifications/tools/list_changed`** after `load_tools` / `unload_tools`, so agents
  stop re-fetching `tools/list` blindly. Feasibility depends on `mcp-handler`'s Streamable
  HTTP mode (open question). If it can't push, `load_tools` returns the new tool list
  inline as a fallback.
- **Domain events as MCP resources:** for example `reservation.created` and
  `table.status_changed`, through resource subscriptions. This covers PRD §7.5. It
  needs the same push channel; if that's unavailable, it moves into the code-mode bucket.
- **Field-level untrusted content:** outputs mark user-written fields (`specialNotes`,
  `body`, `note`) individually instead of flagging the whole operation with
  `untrustedOutput`. On the wire they become `{ "untrusted": "..." }`, so agents quote
  them as data. A schema helper does it, and a test checks every free-text field is
  wrapped.

**Tests:** a notification is received in the in-memory transport; untrusted wrapping
round-trips; existing UI consumers unwrap correctly.

## Day 7: Least-privilege agent tokens (2.7.0)

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
- A per-write `reason` (optional, ≤ 200 chars), stored in the SOC2 audit trail, so an
  audit can answer "why did the agent refund this?".

**Tests:** every scope dimension; amount limits on `issueRefund`; refresh after revocation
fails; `getCapabilities` is filtered by scope.

## Days 8–9: Make it a protocol, not just this app

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
4. **Push channel:** OK to spend part of Day 6 checking whether `mcp-handler` can push
   notifications, with the inline fallback if it can't?
5. **Second implementation:** which stack, if any?
6. **Order:** this plan puts safety first (Days 1, 3, 7). If token savings matter more for
   a demo, Days 2 and 4 could move first.
