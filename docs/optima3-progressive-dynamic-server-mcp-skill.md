---
name: optima3-progressive-mcp
description: Implementation guide for adding "progressive tool disclosure via a navigable module tree" to the Silverbyte.Optima3 MCP server (.NET 8 DMZ + React WebShell). Hand this to the developer who owns the task.
owner: TBD (assign the DMZ / Optima3 backend owner)
target-repo: C:\git\Silverbyte.Optima.Cloud
status: ready-to-implement
---

# Skill: Progressive Tool Disclosure for the Optima3 MCP Server

> **Audience:** the developer implementing this on `Silverbyte.Optima.Cloud`.
> **Reference implementation:** a fully working & QA-verified TypeScript/Next.js prototype exists in the
> `webmcp` project (107/107 tests passing). This document ports that design onto the existing .NET MCP server.
> **Nothing in the Cloud repo has been changed** — this is the spec + task list to implement it.

---

## 1. Why we're doing this

Optima3 is large: the BFF (`Silverbyte.Optima3.Application`) has ~72 controllers, the PMS microservice ~74, so
the reachable business-operation surface is in the **hundreds**. Today the MCP server
(`Silverbyte.Optima3.DMZ`) advertises **every** tool statically (`WithToolsFromAssembly()`), unfiltered. If we
keep hand-adding tools, the agent's `tools/list` grows without bound and eventually blows the model's context
window — which defeats the point of MCP.

**Progressive tool disclosure** fixes this: expose a tiny fixed set of *navigation* tools at the root, let the
agent walk a **module tree** (platform → module → sub-module → functions), read concise descriptions, and pull
in only the functions it needs — for one workflow it can gather functions from *different branches* of the tree.

**Target scale:** designed for ~2500 operations without ever putting more than a handful of tools in `tools/list`.

---

## 2. What already exists in the repo (verified — build on this, don't rebuild)

| Thing | Where | Notes |
|---|---|---|
| MCP server host | `Silverbyte.Optima3.DMZ` (SDK `Microsoft.NET.Sdk.Web`, **net8.0**) | Config-gated by `MCPServer:Enable` in `appsettings.dmz.json`. |
| Official C# SDK | `ModelContextProtocol` + `ModelContextProtocol.AspNetCore` **0.2.0-preview.1** | Transitive via `Silverbyte.Common.Net` **2.0.17268.1**. |
| Server wiring | `AddMcpServer` + `WithHttpTransport` + `MapMcp` **at `/mcp`** | Lives in the compiled `Silverbyte.Common.Net` `CommonStartup`. Also an `/mcp-tools` HTML explorer. |
| Tool registration hook | `Silverbyte.Optima3.DMZ/Startup.cs` → `RegisterTools(IMcpServerBuilder)` | Calls `WithToolsFromAssembly()` / `WithResourcesFromAssembly()` / `WithPromptsFromAssembly()`. |
| Existing tools (4) | `MCP/GuestsTool.cs`, `MCP/ReservationsTool.cs`, `MCP/RoomTypesTool.cs` | `CRM_GetGuests`, `PMS_GetReservations`, `PMS_GetReservationStatuses`, `PMS_GetRoomTypes`. Attribute pattern: `[McpServerToolType]` class + `[McpServerTool(Name=...)]` + `[Description]` methods, params `[Description]`. |
| Auth / token flow | `MCP/BaseTool.cs` | Reads `Authorization` bearer via `IHttpContextAccessor`, forwards it onto every NSwag `*APIClient.Token` (PMS/CRM/ORG/SHR/FIN/BI). Downstream module APIs validate the JWT. **No role/module filtering at the MCP layer today.** |
| In-app AI assistant | `src/components/Optimon/optimon.jsx` → SignalR `/optimonHub` | Backend `Hubs/OptimonHub.cs`, `Controllers/SHR/OptimonController.cs`, uses `OpenAI` 2.2.0. |
| React frontend | `Silverbyte.Optima2.React` (Vite 6, **JS UMD bundle** `OptimaUI`) | Mounted by `Optima2.WebShell` MVC host. Fetch wrapper `src/api/http.js` (JWT header). Existing `src/api/services/agent.js`. Cross-app bus `window.optima.commands`. |

