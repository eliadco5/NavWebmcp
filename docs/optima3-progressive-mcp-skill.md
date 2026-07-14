---
name: optima3-progressive-mcp
description: Implementation guide for exposing Optima3's UI-backing business functions to an external automation agent through a single stateless MCP URL, using progressive tool disclosure via a navigable module tree. Hand this to the developer who owns the task.
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

## 1. The core idea (read this first — it drives every decision)

We want an **external automation agent** (not a human, not a browser) to drive Optima **through one URL**, using
**exactly the same business functions the UI uses**. When a user clicks "Create reservation," the React app calls
a function that POSTs to a **BFF controller action** which holds the real orchestration/validation. We expose
**those BFF actions** as agent-callable tools. The agent gets the same capability a clicking user has — reached
through the MCP URL instead of the DOM.

This is the "WebMCP-style" idea the owner described, mapped onto Optima's real architecture:

- **No browser, no page, no navigation, no mounted component.** Everything happens over the URL, statelessly —
  the same breakthrough as the reference booking project.
- **The unit of exposure is the function behind the UI action** (the BFF controller action), **not** a thin raw
  data wrapper over a microservice. That's where the orchestration lives (verified: e.g.
  `ReservationController.Search` does a cross-service guest lookup before querying PMS).
- **Progressive disclosure** keeps it scalable: only 3 navigation tools are ever advertised; the agent walks a
  module tree and pulls in function schemas on demand, so hundreds/thousands of UI actions never flood its
  context window.

### What this is NOT (corrections to earlier drafts)
- ❌ NOT registering tools in the browser via `navigator.modelContext` / `window.optima`. The consumer is an
  external agent over HTTP; there's no page open.
- ❌ NOT reflecting over the raw PMS/CRM `*APIClient` microservice methods. Those are thin data clients and miss
  the BFF-level orchestration the UI actually relies on.
- ✅ Expose **BFF controller actions** (`Silverbyte.Optima3.Application`) — the same endpoints the React fetch
  services in `src/api/services/*.js` call.

---

## 2. Why we're doing this

The BFF (`Silverbyte.Optima3.Application`) has ~72 controllers, each with several actions — the UI-facing
operation surface is in the **hundreds**, heading toward ~2,500 as coverage grows. Today the MCP server
(`Silverbyte.Optima3.DMZ`) advertises **every** tool statically (`WithToolsFromAssembly()`), unfiltered. Hand-
adding a tool per action would blow the agent's `tools/list` and its context window. Progressive disclosure fixes
that: a tiny fixed navigation surface + on-demand discovery of the module tree.

---

## 3. What already exists in the repo (verified — build on this, don't rebuild)

| Thing | Where | Notes |
|---|---|---|
| MCP server host | `Silverbyte.Optima3.DMZ` (SDK `Microsoft.NET.Sdk.Web`, **net8.0**) | Config-gated by `MCPServer:Enable` in `appsettings.dmz.json`. Endpoint `/mcp`. |
| Official C# SDK | `ModelContextProtocol` + `ModelContextProtocol.AspNetCore` **0.2.0-preview.1** | Transitive via `Silverbyte.Common.Net` **2.0.17268.1**. `AddMcpServer`+`WithHttpTransport`+`MapMcp` live in the compiled `CommonStartup`. |
| Tool registration hook | `Silverbyte.Optima3.DMZ/Startup.cs` → `RegisterTools(IMcpServerBuilder)` | Calls `WithToolsFromAssembly()` etc. |
| Existing tools (4) | `MCP/GuestsTool.cs`, `MCP/ReservationsTool.cs`, `MCP/RoomTypesTool.cs` | Attribute pattern: `[McpServerToolType]` class + `[McpServerTool(Name=...)]` + `[Description]` methods. |
| DMZ auth / token flow | `MCP/BaseTool.cs` | Reads `Authorization` bearer via `IHttpContextAccessor`, forwards onto downstream `*APIClient.Token`. |
| **BFF controllers (the target)** | `Silverbyte.Optima3.Application/Controllers/**` | `BaseApplicationController`: `[Route("api/[controller]/[action]")]`, `[ApiController]`, `[Authorize]`, `TokenActionFilter` forwards the JWT to all module clients. **Real orchestration lives here.** ~72 controllers. |
| BFF routing | action-based | e.g. `POST api/Reservation/Search`, `GET api/Reservation/GetReservation/{id}`. Verbs vary per action. |
| React → BFF calls | `src/api/services/*.js` via `src/api/http.js` | The UI functions are thin fetch wrappers over these BFF actions (JWT sent as header). This is the proof that BFF actions == "functions the UI uses." |

