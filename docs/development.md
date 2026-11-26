# Developing AgentBridge

How to extend this repo: add operations, composites and agent-operable UI, and how to test and benchmark the result.

## Testing and verifying a change

A protocol change is done when it passes the whole cycle below. Each step catches something the others don't.

```bash
npm test                     # unit + integration (Vitest); add --maxWorkers=4 on a slow machine
npm run test:redis           # the Redis-backed paths against a real Redis (needs Docker)
npm run type-check           # app and tests
npm run build

REDIS_URL= npm start                                          # in another terminal
node scripts/e2e.mjs                                          # real MCP HTTP + /api/call, one section per protocol feature
node scripts/credits-stress.mjs --base=http://localhost:3000 --quick   # stress, negative and end-to-end checks
node scripts/bench.mjs --n=5 && node scripts/speedbase.mjs --n=5       # benchmarks (see benchmarks.md)
```

- **Two instances on Redis.** Start two servers with `REDIS_URL=redis://localhost:6390` (`npm run test:redis -- --keep` leaves one running) on ports 3201 and 3202. Then run `node scripts/credits-stress.mjs --base=http://localhost:3201 --base2=http://localhost:3202 --redis-container=webmcp-redis-1`. This adds the cross-instance and Redis-outage scenarios.
- **Benchmark against `master`, not against the committed numbers.** See [benchmarks.md](benchmarks.md#reproduce).
- **A protocol change** also needs a `CHANGELOG.md` entry and a `PROTOCOL_VERSION` bump (rules at the top of the changelog), and matching lines in `lib/agent-instructions.ts` and `skills/navwebmcp-agent/SKILL.md`. `tests/unit/protocol.test.ts` enforces the changelog heading and the skill's version range.

## Adding a server-side operation

1. **Create `lib/operations/your-op.ts`:**

```typescript
import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { Id, ItemSchema } from "./schemas";

export const yourOp = defineOperation({
  name: "yourOp",
  title: "Your Op",
  description: "...",
  permission: "read",
  roles: ["customer", "admin"],
  module: "reservation.search",   // places it in the module tree
  tags: ["booking"],
  inputSchema: {
    id: Id().describe("Resource ID"),        // every field needs .describe() and a bound
  },
  outputSchema: {                            // the success `data`; required
    item: ItemSchema,
  },
  untrustedOutput: false,                    // true if `data` contains user-written free text
  async handler({ id }, ctx) {
    const item = store.getItem(id, ctx.userId);
    if (!item) return fail("NOT_FOUND", `Item ${id} not found`);
    return ok({ item });                     // type-checked against outputSchema
  },
});
```

Notes:
- Input is validated **strictly**: unknown keys are rejected. Use the shared field helpers in `lib/operations/schemas.ts` (`Id`, `IsoDate`, `TimeHHMM`, `ShortText`, `LongText`, `Money`, `Points`). `tests/unit/input-schema.test.ts` fails if any input string is left unbounded or any field has no description.
- Put reusable entity schemas (`ReservationSchema`, `GuestSchema`, …) in `lib/operations/schemas.ts`. Its `SchemaTypeChecks` stop them drifting from the TypeScript types.
- Use `as const` for literal fields such as `ok({ deleted: true as const })`, or TypeScript will widen them.

2. **Register it in `lib/operations/index.ts`:**

```typescript
import { yourOp } from "./your-op";
registry.push(yourOp);
```

3. **Add a happy-path case to `tests/unit/output-contract.test.ts`.** That test fails until every registered op has one, and it checks that the returned `data` matches `outputSchema` exactly. This matters because the MCP SDK rejects a non-matching `structuredContent` at runtime.

The operation automatically appears on both surfaces with full RBAC, audit logging, progressive disclosure, input/output schemas and annotations. To add a new module to the tree, append an entry to `MODULE_DEFS` in `lib/modules.ts`.

**Audit and attribution come for free, with two things to know:**

- **Don't log or check roles yourself.** `execute()` already records the call in the audit trail and metrics, with the actor, channel and outcome, and enforces `roles`.
- **Stamp what you create or change.** If the operation creates or changes a record, write `createdBy: stamp(ctx)` or `lastModifiedBy: stamp(ctx)` (from `lib/provenance.ts`) onto it, and add `...Stamps()` to its entity schema in `lib/operations/schemas.ts`. Then the record itself says who did it.

Optionally, tune the audit with the operation's `audit` field:

```typescript
audit: {
  redact: ["reason"],                                    // extra input/output keys never to store
  target: (input) => ({ type: "payment", id: String(input.paymentId) }), // the record it acts on (null = none)
},
```

Without it, known secrets and personal data are redacted, and the target record is
inferred from the output or the input's id fields.

## Adding a composite tool

A composite tool has three layers: a surface-agnostic core, a browser wrapper, and an MCP operation. `lib/core/seatGuest.ts` / `lib/ui-tools/seatGuest.ts` / `lib/operations/seatGuest-op.ts` is the shortest real example to copy.

**1. `lib/core/your-tool.ts`** — no `"use client"`, takes a `call` dependency:

```typescript
export async function yourToolOrchestration(
  input: YourInput,
  call: (name: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<Result<YourResult>> {
  const a = await call("existingOp", { ...input }) as { success: boolean; data?: ... };
  if (!a.success) return fail(a.error?.code ?? "ERR", a.error?.message ?? "Failed");
  const b = await call("anotherOp", { id: a.data!.id }) as { success: boolean; data?: ... };
  if (!b.success) return fail(b.error?.code ?? "ERR", b.error?.message ?? "Failed");
  return ok({ result: b.data, validated: true });
}
```

**2. `lib/ui-tools/your-tool.ts`** — browser wrapper injecting `serverCall`:

```typescript
"use client";
import { serverCall } from "@/app/providers";
import { yourToolOrchestration } from "@/lib/core/your-tool";
export const yourTool = (input: YourInput) => yourToolOrchestration(input, serverCall);
```

**3. `lib/operations/your-tool-op.ts`** — the operation both surfaces publish:

```typescript
export const yourToolOp = defineOperation({
  name: "yourTool",
  title: "Your Tool",
  description: "Does X in one step.",
  permission: "write",
  roles: ["customer", "admin"],
  module: "your.module",
  inputSchema: { /* zod shape */ },
  outputSchema: { result: ResultSchema, validated: z.boolean() },  // = YourResult
  async handler(input, ctx) {
    return yourToolOrchestration(input, makeDispatch(ctx));
  },
});
```

**4.** Register it in `lib/operations/index.ts` and add a case to `tests/unit/output-contract.test.ts`. The tool is then registered in-page automatically by `initAgentBridge`, with no hand-written `registerTool` call. The browser wrapper from step 2 is only needed if the UI calls the composite itself.

## Making a UI component agent-operable

Business operations return data to the agent. To let an agent change what the user **sees**, such as a table's filters and sort or the active tab, make the component agent-operable. The agent then uses the always-on `ui_list` / `ui_set_state` / `ui_get_state` / `ui_action` ops and never touches the DOM. The full spec is in [ui-components.md](ui-components.md).

**1.** Lift the controls' state into one object. Build its schema with the standard helper for the component's kind (`tableStateSchema` / `tabsStateSchema` in `lib/ui-components/kinds.ts`), at module level so it stays stable. Mirror the backing operation's inputs, and `.describe()` every field.

**2.** Call `useAgentComponent({ id, kind, title, schema, state, setState, initialState, actions, view })` (`lib/ui-components/useAgentComponent.ts`). That's all. Both the in-page agent and MCP clients (through the UI relay to the user's open tab) can now drive the component. The reference implementations are `components/TaskSearchCard.tsx` (`tasks.table`) and `components/AppShell.tsx` (`app.nav`).