**Key insight:** the token-per-request pattern already used by `BaseTool` (via `IHttpContextAccessor`) is exactly
the request context we need — no `AsyncLocal` gymnastics required (the TS prototype needed `AsyncLocalStorage`;
.NET gives us `HttpContext` for free).

---

## 3. Locked design decisions (agreed with the product owner)

1. **Topology = hybrid.** Server-side MCP (DMZ `/mcp`) for external agents **and** browser tools for the in-app
   Optimon agent, sharing **one backend operation catalog**.
2. **Catalog population = hybrid (curated + generated).** Auto-generate the bulk by reflecting over the NSwag
   `*APIClient` method signatures; hand-curate high-value modules with better titles/descriptions/confirmation
   flags. Start small, grow coverage over time.
3. **Browser tools = proxy to backend catalog.** The React side registers the same navigation tools; they call
   the DMZ endpoint (or a thin REST shim). Single source of truth; no duplicated schemas in JS.
4. **Primary execution path = `Invoke` (stateless dispatcher).** Matches the DMZ stateless HTTP transport.
   `load_tools`/`unload_tools` (native tool promotion) is a **later phase** — it's hard here (see §7).

---

## 4. Architecture at a glance

```
External agent ─┐
                ├─► DMZ /mcp  ──►  NavigationTool (Explore / DescribeTool / Invoke)
Optimon (in-app)┘                        │
                                         ▼
                                 IOperationCatalog  ◄── ClientCatalogBuilder (reflect NSwag *APIClients)
                                 (name-indexed)     ◄── CuratedCatalog (hand-written, takes precedence)
                                         │
                                         ▼
                                 ModuleTree (dot-path hierarchy, role-filtered)
                                         │
                                         ▼   descriptor.Invoke(args, ctx)
                                 token-scoped *APIClient  ──►  PMS/CRM/ORG/SHR/FIN/BI microservices
```

Only 3 (+2 stub) tools are ever in `tools/list`. Everything else is reached through them.

---

## 5. Task breakdown (implementation checklist)

> All backend files live under `Silverbyte.Optima3.DMZ/MCP/`.

### Phase A — Catalog core
- [ ] **A1.** `MCP/Catalog/OperationDescriptor.cs` — record:
      `{ string Name; string Title; string Description; string Module; string Permission /*read|write*/;
      string[] Roles; bool ParallelSafe; bool RequiresConfirmation; JsonElement InputSchema;
      Func<JsonElement, OperationContext, CancellationToken, Task<object>> Invoke }`.
      `ParallelSafe` defaults to `Permission == "read"` when unset.
- [ ] **A2.** `MCP/OperationContext.cs` — `{ string Role; string Token; HttpContext Http }`, built from
      `IHttpContextAccessor` (same source `BaseTool` already uses).
- [ ] **A3.** `MCP/Result.cs` — `Result.Ok(data)` → `{ success:true, data }`,
      `Result.Fail(code, message)` → `{ success:false, error:{ code, message } }`.
      **Business errors go in the body with a successful tool status** (verified convention from the TS QA pass —
      do NOT surface them as MCP transport errors).
- [ ] **A4.** `MCP/Catalog/IOperationCatalog.cs` (+ impl) — holds `IReadOnlyList<OperationDescriptor>` plus a
      `Dictionary<string,OperationDescriptor>` name index for O(1) lookup. Registered as a **singleton** in DI.

