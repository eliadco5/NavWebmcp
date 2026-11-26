// Constants shared between the Node runtime (lib/auth.ts, route handlers) and the
// Edge runtime (middleware.ts). Kept separate from lib/auth.ts so middleware never
// pulls in node:crypto — importing a Node-only module into an Edge bundle breaks the
// build. Middleware only needs the cookie NAME (it checks presence, never validates
// the signature — see middleware.ts), so this file has zero Node dependencies.

export const SESSION_COOKIE = "agentbridge_session";

// Prefix on every agent token so a malformed/foreign bearer string is rejected before
// any HMAC work happens, and so a token can never be confused with a session cookie.
export const AGENT_TOKEN_PREFIX = "ab1";

// Headers the browser sets on POST /api/call to say which in-page caller made
// the request. The session cookie proves WHO; these only say whether a person
// or the in-page WebMCP agent pressed the button, so the server records the
// actor as "asserted" rather than "verified".
export const CHANNEL_HEADER = "x-navwebmcp-channel";
export const AGENT_HEADER = "x-navwebmcp-agent";

// How MCP tool results are written in their text block (NavWebMcp >= 2.3.0):
// "pretty" (2-space indented JSON, the default) or "compact" (no whitespace,
// fewer tokens). Chosen per connection with this header or `?format=` on the
// MCP URL, or per call with _meta["navwebmcp/format"]. structuredContent and
// _meta are the same either way.
export const FORMAT_HEADER = "x-navwebmcp-format";
export const TEXT_FORMATS = ["pretty", "compact"] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

// NavWebMcp credits over HTTP (docs/credits.md). `request` is the caller's
// optional CreditRequest; the rest come back on every metered response.
export const CREDIT_HEADERS = {
  request: "x-navwebmcp-credit-request",
  balance: "x-navwebmcp-credits-balance",
  window: "x-navwebmcp-credits-window",
  charged: "x-navwebmcp-credits-charged",
  granted: "x-navwebmcp-credits-granted",
} as const;

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