For the full protocol, a framework-agnostic build guide for other apps, and a worked example with real responses, see [Agent-operable UI components](ui-components-guide.md) above.

## Shipping a new UI feature — feature intros

Every user-facing feature ships with a short interactive guide. It plays the first time a user opens the tab the feature lives on, and never again once they finish or skip it. Users can replay a guide any time with **▶ Take the tour** at the end of the tab strip (shown on tabs that have one), or from **What's new** next to it.

**1.** Put `data-intro="<name>"` on the elements the guide should spotlight. Use this attribute rather than a class name, so restyling doesn't break the guide.

**2.** Add `lib/feature-intros/intros/<feature>.ts` and list it in `FEATURE_INTROS` (`lib/feature-intros/registry.ts`):

```ts
export const myFeatureIntro: FeatureIntro = {
  id: "my-feature",        // stable, kebab-case
  version: 1,              // bump to show it again after a meaningful change
  tab: "tasks",            // tab id from lib/feature-intros/tabs.ts
  roles: ["support", "admin"], // optional; omit for every role
  title: "Task templates",
  steps: [
    { title: "What it is", body: "…" },                           // no target = centred
    { target: "task-templates", placement: "right", title: "…", body: "…" },
  ],
};
```

**3.** Run `npm test`. `tests/unit/feature-intros.test.ts` fails if an intro points at a tab that doesn't exist or a `data-intro` target that isn't in `components/`.

