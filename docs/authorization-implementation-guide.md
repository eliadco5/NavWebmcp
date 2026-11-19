# Implementation guide: custom roles & per-user permissions

Audience: whoever on the team builds this. Companion reading, not a replacement for this
doc: `docs/auth-explained.html` (how auth works today, for onboarding) and
`docs/authorization-design.html` (flowchart + code sketch of the authorization decision,
today vs. planned). This doc is the "how to actually build it" spec — exact files, exact
Redis payload, exact merge algorithm.

Status: **design, not yet implemented.** Nothing in `lib/access/` exists yet.

---

## 1. Where `authorize()` lives

New file: **`lib/access/policy.ts`**. Client-safe — no `node:crypto`, no `node:*` import,
same constraint `lib/auth.ts` already has (`app/providers.tsx` is a client component and
imports the operation registry, which imports `Role`/`roleSatisfies` from `lib/auth.ts`
today; the replacement for that import chain must stay client-safe the same way).

```ts
// lib/access/policy.ts
import type { Operation } from "@/lib/operations/types";
import type { Failure } from "@/lib/result";
import { fail } from "@/lib/result";
import type { Principal } from "./types";

export function can(p: Principal, opName: string): boolean {
  return p.permissions.has(opName);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function authorize(
  p: Principal,
  op: Operation<any, any>,
  rawInput: Record<string, unknown>
): Failure | null {
  if (!can(p, op.name)) {
    return fail("FORBIDDEN", `Role '${p.roleId}' is not permitted to call '${op.name}'.`);
  }
  const restricted = p.restrictedFields.get(op.name);
  if (restricted) {
    for (const field of restricted) {
      if (rawInput[field] !== undefined) {
        return fail("FORBIDDEN_FIELD", `Not permitted to set '${field}' on '${op.name}'.`);
      }
    }
  }
  return null;
}
```

**Call it on the raw input, before `z.object(op.inputSchema).safeParse(...)`.** Zod silently
drops keys that aren't in the schema; checking after parsing would let a restricted field
slip through under a key Zod already stripped, and more importantly the *presence* check
needs to see exactly what the caller sent, not what Zod decided to keep.

`Principal` itself is resolved separately (§4) — `authorize()` takes an already-resolved
`Principal`, it doesn't do any lookup itself. That split matters for the MCP path
(`lib/adapters/mcp.ts`), which resolves the principal once per tool-list request and reuses
it across every tool in that list — don't make `authorize()` async or it forces an
await per operation in a loop that currently runs sync.

### Where it gets called

Same 8 places that call `roleSatisfies(role, op.roles)` today — swap the import, not the
call site's shape:

| File | Today | Becomes |
|---|---|---|
| `app/api/call/route.ts:33` | `roleSatisfies(user.role, op.roles)` | `authorize(principal, op, params ?? {})` |
| `lib/adapters/mcp.ts:57` (tool list filter) | `roleSatisfies(callerRole, op.roles)` | `can(principal, op.name)` |
| `lib/adapters/mcp.ts:92` (re-check on call) | `roleSatisfies(role, op.roles)` | `authorize(principal, op, input)` |
| `lib/operations/dispatch.ts:41` | `roleSatisfies(ctx.role, op.roles)` | `authorize(ctx.principal, op, args)` |
| `lib/operations/loadTools.ts:27` | `roleSatisfies(ctx.role, op.roles)` | `can(ctx.principal, op.name)` |
| `lib/operations/describeTool.ts:11` | `roleSatisfies(role, op.roles)` | `can(principal, op.name)` |
| `lib/capabilities.ts:39` | `roleSatisfies(role, op.roles)` | `can(principal, op.name)` |
| `lib/modules.ts:132,208,220,231` | `roleSatisfies(role, op.roles)` | `can(principal, op.name)` |
| `lib/agentbridge.ts:73,108` | `roleSatisfies(role, reg.roles)` | `can(principal, reg.name)` / `authorize(...)` |

Do these one file at a time and run `tests/integration/rbac.test.ts` after each — it's the
regression net for this whole migration.

---

## 2. What goes into Redis

One new key, added to the existing shared-state mechanism — **do not build a separate
Redis client or a separate hydrate/flush cycle.** `lib/shared-state/index.ts` already
does exactly this for every other store (`lib/shared-state/registry.ts`): hydrate from
Redis at the top of the request, run the handler, flush what changed at the end. Reuse it.

### 2.1 Give `StoreDescriptor` an optional TTL override

Every existing store expires after 24h (`TTL_SECONDS` in `lib/shared-state/index.ts:28`) —
correct for disposable demo data, wrong for access control, which must survive the daily
reset. Add:

```ts
// lib/shared-state/registry.ts
export interface StoreDescriptor {
  key: string;
  ttlSeconds?: number | null;   // null = no expiry. Omitted = inherit the default (24h).
  snapshot(): unknown;
  restore(data: unknown): void;
}
```