### Phase B — Populate the catalog
- [ ] **B1.** `MCP/Catalog/ClientCatalogBuilder.cs` — reflect over each `*APIClient` type (PMS/CRM/ORG/SHR/FIN/BI):
      - enumerate public `*Async` methods,
      - `Name = "{MODULE}_{Method}"`, `Module = e.g. "pms.reservation"` (client → top module; method-name
        heuristic → sub-module),
      - `Permission`: `Get*/Search*/List*` → `read`, else `write`,
      - `InputSchema` from parameter types (use the SDK's schema generator, or `System.Text.Json`
        `JsonSchemaExporter`),
      - `Invoke`: bind `JsonElement` args → method params via reflection, call on a **token-scoped** client.
      Start with methods that take primitive/simple filter params; skip noisy complex-DTO methods for v1.
- [ ] **B2.** `MCP/Catalog/CuratedCatalog.cs` — port the existing 4 tools into curated `OperationDescriptor`s
      (better copy, set `RequiresConfirmation` on destructive ops). Curated entries **override** generated ones
      of the same name.

### Phase C — Module tree (port of TS `lib/modules.ts`)
- [ ] **C1.** `MCP/Catalog/ModuleTree.cs`:
      - `ModuleNode { Path, Title, Description }` — flat list, dot-paths (`pms.reservation.booking`).
      - `IsChildOf`, `DirectChildrenOf`, `TopLevelModules` (string-prefix logic).
      - `GetNode(path, role)` → `{ Path, Title, Description, Submodules[], Functions[] }`, role-filtered.
      - `ExpandWildcard(pattern, role)` → handles `"x.*"` and `"*"`.
      - `PlatformManifest(role)` → top-level modules with ≥1 visible function in subtree.
      - `FnSummary { Name, Title, Description, Permission, ParallelSafe, RequiresConfirmation }` (no schema).

### Phase D — Navigation tools
- [ ] **D1.** `MCP/NavigationTool.cs` (`[McpServerToolType]`, extends `BaseTool`) with:
      - **`Explore`** `{ path?: string | string[] }` — no path → manifest; path(s) → `GetNode` (bulk);
        `"x.*"`/`"*"` → `ExpandWildcard`.
      - **`DescribeTool`** `{ name: string | string[] }` — full input schema(s) + metadata; role-checked;
        unknown/forbidden reported per-name.
      - **`Invoke`** `{ name, args }` **or** `{ calls:[{name,args,parallelSafe?}] }` — look up descriptor,
        enforce role, validate args against `InputSchema`, run `descriptor.Invoke`. Bulk: partition by
        `ParallelSafe` → run safe ones with `Task.WhenAll`, the rest sequentially in order; per-call envelope;
        batch never throws wholesale.
      - **`LoadTools` / `UnloadTools`** — **stub** returning "not yet supported, use Invoke" (or omit for v1).
- [ ] **D2.** `MCP/Rbac.cs` — `Role` from `HttpContext.User` claims; `RoleSatisfies(userRole, allowed[])` with a
      hierarchical rank map. **Confirm the exact claim name/values in the Optima JWT before wiring this.**
      `Invoke` re-checks role per call (defense in depth).

### Phase E — Wiring
- [ ] **E1.** `Silverbyte.Optima3.DMZ/Startup.cs`:
      - `ConfigureServices`: register `IOperationCatalog` singleton (built from clients + curated) + builders.
        Keep the `MCPServer:Enable` gate.
      - `RegisterTools`: keep `WithToolsFromAssembly()` (now picks up `NavigationTool`). Remove `[McpServerTool]`
        from the 3 existing business tools so only navigation tools are advertised — their logic stays reachable
        via `Invoke` through the catalog.

### Phase F — Frontend / Optimon (proxy to backend catalog)
- [ ] **F1.** `Silverbyte.Optima2.React/src/api/services/agent.js` — add `explore(path)`, `describeTool(name)`,
      `invoke(name, args)` hitting the DMZ MCP endpoint (or a thin `/api/next/mcp/*` BFF shim that forwards to
      DMZ `/mcp`). Reuse `src/api/http.js` (gets the `JWT` header + base URL for free).
