# Operations reference

Every operation in the registry (73 at protocol 2.6.0: 8 navigation, 4 `ui_*` and 61 business operations), the module tree they live in, and how to call them from the browser console. How to discover and call them is in the [protocol guide](protocol.md); how to add one is in [development.md](development.md#adding-a-server-side-operation).

## In-page WebMCP (browser console)

After signing in, open the browser console:

```javascript
// List all available tools — every operation the signed-in role may call is registered
document.modelContext.getTools().map(t => t.name)
// → ["explore", "search", ..., "book", ...]   filtered by role

// Each tool carries an input schema, an output schema and annotations
const book = document.modelContext.getTools().find(t => t.name === "book")
book.outputSchema   // anyOf: { success: true, data: { reservation, validated } } | { success: false, error }
book.annotations    // { readOnlyHint: false, consequentialHint: false, untrustedContentHint: false }

// Protocol version and instructions declared on this surface
document.modelContext.protocolVersion   // "2.6.0"
document.modelContext.instructions      // the AGENT_INSTRUCTIONS string

// Call the composite book() tool
await document.modelContext.executeTool("book", {
  date: "2026-07-23",
  time: "18:00",
  partySize: 2,
  name: "Alice"
})
// → { success: true, data: { reservation: {...}, validated: true } }
```

Every operation is callable in-page the same way, including those whose screens don't use them yet.

`app/providers.tsx` registers the whole operation registry through `initAgentBridge` (`lib/adapters/webmcp.ts`) once the user is known. Each call goes to the server via `POST /api/call`, so it gets the same RBAC, strict input validation and audit log as the UI. `window.agentBridge.describe()` lists everything registered, with schemas.

The in-page `outputSchema` describes the full `Result` envelope, because that is what `execute()` returns. The data schema alone is in `describe_tool` and `agentBridge.describe()`. `executeTool` on the polyfill returns the raw object, not the JSON string the spec returns. That difference is deliberate; see [`docs/webmcp-alignment.md`](webmcp-alignment.md).

Cancellation and events follow the spec (protocol ≥ 1.2.0):

```javascript
// Lifecycle events, fired at document.modelContext with the tool's name
document.modelContext.addEventListener("toolactivated", (e) => console.log("started", e.toolName))
document.modelContext.addEventListener("toolcancel",    (e) => console.log("cancelled", e.toolName))

// Cancel a call: execute() gets its own AbortSignal, which AgentBridge passes to the server request
const ctrl = new AbortController()
const pending = document.modelContext.executeTool("listReservations", {}, { signal: ctrl.signal })
ctrl.abort("user stopped")   // pending rejects with "user stopped"; toolcancel fires; any late result is ignored

// Tool names are unique: registering a second "book" rejects with InvalidStateError
```

If the caller cancels while a confirmation dialog is open, the operation is never sent to the server and returns `CANCELLED`.

## Operations catalogue

**Always-on (12): always in `tools/list`.** Eight navigation and meta operations:

| Name | Description |
|---|---|
| `explore` | Navigate the platform module tree by dot-path |
| `search` | Find functions/modules by Linux-style glob |
| `describe_tool` | Get full input and output schema for one or more named operations |
| `invoke` | Call any operation directly, single or batch; batch calls can pass results along with `$ref` (≥ 2.2.0) |
| `load_tools` | Promote operations to native MCP tools for this session |
| `unload_tools` | Remove promoted tools from `tools/list` |
| `getContext` | The user and role, the platform clock (`now`, `today`, `timezone`), locale and, when metered, credits |
| `getCapabilities` | Role-scoped manifest: `protocolVersion`, `capabilityHash`, and each tool's permission, roles, confirmation, `idempotent` flag and credit cost |

And four that operate on-screen components (≥ 1.3.0; see the [UI components guide](ui-components-guide.md)):

| Name | Permission | Description |
|---|---|---|
| `ui_list` | read | The mounted components, with their state, `stateSchema` and actions |
| `ui_get_state` | read | One component's current state and row counts |
| `ui_set_state` | write | Patch a component's state (filters, sort, active tab) |
| `ui_action` | write | Run one of a component's actions (e.g. `reset`, `refresh`) |

**Business operations (61)**: discovered via `explore`/`search`, loaded via `load_tools` or called via `invoke`. Every `write` operation below also accepts an optional `idempotencyKey` (≥ 2.1.0) and is marked `idempotent: true` in `describe_tool` and `getCapabilities`.

### Reservation — `reservation.*`

| Name | Permission | Roles | Notes |
|---|---|---|---|
| `searchAvailability` | read | all | optional `time` (≥ 2.2.0) returns just that slot |
| `listReservations` | read | all | own reservations |
| `getReservation` | read | all | |
| `createReservation` | write | all | |
| `cancelReservation` | write ⚠️ | all | `requiresConfirmation` |
| `listAllReservations` | read | support, admin | cross-user |
| `cancelAnyReservation` | write ⚠️ | admin | `requiresConfirmation` |
| `book` | write | all | composite: availability + create + validate |

### CRM — `crm.*`

| Name | Permission | Roles |
|---|---|---|
| `searchGuests` | read | support, admin |
| `getGuest` | read | support, admin |
| `createGuest` | write | support, admin |
| `updateGuest` | write | support, admin |
| `getGuestPreferences` | read | all |
| `updateGuestPreferences` | write | all |
| `getLoyaltyStatus` | read | all |
| `addLoyaltyPoints` | write | support, admin |
| `listCommunications` | read | support, admin |
| `logCommunication` | write | support, admin |

### Front Office — `frontoffice.*`

| Name | Permission | Roles | Notes |
|---|---|---|---|
| `checkInGuest` | write | support, admin | |
| `getCheckinStatus` | read | support, admin | |
| `checkOutGuest` | write ⚠️ | support, admin | `requiresConfirmation` |
| `getBillSummary` | read | all | |
| `getOccupancy` | read | support, admin | |
| `getWaitTime` | read | all | |
| `listFrontDeskReservations` | read | support, admin | for choosing who to seat/check out |
| `listShiftNotes` | read | support, admin | |
| `addShiftNote` | write | support, admin | |
| `seatGuest` | write | support, admin | composite: occupancy + check-in + validate |
| `hostVipGuest` | write | support, admin | composite: preferences + loyalty + seat + award + log (spans CRM) |

### Tasks — `tasks.*`

| Name | Permission | Roles |
|---|---|---|
| `createTask` | write | support, admin |
| `updateTask` | write | support, admin |
| `searchTasks` | read | support, admin |
| `deleteTask` | write ⚠️ | admin |
| `getMyTasks` | read | all |
| `completeTask` | write | all |

### Housekeeping — `housekeeping.*`

| Name | Permission | Roles |
|---|---|---|
| `getTableCleaningStatus` | read | support, admin |
| `updateTableStatus` | write | support, admin |
| `getTodaySchedule` | read | support, admin |
| `markScheduleItemDone` | write | support, admin |
| `listInspections` | read | admin |
| `logInspection` | write | admin |

### Finance — `finance.*`

| Name | Permission | Roles | Notes |
|---|---|---|---|
| `getDailyRevenueSummary` | read | admin | |
| `getWeeklyRevenueSummary` | read | admin | |
| `getPaymentRecord` | read | admin | |
| `listPayments` | read | admin | |
| `issueRefund` | write ⚠️ | admin | `requiresConfirmation` |
| `applyNoShowFee` | write ⚠️ | admin | `requiresConfirmation` |
| `logManualAdjustment` | write | admin | |

### Support — `support.*`

| Name | Permission | Roles | Notes |
|---|---|---|---|
| `listBugReports` | read | admin | Reports filed from the in-app "Report a bug" inspector |
| `getBugReport` | read | admin | Full bundle: console/network logs, repro steps |
| `updateBugReportStatus` | write | admin | |

### Admin — `admin.*` (management layer)

| Name | Permission | Roles | Notes |
|---|---|---|---|
| `getEntityHistory` | read | admin | Full history of one record, and who created it (person or agent) |
| `queryAudit` | read | admin | Search the audit trail |
| `verifyAuditChain` | read | admin | Check the trail's hash chain |
| `getUsageMetrics` | read | admin | Usage, adoption, human vs agent split, latency vs SLO |
| `listUserSessions` | read | admin | Sign-in sessions and their status |
| `listAgentClients` | read | admin | Connected agents and their status |
| `revokeSession` | write ⚠️ | admin | `requiresConfirmation`; also disconnects the session's agents |
| `revokeAgentClient` | write ⚠️ | admin | `requiresConfirmation`; disconnects one agent |
| `getCreditLedgers` | read | admin | Every caller's credit balance, window, spend and refusals ([Credits](credits.md)) |
| `setClientCreditPolicy` | write ⚠️ | admin | `requiresConfirmation`; cap one caller's window or refill rate, freeze it, or reset it |

See [Management layer](management.md).

## Module tree

```
(platform root — AgentBridge Hospitality)
├── reservation              "Create and manage table reservations"
│     ├── reservation.availability   searchAvailability
│     ├── reservation.booking        createReservation, cancelReservation ⚠️, book
│     ├── reservation.search         listReservations, getReservation
│     └── reservation.admin          listAllReservations, cancelAnyReservation ⚠️
│     (composite book lives in reservation.booking)
├── crm                      "Guest profiles, preferences, loyalty, communications"
│     ├── crm.guests                 searchGuests, getGuest, createGuest, updateGuest
│     ├── crm.preferences            getGuestPreferences, updateGuestPreferences
│     ├── crm.loyalty                getLoyaltyStatus, addLoyaltyPoints
│     └── crm.communications         listCommunications, logCommunication
├── frontoffice              "Day-of operations — check-in/out, occupancy, shifts"
│     ├── frontoffice.checkin        checkInGuest, getCheckinStatus, listFrontDeskReservations
│     │   + composite: seatGuest, hostVipGuest (spans crm.*)
│     ├── frontoffice.checkout       checkOutGuest ⚠️, getBillSummary
│     ├── frontoffice.occupancy      getOccupancy, getWaitTime
│     └── frontoffice.shifts         listShiftNotes, addShiftNote
├── tasks                    "Operational task tracking across departments"
│     ├── tasks.management           createTask, updateTask, searchTasks, deleteTask ⚠️
│     └── tasks.assignments          getMyTasks, completeTask
├── housekeeping             "Venue cleanliness — status, schedules, inspections"
│     ├── housekeeping.status        getTableCleaningStatus, updateTableStatus
│     ├── housekeeping.schedule      getTodaySchedule, markScheduleItemDone
│     └── housekeeping.inspections   listInspections, logInspection
├── finance                  "Revenue, payments, refunds (admin only)"
│     ├── finance.revenue            getDailyRevenueSummary, getWeeklyRevenueSummary
│     ├── finance.payments           getPaymentRecord, listPayments
│     └── finance.adjustments        issueRefund ⚠️, applyNoShowFee ⚠️, logManualAdjustment
├── support                  "User bug reports (admin only)"
│     └── support.bugs               listBugReports, getBugReport, updateBugReportStatus
└── admin                    "Audit trail, usage metrics, sessions and agents (admin only)"
      ├── admin.audit                getEntityHistory, queryAudit, verifyAuditChain
      ├── admin.monitoring           getUsageMetrics
      └── admin.access               listUserSessions, listAgentClients, revokeSession ⚠️, revokeAgentClient ⚠️,
                                     getCreditLedgers, setClientCreditPolicy ⚠️
```

⚠️ = `requiresConfirmation: true` — a call without approval returns `CONFIRMATION_REQUIRED` with a preview and a token ([protocol § 7](protocol.md#confirmation-previews-and-tokens--260)); UI shows a dialog. The `ui_*` operations aren't in the tree: they're always on.

Parent/child relationships are inferred from dot-path prefixes; the tree is defined in `lib/modules.ts` and builds automatically.