```ts
// lib/shared-state/index.ts, inside flush()
const ttl = d.ttlSeconds === null ? undefined : (d.ttlSeconds ?? TTL_SECONDS);
if (ttl !== undefined) multi.set(keyFor(d.key), next, { EX: ttl });
else multi.set(keyFor(d.key), next);
```

### 2.2 The descriptor

```ts
// lib/shared-state/registry.ts
import { accessStore } from "@/lib/access/store";

const accessDescriptor: StoreDescriptor = {
  key: "access",
  ttlSeconds: null,
  snapshot: () => accessStore.snapshot(),
  restore: (data) => accessStore.restore(data as ReturnType<typeof accessStore.snapshot>),
};

export const ALL_DESCRIPTORS: StoreDescriptor[] = [
  bookingDescriptor,
  auditDescriptor,
  loadedToolsDescriptor,
  accessDescriptor,           // <-- add here
  ...SEED_DESCRIPTORS,
];
```

This rides the exact same key-naming (`webmcp:<SCHEMA_VERSION>:<VERCEL_ENV>:access`),
the same Redis outage fail-open behavior, and the same per-descriptor isolated
restore-failure handling that every other store already has. **Bump `SCHEMA_VERSION`
in `lib/shared-state/index.ts:12`** when this ships, the same way any snapshot-shape
change already requires — old data is then simply not read rather than crashing
`restore()` on an unrecognized shape.

### 2.3 The JSON payload shape

`accessStore.snapshot()` returns exactly what gets `JSON.stringify`'d into that key:

```ts
// lib/access/store.ts
export interface AccessSnapshot {
  roles: [string, RoleDef][];   // Map entries — same pattern as every other Map-backed store
  users: [string, UserRecord][];
}
```

```ts
export interface RoleDef {
  id: string;                             // slug, e.g. "support" or "night-audit" — no "."
  name: string;                           // display name
  tier: "customer" | "support" | "admin"; // drives ownership checks (§4) — pick the closest match for a custom role
  permissions: string[];                  // operation names, plus "manageAccess"
  fieldRestrictions: Record<string, string[]>;  // opName -> field names this role can't send
  builtIn: boolean;                       // true only for customer/support/admin — blocks deletion
}

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  roleId: string;                         // FK into roles, by id
  passwordHash: string;                   // see §5 — never the plaintext
  overrides: {
    grant: string[];
    deny: string[];
    fieldRestrictions: Record<string, string[]>;
  };
}
```

This is a **single JSON blob per key**, not one Redis key per user — consistent with how
every other store here works (e.g. `bookingStore` is one blob holding every reservation).
At demo scale (tens of users) this is simpler than fan-out keys and gets one atomic
read/write per request via the existing `multi()` pipeline in `hydrate()`/`flush()`.

### 2.4 Seeding — must reproduce today's behavior exactly

