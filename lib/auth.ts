import { SESSION_COOKIE } from "@/lib/constants";

// Crypto-dependent exports (sessions, agent tokens, MCP_RESOURCE) live in
// lib/auth-tokens.ts, not here — see that file's header comment for why. This
// file must stay importable from client components (app/providers.tsx does, via
// lib/operations -> lib/capabilities -> here), so it may never import node:crypto
// or anything else Node-only.
export { SESSION_COOKIE };

// ── Roles ─────────────────────────────────────────────────────────────────────

export type Role = "customer" | "support" | "admin";

const ROLE_RANK: Record<Role, number> = { customer: 1, support: 2, admin: 3 };

/** Returns true when the user's role satisfies at least one of the required roles
 *  (hierarchical: admin ≥ support ≥ customer). */
export function roleSatisfies(userRole: Role, allowed: Role[]): boolean {
  const rank = ROLE_RANK[userRole];
  return allowed.some((r) => rank >= ROLE_RANK[r]);
}

// ── Users ─────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

// Seeded demo users. Passwords are plaintext — intentional for an in-memory demo only.
// Roles here are only the DEFAULT for a fresh sign-in; the live role for an existing
// session/token is carried in the signed payload itself (lib/auth-tokens.ts), which
// is what lets the role switcher work with no mutable server-side state.
const USERS: Record<string, { user: User; password: string }> = {
  alice: { user: { id: "u_alice", username: "alice", displayName: "Alice", role: "customer" }, password: "password" },
  bob:   { user: { id: "u_bob",   username: "bob",   displayName: "Bob",   role: "admin"    }, password: "password" },
  carol: { user: { id: "u_carol", username: "carol", displayName: "Carol", role: "support"  }, password: "password" },
};

export function verifyCredentials(username: string, password: string): User | null {
  const entry = USERS[username];
  if (!entry || entry.password !== password) return null;
  return entry.user;
}

export function getUserById(id: string): User | null {
  return Object.values(USERS).find((e) => e.user.id === id)?.user ?? null;
}

export function listUsers(): User[] {
  return Object.values(USERS).map((e) => e.user);
}

// ── Scope helpers (for AuthInfo & RFC 9728 metadata) ─────────────────────────

export const ALL_SCOPES = ["booking:read", "booking:write", "booking:support", "booking:admin"];

const ROLE_SCOPES: Record<Role, string[]> = {
  customer: ["booking:read", "booking:write"],
  support:  ["booking:read", "booking:write", "booking:support"],
  admin:    ["booking:read", "booking:write", "booking:support", "booking:admin"],
};

export function scopesForRole(role: Role): string[] {
  return ROLE_SCOPES[role];
}
