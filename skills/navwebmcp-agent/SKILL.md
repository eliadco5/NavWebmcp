---
name: navwebmcp-agent
version: 1.0.0
protocol: ">=1.0.0 <2.0.0"
description: >
  How to drive a NavWebMcp server efficiently. Use when connected to a server
  exposing progressive tool disclosure — the always-on meta operations explore,
  search, describe_tool, invoke, load_tools, unload_tools, getContext,
  getCapabilities — or when tools/list returns far fewer tools than the server
  claims. Covers the connect handshake, capability caching, discovery, sequential
  vs parallel vs bulk invocation, stateless invoke vs load_tools promotion,
  gather-first/ask-once, composite operations, the double-envelope result shape,
  and error handling. Consumer side only — not for building a server.
---

# NavWebMcp agent guide

NavWebMcp 1.x · skill revision 1.0.0. This document is valid for any server whose
`protocolVersion` satisfies `>=1.0.0 <2.0.0`. If the server reports a version outside
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
getContext()        // → { authenticated, ...caller identity fields }
getCapabilities()   // → { protocolVersion, capabilityHash, count, tools: [...] }
```

`getContext` answers *who is this?*; `getCapabilities` answers *what may they do?* — every
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
`load_tools`, `unload_tools`, `getContext`, `getCapabilities`. This is the design, not a
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
- **`describe_tool(name)`** — full input schema and metadata for one operation before
  calling it. Accepts an array too: `describe_tool(["opA", "opB"])` returns both in one
  call — never issue one call per name.

Use `explore` when you have a known path to walk, `search` when you have a keyword and no
path, and always finish with `describe_tool` before any write.

## 5. Call modes

NavWebMcp distinguishes several ways to invoke an operation — treat these as distinct
protocol features, not just syntax variants:

| Mode | Shape | Semantics |
|---|---|---|
| **Single** | `invoke({ name, args })` | One operation, stateless. Result is the inner `Result` wrapped once (see §8). |
| **Bulk / parallel** | `invoke({ calls: [{ name, args }, …] })` | The server partitions by parallel-safety: safe calls run concurrently, the rest run **in order**. Results are **re-indexed to input order**, so positional mapping onto your original call list is always safe. |
| **Sequential (forced)** | Separate `invoke` calls, or `parallelSafe: false` per call | Use when call N's arguments depend on call N-1's result. A single bulk call cannot thread an output into a later input — you must make the first call, read its result, then issue the second. |
| **Parallel (forced)** | `parallelSafe: true` per call | Override the default for a write operation you know to be independent of the others in the same batch. |
| **Composite** | one operation that internally orchestrates several steps | See §7 — the server does the sequencing, you make one call. |

Defaults, absent an explicit override: `permission: "read"` operations are parallel-safe;
`permission: "write"` operations are not. An operation may declare its own effective
`parallelSafe` value regardless of its permission — `describe_tool` reports the effective
value, so read it rather than assuming from `permission` alone.

Rules of thumb:
- Batch every independent read into one bulk `invoke` call.
- Never batch calls that have a data dependency on each other's result — use sequential
  calls instead.
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
{ "success": false, "error": { "code": "...", "message": "..." } }
```

**The double-envelope trap:** `invoke`'s outer result only tells you the call *dispatched*.
A failed operation still dispatches successfully, so you get:

```json
invoke({ "name": "someOp", "args": { "badField": true } })
// → { "success": true, "data": { "success": false, "error": { "code": "INVALID_ARGS", ... } } }
```

Always check the **inner** `success`, not just the outer one. The bulk form nests one
level further: `{ success: true, data: { results: [ <inner Result>, ... ] } }` — check
each element of `results` individually.

A promoted native tool (via `load_tools`) called directly through the host's tool-call
mechanism, rather than through `invoke`, typically returns its `data` unwrapped on success
and signals failure via the call's own error/`isError` mechanism instead of a nested
envelope — read your specific transport's convention, but the *inner* `Result` shape from
the operation itself is the same either way.

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

## 11. Error codes and how to react

| Code | Meaning | React |
|---|---|---|
| `UNAUTHENTICATED` | Credentials missing or expired | Re-authenticate. Don't retry the same call as-is. |
| `FORBIDDEN` | Caller's role can't access this operation | Stop — `getCapabilities` already told you this was off-limits. Don't retry. |
| `INVALID_ARGS` / `INVALID_INPUT` | Arguments failed validation (two spellings of the same condition occur across different surfaces of some implementations) | `describe_tool(name)`, fix the arguments, retry once. |
| `UNKNOWN_TOOL` | You called an operation name that doesn't exist | You likely guessed a name — use `search()` instead. |
| `NOT_FOUND` | A referenced entity or module path doesn't exist | Not retryable with the same identifier. |
| `CONFIRMATION_REQUIRED` | A `confirm` parameter was omitted on a gated operation | Ask the user, re-call with `confirm: true`. |
| `CONFIRMATION_DENIED` | User explicitly refused | Stop. Never retry. |
| `HANDLER_ERROR` | Unhandled server-side failure | Transient or a bug. Retry at most once. |

Servers may define additional domain-specific error codes beyond this protocol-level set.
Read the `message` field for those — don't blind-retry a code you don't recognize.

## 12. Anti-patterns

- Reading `tools/list` and guessing operation names from it, instead of using `explore`/`search`.
- Calling `explore()` on the whole tree when you already know the keyword — use `search()`.
- Calling `describe_tool` once per name instead of passing an array.
- Asking the user one question, waiting, then asking another.
- Promoting an operation via `load_tools` for a single call.
- Checking only the outer `success` and missing a failed inner result.
- Sharing one cached capability manifest across two different credentials/roles.
- Batching calls that have a data dependency into one bulk `invoke`.
- Hand-orchestrating a multi-step sequence without first searching for a composite operation.

## 13. Installing this skill

Copy this directory into your own agent's skills location:

- Project-scoped: `<your-repo>/.claude/skills/navwebmcp-agent/`
- Machine-wide: `~/.claude/skills/navwebmcp-agent/`

Symlinks work on macOS/Linux. On Windows, `mklink /D` requires admin rights or Developer
Mode — a plain copy is simpler. Verify the install with `/skills` in Claude Code and
confirm `navwebmcp-agent` is listed.