**Dependency-direction wrinkle (important):** today `Silverbyte.Optima3.Application` references a **`DMZAPIClient`**
(BFF → DMZ). DMZ does **not** reference the BFF. So "MCP in DMZ forwards to the BFF" must be a **reverse HTTP
call** through a generated `Silverbyte.Optima3.Application.Client` (NSwag, like the other module clients) or a raw
`HttpClient` to the BFF base URL — **never** a project reference from DMZ → Application (that creates a cycle).

---

## 4. Locked design decisions (agreed with the product owner)

1. **Consumer = external automation agent over one URL.** No browser, no in-page agent, no browser-to-external
   bridge. Stateless HTTP, exactly like the reference booking project.
2. **Catalog source = BFF controller actions** (`Silverbyte.Optima3.Application`) — the functions the UI uses.
3. **MCP host = stays in DMZ; `invoke` forwards to the BFF over HTTP** (reverse call via an
   `Application.Client` / `HttpClient`). Reuses the existing `/mcp` wiring; adds one network hop.
4. **No navigation / no mounting.** A function is invocable purely by hitting the URL — the whole point of the
   protocol. Availability does not depend on any UI screen being open.
5. **Primary execution path = `Invoke` (stateless dispatcher).** `load_tools`/`unload_tools` (native tool
   promotion) is a **later phase** — hard on the current stack (see §8).
6. **Catalog population = hybrid (generated + curated).** Auto-generate the bulk from the BFF action surface,
   hand-curate high-value actions (titles/descriptions/confirmation flags). Start small, grow coverage.

---

## 5. Architecture at a glance

```
External automation agent
        │  (one URL, stateless HTTP, Bearer JWT)
        ▼
   DMZ  /mcp   ──►  NavigationTool  (Explore · DescribeTool · Invoke)
                          │
                          ▼
                   IOperationCatalog  ◄── BffActionCatalogBuilder (reflect BFF actions / Application.Client)
                   (name-indexed)     ◄── CuratedCatalog (hand-written, wins on name clash)
                          │
                          ▼   descriptor.Invoke(args, ctx)
                   Application.Client / HttpClient  ──►  BFF action (api/{controller}/{action})
                                                              │  (holds orchestration; TokenActionFilter
                                                              ▼   forwards JWT downstream)
                                                    PMS / CRM / ORG / SHR / FIN / … microservices
```

Only 3 tools are ever in `tools/list`. The agent reaches every UI-backing function through them.

---

## 6. Task breakdown (implementation checklist)

> Backend MCP files live under `Silverbyte.Optima3.DMZ/MCP/`.

### Phase A — Reach the BFF from DMZ
- [ ] **A0.** Add a way for DMZ to call the BFF: generate `Silverbyte.Optima3.Application.Client` via NSwag
      (same pattern as the other `*.Client` projects) **or** use a raw `HttpClient` against
      `config["Services:Application"]`. Add the `Services:Application` base URL to `appsettings.dmz.json`.
      Do **not** add a DMZ → Application project reference.

### Phase B — Catalog core
- [ ] **B1.** `MCP/Catalog/OperationDescriptor.cs` — record:
      `{ string Name; string Title; string Description; string Module; string Permission /*read|write*/;
      string[] Roles; bool ParallelSafe; bool RequiresConfirmation; JsonElement InputSchema;
      Func<JsonElement, OperationContext, CancellationToken, Task<object>> Invoke }`.
      `ParallelSafe` defaults to `Permission == "read"` when unset.
- [ ] **B2.** `MCP/OperationContext.cs` — `{ string Role; string Token; HttpContext Http }`, built from
      `IHttpContextAccessor` (same source `BaseTool` already uses). The token is forwarded to the BFF call so the
      BFF's `TokenActionFilter` propagates it downstream.
