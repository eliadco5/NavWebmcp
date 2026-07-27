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
