# WebMCP alignment: spec vs. this repo

**Compared against:** the WebMCP Draft Community Group Report of **13 Nov 2026**
(<https://webmachinelearning.github.io/webmcp/>). It already includes `outputSchema`,
which was added on 2 Nov 2026 in
[webmachinelearning/webmcp#254](https://github.com/webmachinelearning/webmcp/pull/254).

**Our side:**
- `lib/webmcp-polyfill.ts`, the `document.modelContext` used when the browser has no
  native implementation
- `lib/agentbridge.ts`, which registers our operations into whichever `modelContext` is
  present
- NavWebMcp protocol **2.2.0** (`lib/protocol.ts`, `CHANGELOG.md`)

**The goal is alignment, not a clone.** Tools that AgentBridge registers must work on a
native `modelContext` exactly as the spec describes. The polyfill is a development
stand-in, and keeps a few conveniences the spec doesn't have. Each difference below is
either an **extension** (we add something the spec doesn't define) or a **divergence**
(we behave differently from the spec on purpose). Each one also says when to revisit it.

| Status | Meaning |
|---|---|
| ✅ Aligned | Matches the spec |
| ➕ Extension | Not in the spec. Additive, and harmless on a native implementation |
| ↔️ Divergence | Polyfill behaviour differs from the spec on purpose |
| ⏳ Not yet | In the spec, not implemented here |

## Tool descriptor (`ModelContextTool`)

| Member | Spec | Ours | Status |
|---|---|---|---|
| `name` | Required. 1–128 chars, `[A-Za-z0-9_.-]`, unique per document | Same character and length rule | ✅ |
| `title` | Optional `USVString`. `getTools()` returns `""` when it's absent | Optional. `getTools()` returns `undefined` when it's absent | ↔️ Minor. Spec issue #224 proposes omitting it, which is what we already do |
| `description` | Required, non-empty | Required. The polyfill doesn't reject an empty string | ↔️ Minor. Every one of our ops has a description |
| `inputSchema` | Optional JSON Schema `object` | Always sent. A strict object with `additionalProperties: false`, generated from Zod | ✅ |
| `outputSchema` | Optional JSON Schema `object`. Serialized at registration and returned as a deep copy | Always sent. Describes the **`Result` envelope** that `execute` resolves to (see below). The polyfill serializes it, returns deep copies, and throws `TypeError` for non-object or circular schemas | ✅ |
| `annotations` | `readOnlyHint`, `untrustedContentHint`, `consequentialHint`, `debugging` | `readOnlyHint` ← `permission: "read"`. `consequentialHint` ← `requiresConfirmation`. `untrustedContentHint` ← `untrustedOutput`. `invoke` dispatches other ops, so it is never marked read-only and always gets `consequentialHint` and `untrustedContentHint`. We never set `debugging` | ✅ |
| `execute(input, {signal})` | The callback receives an `AbortSignal` from a new per-execution `AbortController` | Same. AgentBridge passes the signal on to `fetch('/api/call')`. If the caller cancels while a confirmation dialog is open, the op never reaches the server (`CANCELLED`) | ✅ (1.2.0) |

### What our `outputSchema` describes

`execute()` returns our `Result` envelope, `{success: true, data} | {success: false, error: {code, message, retryable, …}}`,
so the WebMCP `outputSchema` is an `anyOf` over those two variants, with the operation's
data schema inside `data`.

- **Why:** the spec lets an agent reject output that doesn't match the schema. A schema
  for `data` alone would make every error result look non-conforming.
- **Spec position:** the spec defines no result wrapper, and says author-defined errors
  belong inside the response JSON. The envelope does exactly that, so this counts as
  aligned and not as a divergence.
- **MCP differs here on purpose.** MCP has `isError` for failures, so its `outputSchema`
  describes `data` only, and successful calls return it as `structuredContent`.

## `ModelContext` methods

| API | Spec | Ours | Status |
|---|---|---|---|
| `registerTool(tool, {signal, exposedTo})` | Returns `Promise<undefined>`. Unregisters when `signal` aborts | Same, including abort-to-unregister | ✅ |
| Duplicate name | Rejects with `InvalidStateError`, checked before name validation and again after schema serialization | Same. A name can be reused once its registration is aborted | ✅ (1.2.0) |
| Invalid name | Rejects with `InvalidStateError` | Throws `DOMException` with name `DataError` | ↔️ Minor. Only the error name differs |
| `registerTool` rejection handling | — | AgentBridge catches rejections and logs them (it used to discard the promise) | ✅ |
| `getTools({fromOrigins})` | Returns `Promise<sequence<RegisteredTool>>` | **Synchronous** array, polyfill only | ↔️ Revisit when we consume tools from a native implementation |
| `executeTool(registeredTool, input, {signal})` | Takes a `RegisteredTool` object. Resolves with a **JSON string**. Missing input defaults to `{}`. Aborting `signal` rejects with its reason, aborts the tool's signal, fires `toolcancel`, and ignores any later result | Takes a tool **name**. Resolves with the **raw value**. Defaults and cancellation behave as in the spec | ↔️ **Deliberate** for the name and the raw value. Our tests and console use read the value directly. Native-only callers (real browser agents) never touch the polyfill, so they can't be affected. Cancellation ✅ (1.2.0) |
| `RegisteredTool.window` / `.origin` | Present | Absent | ⏳ Not needed while there's a single origin |
| `exposedTo` / `fromOrigins`, and the `tools` Permissions Policy | Two-sided cross-origin opt-in | Not implemented. Everything is same-origin | ⏳ Revisit if a tool is ever embedded cross-origin (iframe) |
| `toolchange` event | Fired on register and unregister | Fired, and also carries `tool` and `action` properties | ➕ |
| `toolactivated` / `toolcancel` events | `ToolActivatedEvent` / `ToolCancelEvent` with `toolName`, fired at the `ModelContext`. `toolactivated` comes right after `execute` is invoked, before it settles | Same, plus the `ontoolactivated` / `ontoolcancel` handler attributes | ✅ (1.2.0) |
| Error types | `NotFoundError`, `DataError`, `OperationError`, `AbortError` | `NotFoundError` for an unknown tool, `InvalidStateError` for a duplicate name, and the caller's abort reason on cancel. Other failures come back inside the envelope | ↔️ Covered by the envelope |

## Extensions (not in the spec)

| Extension | Where | Why |
|---|---|---|
| `modelContext.instructions` | `lib/agentbridge.ts` | Behavioural guidance for in-page agents. Writing it is wrapped in try/catch, so a native object can refuse it |
| `modelContext.protocolVersion` | `lib/agentbridge.ts` | Lets an agent detect which NavWebMcp version it's talking to |
| `navigator.modelContext` lookup | `getModelContext()` | Earlier drafts attached `modelContext` to `navigator`. We check there first so we never shadow a native implementation |
| `Result` envelope `{success, data \| error}` | Every operation | Gives one error vocabulary across WebMCP, MCP and `invoke` |
| Confirmation flow (`requiresConfirmation`, `confirm: true`) | AgentBridge, ops | A human-in-the-loop step for destructive actions. The spec offers `consequentialHint`, which we also set |
| Progressive disclosure (`explore`, `search`, `describe_tool`, `invoke`, `load_tools`) | Meta ops | Keeps the tool list small. `describe_tool` returns `inputSchema` and `outputSchema` |
| Role-based visibility | AgentBridge, MCP adapter | Each user's role decides which tools are registered |
| Agent-operable UI components (`ui_list`, `ui_get_state`, `ui_set_state`, `ui_action`) | `lib/ui-components/`, `lib/ui-relay/`, `docs/ui-components.md` | Lets agents change what the user sees (filters, sort, tabs) through typed component state instead of the DOM. In the page, the four tools run against the live component registry (`runsInPage`) and never call `/api/call`. MCP clients reach the user's open tab through a server relay (1.3.0) |

## MCP side (for comparison, spec 2025-11-25)

| Rule | Status |
|---|---|
| `outputSchema` is an object schema | ✅ Every op has one |
| Server returns `structuredContent` that conforms when an `outputSchema` is declared | ✅ Enforced by `tests/unit/output-contract.test.ts`. The SDK also rejects mismatches at runtime |
| The serialized JSON is also returned in a text block | ✅ Kept for older clients and `scripts/bench.mjs` |
| Tool execution errors are reported with `isError: true` | ✅ Always as the `ProtocolError` object (`{code, message, retryable, details?, hint?, suggestions?, requestId?, callId?}`) |
| Annotations | ✅ `readOnlyHint`, `destructiveHint`, `title`. We don't claim `idempotentHint` or `openWorldHint` |

## Keeping this page current

- When the spec changes, update the date at the top and re-check each row.
- When we close a gap, change its status here and add a line to the next `CHANGELOG.md`
  entry.