- [ ] **B3.** `MCP/Result.cs` — `Result.Ok(data)` → `{ success:true, data }`,
      `Result.Fail(code, message)` → `{ success:false, error:{ code, message } }`.
      **Business errors go in the body with a successful tool status** (verified convention from the TS QA pass).
- [ ] **B4.** `MCP/Catalog/IOperationCatalog.cs` (+ impl) — `IReadOnlyList<OperationDescriptor>` + a
      `Dictionary<string,OperationDescriptor>` name index (O(1) lookup). Registered as a **singleton** in DI.

### Phase C — Populate the catalog from BFF actions
- [ ] **C1.** `MCP/Catalog/BffActionCatalogBuilder.cs` — build descriptors from the BFF action surface:
      - source: reflect over the generated `Application.Client` methods, OR reflect over the BFF controller
        types (`BaseApplicationController` subclasses) if the client isn't generated,
      - `Name = "{Controller}_{Action}"` (e.g. `Reservation_Search`), `Module` inferred from the controller's
        folder/namespace (`PMS`,`CRM`,`ORG`,`SHR`,`FIN`,`ETL`,`RPT`) + controller name → dot-path
        (`pms.reservation`),
      - `Permission`: `Get*/Search*/List*` or `[HttpGet]` → `read`, else `write`,
      - `InputSchema` from the action's parameter/DTO types,
      - `Invoke`: map JsonElement args → the action's request DTO and call the corresponding
        `Application.Client` method (or POST `api/{controller}/{action}`) with the caller's bearer token.
      Start with actions taking simple/primitive or single-DTO params; defer noisy signatures.
- [ ] **C2.** `MCP/Catalog/CuratedCatalog.cs` — hand-written descriptors for high-value actions (better copy,
      `RequiresConfirmation` on destructive ones like cancel). The existing 4 DMZ tools fold in here. Curated
      entries **override** generated ones of the same name.

### Phase D — Module tree (port of TS `lib/modules.ts`)
- [ ] **D1.** `MCP/Catalog/ModuleTree.cs`:
      - `ModuleNode { Path, Title, Description }` — flat list, dot-paths (`pms.reservation`); parent/child by prefix.
      - `IsChildOf`, `DirectChildrenOf`, `TopLevelModules`.
      - `GetNode(path, role)` → `{ Path, Title, Description, Submodules[], Functions[] }`, role-filtered.
      - `ExpandWildcard(pattern, role)` → `"x.*"` and `"*"`.
      - `PlatformManifest(role)` → top-level modules with ≥1 visible function in subtree.
      - `FnSummary { Name, Title, Description, Permission, ParallelSafe, RequiresConfirmation }` (no schema).

### Phase E — Navigation tools
- [ ] **E1.** `MCP/NavigationTool.cs` (`[McpServerToolType]`, extends `BaseTool`):
      - **`Explore`** `{ path?: string | string[] }` — no path → manifest; path(s) → `GetNode` (bulk);
        `"x.*"`/`"*"` → `ExpandWildcard`.
      - **`DescribeTool`** `{ name: string | string[] }` — full input schema(s) + metadata; role-checked;
        unknown/forbidden per-name.
      - **`Invoke`** `{ name, args }` **or** `{ calls:[{name,args,parallelSafe?}] }` — look up descriptor,
        enforce role, validate args against `InputSchema`, run `descriptor.Invoke` (which calls the BFF). Bulk:
        parallel-safe → `Task.WhenAll`, the rest sequentially in order; per-call envelope; batch never throws
        wholesale.
      - **`LoadTools` / `UnloadTools`** — **stub** returning "not yet supported, use Invoke" (or omit for v1).
- [ ] **E2.** `MCP/Rbac.cs` — `Role` from `HttpContext.User` claims; `RoleSatisfies(userRole, allowed[])` with a
      hierarchical rank map. **Confirm the exact claim name/values in the Optima JWT first.** `Invoke` re-checks
      role per call (defense in depth).

### Phase F — Wiring
- [ ] **F1.** `Silverbyte.Optima3.DMZ/Startup.cs`:
      - `ConfigureServices`: register `IOperationCatalog` singleton (built from BFF actions + curated) + the
        `Application.Client`/`HttpClient`. Keep the `MCPServer:Enable` gate.
      - `RegisterTools`: keep `WithToolsFromAssembly()` (now picks up `NavigationTool`). Remove `[McpServerTool]`
        from the 3 existing business tools so only navigation tools are advertised; their logic stays reachable
        via `Invoke` (as curated catalog entries).