- [ ] **F2.** `Controllers/SHR/OptimonController.cs` + `Hubs/OptimonHub.cs` — feed the **same catalog** to
      Optimon's OpenAI tool-calling loop (in-process, since the backend already holds the catalog).
      No UMD/`componentMap.js` change needed for the proxy path.

---

## 6. Verification (definition of done)

1. **Build:** `dotnet build Silverbyte.Optima3.DMZ` (net8.0); run DMZ with `MCPServer:Enable=true`.
2. **Small root list:** connect `@modelcontextprotocol/inspector` to `http://localhost:54000/mcp`
   (see `MCP/.inspector.md`) with a valid bearer → `tools/list` shows only `Explore/DescribeTool/Invoke`
   (+ stubs), **not** hundreds of business tools.
3. **Navigation:** `Explore {}` → platform + top modules; `Explore {path:"pms.reservation"}` → submodules;
   leaf → functions; bulk `path:[...]`; wildcard `pms.*`.
4. **DescribeTool:** full input schema for a generated op (e.g. `PMS_GetReservations`).
5. **Invoke:** single + bulk (parallel-safe reads via `Task.WhenAll`); JWT forwarded to the module client; real
   data returns.
6. **RBAC:** low-privilege token sees a filtered tree; forbidden `Invoke` → `FORBIDDEN`; bad args →
   `INVALID_ARGS` (only that call in a bulk).
7. **Optimon end-to-end:** ask the in-app assistant something that requires navigate + invoke; it resolves via
   the shared catalog.
8. **Regression:** the 4 original tools' logic still reachable via `Invoke`.

---

## 7. Risks & known limits

- **`load_tools` (native tool promotion) is hard here.** The C# SDK advertises assembly-scanned tools and the
  DMZ transport is stateless HTTP — there's no per-token dynamic tool list like the TS `mcp-handler` gave us.
  That's why `Invoke` is primary. Native promotion later requires stateful MCP sessions
  (`HttpServerTransportOptions.Stateless = false`) + a per-session dynamic `McpServerTool` collection — a change
  in the shared `Silverbyte.Common.Net` wiring, not just DMZ.
- **Reflection-generated schemas** from NSwag clients can be noisy for complex DTO params — curate high-traffic
  modules; prefer simple-param methods first.
- **Role claims:** the repo resolves identity from `ClaimsPrincipal`, not a typed current-user service — confirm
  claim name/values before wiring `RoleSatisfies`.
- **Two consumers, one catalog:** confirm external agents hit DMZ `/mcp` and Optimon runs in-process against the
  same DI-registered catalog.

---

## 8. Later phases (documented, not in scope now)

- `load_tools`/`unload_tools` native promotion (needs stateful MCP sessions).
- True browser WebMCP surface (`navigator.modelContext` / `window.agent`) + browser-native UI-action tools on
  the `window.optima` bus.
- Intent-based auto-router tool over the tree.
- Mirror the tree as MCP resources for resource-browsing clients.
- Expand generated-catalog coverage module-by-module with curation.

---

## 9. Concept → code mapping (TS prototype → .NET)

| TS prototype (`webmcp`) | .NET port (`Silverbyte.Optima3.DMZ`) |
|---|---|
| `lib/operations/types.ts` `Operation` | `MCP/Catalog/OperationDescriptor.cs` |
| `lib/operations/registry.ts` array | `IOperationCatalog` singleton |
| `lib/modules.ts` (tree + helpers) | `MCP/Catalog/ModuleTree.cs` |
| `explore` / `describe_tool` / `invoke` ops | `MCP/NavigationTool.cs` methods |
| `lib/result.ts` envelope | `MCP/Result.cs` |
| `lib/auth.ts` `roleSatisfies` | `MCP/Rbac.cs` |
| `AsyncLocalStorage<{role,token}>` | `IHttpContextAccessor` → `OperationContext` |
| per-token `__loadedToolsStore` | *(deferred — later phase)* |
| `zod` arg validation | `InputSchema` (JSON Schema) validation in `Invoke` |