Which guides a user has seen is stored per user on the server (`/api/intros`, `lib/feature-intros/seen-store.ts`): a long-lived Redis set when `REDIS_URL` is set, in memory otherwise. This is UI state, not an operation, so it doesn't change `capabilityHash` or `PROTOCOL_VERSION`. A new tab needs its id added to `lib/feature-intros/tabs.ts`.

## Project structure

```
app/
  page.tsx                 ← root page — <Providers><AppShell/></Providers>
  providers.tsx            ← auth bootstrap, WebMCP registration, confirmation dialog, audit polling
  api/[transport]/route.ts ← MCP Streamable HTTP (auth, request gate, body checks, text format)
  api/call/route.ts        ← UI and in-page WebMCP operation dispatcher
  api/login, logout, me    ← sign-in (new session id), logout (ends it server-side), current user + agent token
  api/switch-role/         ← demo-mode role switcher (re-mints the caller's own session)
  api/agent-clients/       ← self-service: list / create / revoke your own agent clients
  api/audit/               ← activity feed (scoped per viewer); report/ takes in-page ui_* writes
  api/admin/               ← admin only: audit (search, verify, export), metrics, sessions, clients, credits, health, users
  api/ui/relay, ui/snapshot← the UI relay: MCP ui_* calls reach the user's open tab
  api/bug-report/          ← the in-app "Report a bug" inspector
  api/intros/              ← which feature intros a user has seen
  api/bench/reset/         ← re-seeds every store; used by the benchmarks and "Reset demo data"

lib/
  operations/              ← the operation registry (one file per op); index.ts registers them
    execute.ts             ← THE execution path: fan-out → credits → lookup → RBAC → validate → idempotency → handler → audit
    dispatch.ts            ← in-process dispatcher: runOne(), makeDispatch(ctx)
    invoke.ts, refs.ts     ← invoke, single and batch; $ref parsing and resolution
    book-op.ts, seatGuest-op.ts, hostVipGuest-op.ts   ← composites as operations
    management.ts          ← admin.* operations (audit, metrics, sessions, agents, credits)
    ui.ts                  ← the ui_* operations
  core/                    ← surface-agnostic composite orchestrations (book, seatGuest, hostVipGuest)
  ui-tools/                ← thin browser wrappers, one per composite
  adapters/
    mcp.ts                 ← registry → MCP server tools (annotations, credits/idempotency _meta, text format)
    webmcp.ts              ← registry → document.modelContext
  agentbridge.ts           ← AgentBridge SDK (register, call, describe, subscribe)
  webmcp-polyfill.ts       ← document.modelContext shim for pre-standard browsers
  modules.ts               ← module tree + explore()/search() helpers
  protocol.ts              ← PROTOCOL_VERSION
  agent-instructions.ts    ← shared connect-time instructions (both surfaces)
  capabilities.ts          ← role-scoped capability manifest and capabilityHash
  result.ts                ← ok() / fail(), ProtocolError, PROTOCOL_ERROR_CODES
  schema.ts                ← strict input objects, output checks, JSON Schema
  idempotency/             ← idempotency keys: store port (memory) and Redis store
  credits/                 ← SMB-style credits: policy, ledger (Redis CAS), hints, request gate, admit/settle
  audit/                   ← SOC2 audit trail: store, hash chain, redaction, sinks (webhook, OTLP)
  telemetry/               ← usage metrics, summaries, OTLP traces/metrics
  management/              ← sessions and agent clients, revocation-aware auth, admin guard
  ui-components/           ← the page-side component registry and contract (agent-operable UI)
  ui-relay/                ← the relay that carries MCP ui_* calls to the page
  shared-state/            ← Redis client (fails fast to in-memory), hydrate/flush, state lock
  store.ts, seed/          ← in-memory business stores and their seed data
  auditlog.ts              ← activity feed (last 100 calls, for the UI)
  provenance.ts            ← createdBy / lastModifiedBy stamps
  auth.ts, auth-tokens.ts  ← RBAC roles; signed session cookies and agent tokens
  http-limits.ts, login-throttle.ts ← JSON body caps; failed sign-in throttle
  bugreport/               ← bug-report capture, replay and sinks (Jira)
  feature-intros/          ← first-visit guides per tab

components/                ← the UI: AppShell (tabs), one *Panel per tab (Reservations, Front Desk, CRM,
                              Tasks, Housekeeping, Finance, Agent, Users, Bug reports), cards, management/, bugreport/

scripts/
  e2e.mjs                  ← end-to-end checks over real MCP HTTP and /api/call
  credits-stress.mjs       ← stress, negative and two-instance tests (npm run test:stress)
  bench.mjs                ← agent-transport benchmark (7 lanes × 4 flows)
  speedbase.mjs            ← function-call vs Playwright test-speed benchmark
  test-redis.mjs           ← npm run test:redis: start Redis (docker-compose.yml), run live tests, stop
  mcp-client.mjs           ← a minimal MCP client for manual calls
  build-pptx.mjs           ← builds docs/talk-add.pptx
tests/
  unit/, integration/      ← Vitest suites (integration/redis-live.test.ts needs a real Redis)
  bench/operation-speed.test.ts ← in-process runOne() timing, spawned by speedbase.mjs
benchmark.mjs              ← earlier /api/call-only harness, kept for provenance
skills/navwebmcp-agent/    ← the agent-side skill for any NavWebMcp server
docs/                      ← the guides linked from the README; plans/ holds the roadmap
```