On cold start (`accessStore` module load, mirroring `lib/seed/store.ts`'s pattern), seed:

- **Three built-in roles**, generated *from the registry*, not hand-typed — this is what
  guarantees the migration doesn't silently change anyone's access:
  ```ts
  const permissions = registry
    .filter((op) => roleSatisfies(tier, op.roles))   // the OLD function, used once, at seed time only
    .map((op) => op.name);
  ```
  `admin`'s seeded permissions additionally include `"manageAccess"`.
- **Three users** — alice/carol/bob, same ids, `roleId` = their current role name,
  `passwordHash` = `hashPassword("password")` (§5), empty overrides.

`roleSatisfies` and the old `Role` union type stay in `lib/auth.ts` for exactly this — the
one-time seed conversion — plus for the `tier` semantics described in §4. Don't delete them.

---

## 3. Handling roles

A `RoleDef` is a named, mutable bundle of permissions. Rules to enforce in the management
API (`app/api/admin/roles/*`, not yet written — see the full plan doc for the route table):

- **`id`**: slugify on creation (`[a-z0-9-]+`), reject if it collides with an existing id or
  contains `.` (it must never end up embedded in a token payload the way a role name did
  before — see §5, this is exactly why we stop doing that).
- **`tier`**: required, one of the three fixed tiers. This is *not* deprecated by custom
  roles — it's what keeps `completeTask.ts:23` and `getBillSummary.ts:25`'s ownership
  checks (`ctx.role === "customer"`) working without a rewrite. A custom role for, say,
  night-shift support picks `tier: "support"`.
  - **`admin` tier is not required to build in `manageAccess`** — only the *built-in*
    `admin` role has that hard-wired (see next bullet). Someone can create a `tier: "admin"`
    custom role without giving it `manageAccess`.
- **`builtIn`**: only `customer`, `support`, `admin` (the three seeded ones) have this set.
  - Deletion of a `builtIn` role is rejected outright.
  - `permissions.delete("manageAccess")` on the built-in `admin` role specifically is
    rejected — this is the "admin role can never lose the ability to manage access"
    guard rail. It's a check on that one role id, not a generic rule about `tier`.
- **Deleting a non-built-in role**: reject if any `UserRecord.roleId` still references it.
  Message: reassign those users first.
- **Permission and field names**: validate against the live registry on every write —
  `registry.some(op => op.name === permission)`, and for fields,
  `Object.keys(op.inputSchema)`. An admin should not be able to type a permission that
  doesn't correspond to a real operation; that's a silent no-op bug waiting to happen
  otherwise.
- **Cloning**: "new role from X" is just `{ ...roleX, id: newId, name: newName, builtIn: false }` —
  no special-cased logic needed.

---

## 4. Handling permissions

A permission is **one operation name**, or the literal string `"manageAccess"` (which
doesn't correspond to any `Operation` in the registry — it's the gate on the new admin
routes themselves). There is no separate "permission catalog" data structure to maintain:
the source of truth for "which permissions exist" is `registry.map(op => op.name)` plus
that one extra literal. Anything else is a bug in the admin UI, not new data to store.

Two places check permissions, and they check different things:

1. **`can(principal, opName)`** — "is this permission present in the effective set?" A
   plain `Set.has`. This is what every enforcement call site in §1's table calls.
2. **`authorize(principal, op, rawInput)`** — `can()`, plus the field-restriction check.
   Only called at the two or three sites that actually receive a raw input object to
   check (`/api/call`, the MCP tool-call handler, `dispatch.ts`). The pure discovery/listing
   call sites (`capabilities.ts`, `modules.ts`, tool-list filtering) only ever need `can()` —
   they're not receiving a field payload to inspect.

**Field restrictions are per (role-or-user, operation, field)**, not global. The same field
name (`email`) can be restricted on `updateGuest` for one role and unrestricted on some
other operation that happens to also take an `email` field. That's why the type is
`Record<opName, string[]>`, keyed per operation, not a flat set of field names.

---

## 5. Coupling permissions to a user — the resolution algorithm

This is the one piece of new logic that has to be exactly right, since every authorization
decision in the app runs through it.

```ts
// lib/access/policy.ts
export interface Principal {
  userId: string;
  roleId: string;
  tier: "customer" | "support" | "admin";
  permissions: Set<string>;
  restrictedFields: Map<string, Set<string>>;
}

export function resolvePrincipal(userId: string): Principal | null {
  const user = accessStore.users.get(userId);
  if (!user) return null;
  const role = accessStore.roles.get(user.roleId);
  if (!role) return null;   // orphaned roleId — treat as no access, don't throw

  const permissions = new Set(role.permissions);
  for (const p of user.overrides.grant) permissions.add(p);
  for (const p of user.overrides.deny) permissions.delete(p);   // deny is applied LAST — it always wins

  const restrictedFields = new Map<string, Set<string>>();
  const merge = (src: Record<string, string[]>) => {
    for (const [op, fields] of Object.entries(src)) {
      const set = restrictedFields.get(op) ?? new Set<string>();
      for (const f of fields) set.add(f);
      restrictedFields.set(op, set);
    }
  };
  merge(role.fieldRestrictions);
  merge(user.overrides.fieldRestrictions);   // union, not override — a user restriction never LIFTS a role restriction

  return { userId, roleId: user.roleId, tier: role.tier, permissions, restrictedFields };
}
```

Key properties to preserve, because they're what "deny always wins" and "field
restrictions only ever narrow" actually mean in code:

- **Order of operations**: grants applied first, denies second. If the same permission is
  in both `grant` and `deny` for some reason, deny wins because it runs last against the
  same `Set`.
- **Field restrictions never subtract.** There's no "un-restrict" override — only
  `merge()`, which unions. A role-level restriction on `email` can't be lifted for one
  user; if that's ever needed, it means the field restriction belongs on the user's grant
  list logic instead, not a new "allow" list for fields (out of scope until someone asks
  for it — don't build it speculatively).
- **`resolvePrincipal` is synchronous** given an already-hydrated `accessStore` (it's an
  in-memory Map read, same as every other store here — the Redis round-trip already
  happened in `withSharedState`'s `hydrate()` before the route handler runs). Don't awkwardly
  make it `async` just because "Redis" is involved elsewhere in the request lifecycle.

### 5.1 Where `resolvePrincipal` gets called, and how the role is decided per-request

This is the one place today's behavior and the plan diverge on purpose, and it's worth
being explicit about why:

- **Today**: the role is decoded straight out of the signed cookie/token payload
  (`userForSession`/`userForToken` in `lib/auth-tokens.ts`). That's what makes the
  role-switcher (`/api/switch-role`) work with zero server-side state — the switch just
  re-signs the cookie.
- **Planned**: permissions must never live in the token, because the whole point is that
  an admin's edit on the Access page should apply on that person's *very next request*,
  without them re-logging in. A token that had permissions baked in would go stale the
  moment an admin changed anything.
- **The fix**: keep the token payload exactly as small as it is today
  (`userId.roleId.exp[.audHash]` — same three-or-four fields, `role` renamed to `roleId`
  in meaning only). Every request still decodes `userId` (and, only when
  `DEMO_MODE !== "false"`, the demo role-switcher's `roleId`) from the signed
  cookie/token exactly as now — **but then calls `resolvePrincipal(userId)` fresh, and
  never reads `permissions` from the token, because the token never carries them.**
- With `DEMO_MODE=false` (real deployments), skip the token's `roleId` entirely and use
  `accessStore.users.get(userId).roleId` — so a real admin reassigning someone's role in
  the Access page changes their access immediately, not "next login."
- With `DEMO_MODE` on (default), honor the token's `roleId` for the switcher's sake, but
  still resolve *permissions* fresh via `resolvePrincipal` — the switcher swaps which role
  you're resolved against, not a cached permission set.

Net effect: `getOrProvisionUser()` and `userForSession`/`userForToken` in
`lib/auth-tokens.ts` change to return `{ userId, roleId }` only (drop the eager
`{ ...base, role }` user object they build today); every call site that used to read
`user.role` calls `resolvePrincipal(user.id).tier` (for ownership checks) or passes the
whole `Principal` through `ctx.principal` (for `authorize()`).

### 5.2 `OperationContext`

```ts
// lib/operations/types.ts
export interface OperationContext {
  userId: string;
  role: Role;            // = principal.tier — kept as-is so existing ownership checks (completeTask.ts, getBillSummary.ts) don't change
  principal: Principal;  // new — pass to authorize() where an operation needs to re-check something mid-handler
  token: string;
}
```

Nothing inside an operation handler needs to change unless it wants to do its own
fine-grained check — the existing `ctx.role === "customer"` ownership pattern is
untouched.

---

## 6. Passwords (needed the moment users are created outside the seed)

New file `lib/access/passwords.ts`, server-only (imports `node:crypto`, so it must never be
reachable from a client-component import chain — check this the same way
`lib/auth-tokens.ts`'s header comment explains for the crypto/no-crypto split):

```ts
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scryptAsync = promisify(scrypt);

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scryptAsync(plain, salt, 64)) as Buffer;
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = (await scryptAsync(plain, salt, 64)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

`verifyCredentials` in `lib/auth.ts` becomes async and looks up `accessStore.users` instead
of the hard-coded `USERS` constant. This ripples into `app/api/login/route.ts`, which
already `await`s nothing today — trivial change, just add `await`.

---

## 7. Build order (keeps `npm test` green throughout)

Suggested sequence — each step should leave the existing test suite passing before moving
to the next:

1. `lib/access/types.ts`, `store.ts` (seeded, unwired), `policy.ts`, `passwords.ts`. Add
   `tests/unit/access-policy.test.ts` (deny-wins, grant-adds, field-check-on-raw-input,
   seeded roles match today's `roleSatisfies` matrix exactly). Nothing else changed yet —
   this step is purely additive.
2. Redis descriptor + TTL plumbing (§2.1–2.2). Bump `SCHEMA_VERSION`.
3. Swap the 8 call sites in §1's table, one at a time, re-running
   `tests/integration/rbac.test.ts` after each.
4. `lib/auth.ts` / `lib/auth-tokens.ts` identity changes (§5.1), `OperationContext` (§5.2).
   Run `tests/unit/auth.test.ts` and `tests/integration/rbac.test.ts` again — these should
   still pass unchanged, since the seeded built-in roles reproduce today's matrix exactly.
5. Management API routes (`/api/admin/roles`, extend `/api/admin/users`) with the guard
   rails from §3. Add integration tests for the guard rails and for 403s from
   non-`manageAccess` callers.
6. UI: Access page, replacing `components/UsersPanel.tsx`; swap the hard-coded
   `isPrivileged`/`isAdmin` checks in `AppShell.tsx`, `CrmPanel.tsx`, `ReservationsPanel.tsx`,
   `TasksPanel.tsx`, `HousekeepingPanel.tsx`, `TaskSearchCard.tsx` for `can("<op>")`.
7. MCP tool-schema field omission in `lib/adapters/mcp.ts` (strip restricted fields from
   `inputSchema` at `registerTool` time).
8. End-to-end manual pass: create "dana" per the worked example in
   `authorization-design.html`, confirm all three traces through the UI, the in-page agent,
   and a real MCP client.

Full route table, UI sketch, and verification checklist are in the plan already on file —
this doc exists to answer the four specific "how do the internals actually work" questions
that plan doesn't spell out at code level.