---

## 7. Verification (definition of done)

1. **Build:** `dotnet build Silverbyte.Optima3.DMZ` (net8.0); run DMZ with `MCPServer:Enable=true` and
   `Services:Application` pointing at the BFF.
2. **Small root list:** connect `@modelcontextprotocol/inspector` to `http://localhost:54000/mcp`
   (see `MCP/.inspector.md`) with a valid bearer → `tools/list` shows only `Explore/DescribeTool/Invoke`.
3. **Navigation:** `Explore {}` → platform + top modules; `Explore {path:"pms.reservation"}` → functions;
   bulk `path:[...]`; wildcard `pms.*`.
4. **DescribeTool:** full input schema for a BFF-backed action (e.g. `Reservation_Search`).
5. **Invoke:** single + bulk (parallel reads via `Task.WhenAll`). Confirm the call reaches the **BFF action**
   (orchestration runs — e.g. `Reservation_Search` free-text does the guest lookup) and the JWT is forwarded
   downstream.
6. **RBAC:** low-privilege token sees a filtered tree; forbidden `Invoke` → `FORBIDDEN`; bad args →
   `INVALID_ARGS` (only that call in a bulk).
7. **Parity with the UI:** pick a real button (e.g. Create reservation), find the BFF action its React service
   calls, and confirm the agent invoking the same action via `/mcp` produces the same result.
8. **Regression:** the 4 original DMZ tools' behavior still reachable via `Invoke`.

---

## 8. Risks & known limits

- **Reverse dependency DMZ → BFF:** must be an HTTP call (generated client or `HttpClient`), never a project
  reference (BFF already depends on DMZ; a reference back would cycle). One extra network hop per `invoke`.
- **`load_tools` (native tool promotion) is hard here.** The C# SDK advertises assembly-scanned tools over
  stateless HTTP — no per-token dynamic tool list like the TS `mcp-handler` gave us. That's why `Invoke` is
  primary. Native promotion later needs stateful sessions (`HttpServerTransportOptions.Stateless=false`) + a
  per-session dynamic tool collection — a change in shared `Silverbyte.Common.Net`, not just DMZ.
- **Schema noise:** some BFF actions take large composite DTOs — curate the high-traffic ones; auto-generate the
  simpler signatures first.
- **Role claims:** identity comes from `ClaimsPrincipal`, not a typed current-user service — confirm the claim
  name/values before wiring `RoleSatisfies`.
- **Write side-effects:** the agent triggers the same writes a user's button does — gate destructive actions
  with `RequiresConfirmation` in the curated catalog.

---

## 9. Later phases (documented, not in scope now)

- `load_tools`/`unload_tools` native tool promotion (needs stateful MCP sessions).
- Intent-based auto-router tool over the tree.
- Mirror the tree as MCP resources for resource-browsing clients.
- Expand generated-catalog coverage controller-by-controller with curation.
- (Optional, separate) a true in-browser WebMCP surface for the Optimon in-app assistant — explicitly out of
  scope here since the consumer is an external automation agent.

---

## 10. Concept → code mapping (TS prototype → .NET)

| TS prototype (webmcp) | .NET port (Silverbyte.Optima3.DMZ) |
|---|---|
| `lib/operations/types.ts · Operation` | `MCP/Catalog/OperationDescriptor.cs` |
| `lib/operations/registry.ts` | `IOperationCatalog` (singleton) |
| the operation `handler` (business logic) | **the BFF controller action** it forwards to |
| `lib/modules.ts` | `MCP/Catalog/ModuleTree.cs` |
| `explore` / `describe_tool` / `invoke` | `MCP/NavigationTool.cs` |
| `lib/result.ts` | `MCP/Result.cs` |
| `lib/auth.ts · roleSatisfies` | `MCP/Rbac.cs` |
| `AsyncLocalStorage<{role,token}>` | `IHttpContextAccessor` → `OperationContext` |
| `zod` arg validation | JSON-Schema validation in `Invoke` |
| `__loadedToolsStore` | deferred — later phase |