## Tech stack

- **Next.js 15** (App Router, React 19)
- **TypeScript 5**
- **Zod** — runtime input validation, JSON Schema generation
- **`@modelcontextprotocol/server`** (MCP SDK v2) — MCP server; speaks the 2026-07-28
  revision and, through its stateless fallback, 2025-era clients
- **`mcp-handler`** 2.x — the Next.js route handler around it
- **`@modelcontextprotocol/client`** (dev) — the client in `scripts/` (e2e, bench)
- **`zod-to-json-schema`** — Zod → JSON Schema for WebMCP tool registration
- **Playwright**, **Vitest** — benchmark and test harnesses

## Testing against a real Redis locally

`npm test` never needs Redis. The Redis-backed paths — the audit hash chain's concurrent appends, metrics buckets, session/agent revocation — have their own live tests (`tests/integration/redis-live.test.ts`), skipped unless a Redis is available. With Docker Desktop running:

```bash
npm run test:redis            # starts Redis (docker-compose.yml, port 6390), runs the live tests, stops it
npm run test:redis -- --keep  # leave the Redis running afterwards
```

Already running a Redis? `REDIS_LIVE_URL=redis://localhost:6379 npm run test:redis -- --no-docker`. The live tests write under their own namespace and delete their keys when done. To run the app itself against the local Redis: `docker compose up -d redis`, then `REDIS_URL=redis://localhost:6390 npm run dev`.
