# Handoff: NavWebMcp protocol work (as of 2026-11-26)

For the next agent picking up the NavWebMcp protocol work in `C:\git\webmcp`
(GitHub: `eliadco5/NavWebmcp`, default branch `master`). Read this first, then
[`agent-protocol-roadmap.md`](agent-protocol-roadmap.md), which is the plan you'll be executing.

## 1. Where things stand

- `master` is at **`2a5d1ba`**, NavWebMcp protocol **2.0.0** (`lib/protocol.ts`).
- Both PRs from this work are **merged**:

| PR | Branch | What | Commits |
|---|---|---|---|
| [#21](https://github.com/eliadco5/NavWebmcp/pull/21) | `feature/protocol-2.0-agent-contract` | Protocol 2.0.0, plus test-tooling fixes | `ae5dff2` tooling, `bcdad09` protocol |
| [#22](https://github.com/eliadco5/NavWebmcp/pull/22) | `docs/agent-protocol-roadmap` | Roadmap for the next tiers | `1fe8416` |

- Nothing is in flight: no open PRs from this work and no uncommitted changes.
- **Next task: Day 1 of the roadmap (idempotency keys, 2.1.0).** It doesn't depend on any
  of the open decisions in §7.

## 2. What 2.0.0 changed (so you don't re-derive it)

| Change | Where | Behaviour now |
|---|---|---|
| `invoke` flattened | `lib/operations/invoke.ts` | A single call returns the op's own `Result`: no `{success:true, data:{success:false…}}`. A failed op makes `invoke` fail; on MCP that's `isError`. Batch `{calls}` still returns `{results:[Result…]}`. `name` + `calls` together is `INVALID_INPUT`. `openOutput: true`, so its output schema allows any keys. |
| One set of error codes | `lib/operations/execute.ts` | The per-surface `DISPATCH_CODES` / `SURFACE_CODES` are gone. Bad input is `INVALID_INPUT` everywhere (`INVALID_ARGS` and `INVALID_DATE` are removed). An unknown op is `UNKNOWN_TOOL` everywhere; `/api/call` still answers HTTP 404. |
| Structured errors | `lib/result.ts` (`ProtocolError`, `PROTOCOL_ERROR_CODES`, `fail()`, `invalidInput()`) | `{code, message, retryable, details?, hint?, suggestions?, requestId?, callId?}`. `execute()` passes every failure through `normaliseFailure()`. When `invoke` relays a failure, it keeps the **inner** `callId`. `suggestOpNames()` only suggests names the caller's role can see. |
| Platform clock | `lib/operations/getContext.ts` | Adds `role`, `now`, `today` and `timezone` (`UTC`, which is what the stores use). `page` is now `null` on the server. Credits are unchanged. |
| `capabilityHash` | `lib/capabilities.ts` | Canonical JSON of the full input/output JSON Schemas, credit cost and behaviour flags, cached per op in a `WeakMap`. Before, it hashed key names only. |
| `openOutput` flag | `lib/operations/types.ts`, `lib/schema.ts` | `outputObject(shape, open)` and `envelopeSchema(shape, open)` add `.passthrough()`. Wired through the MCP adapter, `describe_tool`, AgentBridge and the WebMCP adapter. |
| Surface literals | `app/api/call/route.ts`, `app/api/[transport]/route.ts`, `lib/http-limits.ts`, `lib/agentbridge.ts`, `app/providers.tsx` | Build errors with `fail()` / `invalidInput()`. Non-protocol routes (login, admin, `ui/relay`, `ui/snapshot`) still use bare `{code, message}` literals, on purpose. |

Agent-facing docs updated to match: `lib/agent-instructions.ts`, `skills/navwebmcp-agent/SKILL.md`
(revision 2.0.0, protocol `>=2.0.0 <3.0.0`), `README.md`, `docs/webmcp-alignment.md`,
`CHANGELOG.md` (2.0.0 entry with migration notes).

**Test-tooling fixes** (`ae5dff2`, all problems that already existed):
- `vitest.config.ts` excludes `.claude/**`
- 14 type-check errors in test files fixed
- `scripts/speedbase.mjs` selects the tab first and matches labels exactly
- `tests/unit/protocol.test.ts` parses frontmatter with CRLF line endings

## 3. Architecture you'll touch (master as of 2.0.0)

- **`lib/operations/execute.ts` is the only execution path.** Every surface ends here:
  MCP (`lib/adapters/mcp.ts`), `POST /api/call` (UI and in-page WebMCP), `invoke`, and
  composites through `makeDispatch` / `runOne` (`lib/operations/dispatch.ts`). Its order
  is: fan-out limits (nested calls) → credits admission (top-level only) → lookup → RBAC →
  strict Zod input → handler with deadline → output check → `finish()`. `finish()`
  normalises the failure, settles credits, and writes the activity log, SOC2 audit and
  telemetry.
- **Context:** `OperationContext { userId, role, token, actor?, meta? }`. `meta` carries
  `requestId`, `callId`, `parentCallId`, `depth`, `fanout` and `channel`.
- **Credits** (`lib/credits/`, `docs/credits.md`): only the top-level call pays. State goes
  out in MCP `_meta["navwebmcp/credits"]`, in HTTP headers on `/api/call`, and on the
  Result only when there's a hint.
- **Shared state** (`lib/shared-state/`): in memory per process, or Redis when `REDIS_URL`
  is set. `withSharedState` holds a mutex around each request.
- **Protocol bump rules:** `CHANGELOG.md` top section. `tests/unit/protocol.test.ts`
  enforces that a changelog heading exists for `PROTOCOL_VERSION`, and that the skill's
  version range admits it.

## 4. How to verify (the "full cycle", which the user expects every time)

```bash
git fetch origin && git log --oneline HEAD..origin/master   # must be empty before you open a PR
npm test                      # 992 passed, 4 skipped as of 2.0.0
npm run test:redis            # 4 passed; needs Docker (docker compose, port 6390); --keep leaves Redis up
npm run type-check            # 0 errors
npm run build
REDIS_URL= npm start          # see the Redis trap in §5
node scripts/bench.mjs --n=5
node scripts/speedbase.mjs --n=5
node scripts/credits-stress.mjs --base=http://localhost:3000 --quick        # 88/88 as of 2.0.0
# two instances sharing Redis, outage scenarios included (96/96 as of 2.0.0):
REDIS_URL=redis://localhost:6390 npx next start -p 3201   # and -p 3202
node scripts/credits-stress.mjs --base=http://localhost:3201 --base2=http://localhost:3202 --redis-container=webmcp-redis-1
```

**Benchmark against master, not against the committed `docs/bench-results.json`.** That
file is stale. Build master in a temporary worktree, serve it on port 3001, and run
`BENCH_BASE=http://localhost:3001 node scripts/bench.mjs` from that worktree.

**After benchmarks, restore the files they rewrite:**
`git checkout -- docs/bench-results.json docs/speedbase-results.json` and delete
`docs/bench-data.js` / `docs/speedbase-data.js`. They aren't committed, and the README
numbers must stay in sync with the committed data.

**2.0.0 baseline:** compared with 1.4.0 on the same machine, the `invoke` lanes in
`bench.mjs` used 10–13% fewer tokens. Every other lane was identical, and every lane
succeeded 5/5.

**End-to-end script:** a 29-check script over real MCP HTTP and `/api/call` exists, but
**outside the repo**, at `%LOCALAPPDATA%\Temp\claude\webmcp-e2e\e2e.mjs`. Run it from the
repo root. It may not survive; consider committing an equivalent under `scripts/` as part
of Day 1 (the roadmap's per-day e2e check needs one).

## 5. Environment traps (each one cost time)

- **Pushing:** git's stored credential is `eliad-cohen_priority`, which gets a 403 on
  this repo. The `gh` CLI is signed in as `eliadco5` (the owner). Push with:
  `git -c credential.helper= -c "credential.helper=!gh auth git-credential" push …`.
  Don't change the user's git config.
- **`.env.local` sets `REDIS_URL` to a remote Redis.** Every operation call then waits
  about 300 ms (against about 2 ms without), so benchmarks are about 60× slower. Run
  benchmarks with `REDIS_URL=` (empty) unless you're testing Redis on purpose.
- **Branch from latest `origin/master`.** PR #21 was first cut from `report-a-bug`, which
  was 22 commits behind, and had to be rebuilt. Check with `git log HEAD..origin/master`
  before opening a PR.
- **`.claude/worktrees/ecstatic-knuth-a38e95`** is an old agent worktree (its branch was
  merged as PR #20). Vitest now ignores it. Don't run tests from inside it.
- **Windows:**
  - Files are CRLF in the working copy (`core.autocrlf`). Scripted edits must
    normalise line endings first or exact-match replacements fail.
  - Python can't see Git Bash's `/tmp`; use repo-local temp files and delete them.
  - Stop servers with `netstat -ano | grep :PORT` then `taskkill //PID <pid> //T //F`.
- **Temporary worktrees:** if you link `node_modules` into one with a junction
  (`mklink /J`), remove the junction first (`cmd //c "rmdir <path>\node_modules"`), and
  only then run `git worktree remove --force`. Otherwise the force-remove can delete the
  real `node_modules` through the junction.
- **MCP servers configured for this session** (`booking`, `agentbridge-booking`, …) point
  at `localhost:3000`. They fail to connect unless the app is running, which is normal.

## 6. Leftovers you may clean up (ask first)

- Local branch `backup/protocol-2.0-on-report-a-bug`: the first, stale-based attempt at
  2.0.0. Obsolete now that #21 is merged.
- Local branches `feature/protocol-2.0-agent-contract` and `docs/agent-protocol-roadmap`:
  merged.
- Neither is needed. Delete them only if the user agrees.

## 7. Open decisions (from the roadmap; ask the user, don't assume)

1. **Confirmation tokens:** mandatory by default in a 3.0.0, or opt-in in 2.x? (Day 3)
2. **`$ref` syntax for dependent batches:** plain paths only, or a small filter subset?
   (Day 2)
3. **Ranked search:** BM25 only, or embeddings too? (Day 5)
4. **Push notifications:** spend time checking whether `mcp-handler`'s Streamable HTTP
   mode can push `list_changed`, with an inline fallback if it can't? (Day 6)
5. **Second implementation:** which stack, if any?
6. **Order:** safety first (Days 1, 3, 7), or token savings first (Days 2, 4)?

## 8. How the user works

- They want the **full verification cycle** run (§4) and the results reported plainly,
  including what failed or wasn't covered.
- **One PR per change, from latest master.** They review on GitHub. Follow the
  commit/PR attribution lines your harness specifies.
- They caught the stale-base mistake themselves. Run the "behind master?" check
  proactively and say that you did.
