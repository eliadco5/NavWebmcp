# Protocol changelog

Versions the **NavWebMcp wire protocol** (`PROTOCOL_VERSION` in `lib/protocol.ts`).
Not the app version (`package.json`) — the two are deliberately independent.

## When to bump

The protocol surface is: the capability manifest shape (`lib/capabilities.ts`), the
8 always-on meta-op names and input schemas, the `Result` envelope (`lib/result.ts`),
and the error-code vocabulary.

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
