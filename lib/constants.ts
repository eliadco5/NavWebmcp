// Constants shared between the Node runtime (lib/auth.ts, route handlers) and the
// Edge runtime (middleware.ts). Kept separate from lib/auth.ts so middleware never
// pulls in node:crypto — importing a Node-only module into an Edge bundle breaks the
// build. Middleware only needs the cookie NAME (it checks presence, never validates
// the signature — see middleware.ts), so this file has zero Node dependencies.

export const SESSION_COOKIE = "agentbridge_session";

// Prefix on every agent token so a malformed/foreign bearer string is rejected before
// any HMAC work happens, and so a token can never be confused with a session cookie.
export const AGENT_TOKEN_PREFIX = "ab1";

// The three seeded demo users, by id. Used to auto-provision a session when none exists.
export const DEMO_USER_IDS = ["u_alice", "u_carol", "u_bob"] as const;

// Same three users, with display names — for UI `<select>`s that need to
// assign/attribute something to a user (task assignee, shift note author,
// inspection inspector) without calling an admin-only lookup endpoint.
export const DEMO_USERS = [
  { id: "u_alice", name: "Alice" },
  { id: "u_carol", name: "Carol" },
  { id: "u_bob", name: "Bob" },
] as const;
