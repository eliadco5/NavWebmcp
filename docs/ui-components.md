# Agent-operable UI components (NavWebMcp 1.3.0)

> This is the normative spec. For a step-by-step build guide for other applications,
> framework-agnostic code, and a worked example with real responses, see the
> [README section](../README.md#agent-operable-ui-components-navwebmcp-13).

## Why

NavWebMcp operations are **business** calls. For example, `searchTasks({ status: "open" })`
returns data **to the agent**. Nothing on screen changes: the user's Tasks filter still says
"Any status". That is right when the agent needs the data for itself. It is wrong when the
user asked to *see* something ("show me the open housekeeping tasks, highest priority
first").

Driving the DOM (clicking selects, typing into inputs) would break PRD goal G1, *agents
complete tasks without inspecting DOM structure*. So components publish a **typed state
contract** instead, and agents change that state. The component applies the change through
its own state setter, exactly as if the user had used its controls.

| | Operation | UI component |
|---|---|---|
| Lives | Server, static registry | Browser, only while mounted |
| Changes | Business data | What the user sees |
| Discovered by | `explore`, `getCapabilities` (`capabilityHash`) | `ui_list` (each contract has its own `version`) |
| Confirmation | `requiresConfirmation` on destructive ops | Never. View-only |
| Use it when | **You** (the agent) need the data or want to change records | The **user** should see the result |

After a `ui_set_state`, the component refetches through its normal business operation, so
RBAC and audit apply to the data exactly as they do for the user's own clicks.

## The contract

Every mounted component publishes this (see `UiComponentContractSchema` in
`lib/ui-components/contract.ts`):

```jsonc
{
  "id": "tasks.table",            // stable, page-unique
  "kind": "table",                // standard kind → standard state shape
  "title": "Task Search",
  "description": "…",
  "stateSchema": { /* JSON Schema of the full state */ },
  "state": { "filters": { "status": "open" }, "sort": [] },
  "version": 7,                   // bumped on every change, by the user or an agent
  "actions": [{ "name": "reset", "description": "…" }, { "name": "refresh", "description": "…" }],
  "view": { "total": 4, "shown": 4 }
}
```

### Kinds

Kinds fix the overall shape of `state`, so an agent learns each shape once. The builders are
in `lib/ui-components/kinds.ts`.

| Kind | State | Notes |
|---|---|---|
| `table` | `{ filters: {…}, sort: [{ column, direction: "asc"\|"desc" }] }` | `filters` holds the table's own fields, all optional (absent = "any"). `sort` lists keys in priority order. Each table caps its own length (`maxItems` in `stateSchema`). `[]` means the default order. Pagination is reserved for a later minor version |
| `tabs` | `{ activeTab }` | `app.nav` is the app's tab bar. Its enum lists only the tabs the user's role can see |

Every component that declares an initial state also gets a `reset` action.

## Operations (always-on)

| Op | Input | Success data |
|---|---|---|
| `ui_list` | `kind?`, `tabId?` | `{ tabId, activeTab, openTabs, components: [contract] }` |
| `ui_get_state` | `componentId`, `tabId?` | `{ componentId, kind, state, version, view? }` |
| `ui_set_state` | `componentId`, `patch`, `expectedVersion?`, `tabId?` | `{ componentId, state, version }` |
| `ui_action` | `componentId`, `action`, `args?`, `tabId?` | `{ componentId, action, state, version }` |

**Patch semantics.** The patch is merged into the current state:

- plain objects merge recursively;
- arrays and scalars replace;
- `null` removes a key, which is how you clear a filter.

The *merged* state must then validate against `stateSchema`. If it doesn't, the whole patch
is rejected with `UI_INVALID_PATCH` and nothing changes.

```jsonc
// Show open tasks, highest priority first
ui_set_state({ "componentId": "tasks.table",
  "patch": { "filters": { "status": "open" }, "sort": [{ "column": "priority", "direction": "desc" }] } })
// Clear the status filter only
ui_set_state({ "componentId": "tasks.table", "patch": { "filters": { "status": null } } })
```

**Navigation.** A component exists only while its tab is mounted. To reach one on another
tab:

1. Call `ui_set_state({ componentId: "app.nav", patch: { activeTab: "tasks" } })`.
2. Call `ui_list` again.

**Concurrency.** The user can change a component while an agent is working on it. Pass the
`version` you read as `expectedVersion`. If the user changed it since, you get
`UI_STALE_STATE` and nothing is applied.

**Annotations.**
- `ui_list` and `ui_get_state` are read-only.
- `ui_set_state` and `ui_action` have `permission: "write"`, because they change what the user
  sees. They are **not** consequential or destructive, and they never require confirmation.

### Error codes

| Code | Meaning | React by |
|---|---|---|
| `UI_COMPONENT_NOT_FOUND` | No mounted component with that id. The message lists the mounted ids | Switch tabs via `app.nav`, then `ui_list` |
| `UI_INVALID_PATCH` | The merged state doesn't match `stateSchema` | Fix the patch using `stateSchema`, then retry once |
| `UI_STALE_STATE` | `expectedVersion` is out of date | `ui_get_state`, then decide again |
| `UI_UNKNOWN_ACTION` | The component has no such action | Use an action listed by `ui_list` |
| `UI_NO_ACTIVE_PAGE` | The user has no open app tab (MCP clients only) | Ask the user to open the app |
| `UI_TIMEOUT` | The tab didn't answer within about 8s | `ui_get_state` to see whether it applied |

## Two reach paths, one implementation

```
in-page agent ──modelContext.executeTool("ui_set_state")──▶ AgentBridge.call
                                                              │  (auth, RBAC, strict parse, audit)
                                                              ▼
                                                   lib/ui-components/local.ts
                                                              │
MCP client ──ui_set_state──▶ server op (lib/operations/ui.ts) │
       │                       │ enqueue to the user's tab     │
       │                       ▼                               ▼
       │               lib/ui-relay/store.ts ◀──POST /api/ui/relay── page (lib/ui-relay/client.ts)
       │                       │  result                       │
       ◀───────────────────────┘                               ▼
                                              UiComponentRegistry.applyCommand  ← single choke point
                                                              ▼
                                               component setState → re-render → refetch
```

**In-page.** `lib/adapters/webmcp.ts` routes the ops marked `runsInPage` to the page's own
`UiComponentRegistry`, with no server round trip.

**Relay (MCP).** The external client has no tab of its own, so the server relays to the
caller's own tabs.

- **Snapshots.** Each signed-in tab publishes a snapshot of its mounted components
  (`POST /api/ui/snapshot`): on every change, on focus, and as a 10s heartbeat.
  - A snapshot is live for 30s.
  - Closing the tab removes it with `sendBeacon`.
- **Reads.** `ui_list` and `ui_get_state` read the snapshot.
- **Writes.** `ui_set_state` and `ui_action` enqueue a command for the target tab, then wait
  up to 8s for the result.
  - The target is the given `tabId`. Without one, it is the visible tab the user focused
    most recently.
  - The page polls `POST /api/ui/relay`: every 1s while visible, every 5s when hidden.
  - The page applies each command through the same `applyCommand` and hands back the result
    on the next request.
- **Storage.** In-process memory by default. When `REDIS_URL` is set, Redis is used, so the
  enqueuing instance and the polling instance can differ.

## Security

- **Same user only.** Snapshots, queues and results are keyed by `userId`.
  - The MCP bearer token and the page's session cookie must resolve to the same user.
  - A page can only answer commands addressed to its own user.
- **View state only.** The contract carries view state, not business data. Rows never travel
  through the relay. The page refetches them through RBAC-checked operations.
- **Role-limited navigation.** `app.nav`'s enum is limited to the role's visible tabs, so an
  agent can't navigate anywhere the user couldn't.
- **Validated in the page.** Patches are validated against the component's Zod schema there.
  The server only relays them, and bounds their size.

## Versioning

- Adding the four ops and the `UI_*` error codes is MINOR (1.3.0).
- `capabilityHash` changed once, when the ops were added. Mounting or unmounting components
  doesn't touch it.
- A new **kind**, or a new optional field in a kind's shape, is MINOR.
- Changing an existing kind's shape is MAJOR.
- A component's own filter fields are not part of the protocol. They're discovered through
  `stateSchema`, the same way a business op's fields are discovered through `describe_tool`.

## Making a component agent-operable

```tsx
const SCHEMA = tableStateSchema(
  { status: z.enum(STATUSES).optional().describe("Task status") },
  ["createdAt", "priority"] as const,
);
const INITIAL = { filters: {}, sort: [] };

const [table, setTable] = useState(INITIAL);   // one state object, read by your fetch
useAgentComponent({
  id: "tasks.table", kind: "table", title: "Task Search",
  schema: SCHEMA, state: table, setState: setTable, initialState: INITIAL,
  view: { total: rows.length, shown: rows.length },
});
```

Rules:

1. Lift every agent-operable control into **one** state object. The user's controls and the
   agent both write to it.
2. Keep `schema` referentially stable: module-level, or `useMemo`. Re-registration is keyed
   on `id` + `schema`.
3. Filter fields mirror the backing operation's input, so the agent can set anything the
   user could, and nothing more.
4. Give every field a `.describe()`. That text is what the agent reads.

The reference implementations are `components/TaskSearchCard.tsx` (`tasks.table`) and
`components/AppShell.tsx` (`app.nav`).
