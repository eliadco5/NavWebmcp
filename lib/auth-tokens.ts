// Split out of lib/auth.ts because it imports node:crypto. app/providers.tsx (a
// client component) imports lib/operations/index.ts for the operation registry,
// which transitively imported lib/auth.ts for the Role type + roleSatisfies() —
// and webpack refuses to bundle node:crypto for the browser ("Reading from
// node:crypto is not handled by plugins"). Keeping every crypto-dependent export
// in its own module means lib/auth.ts stays safe to import from client code, and
// only server-only route handlers (and lib/adapters/mcp.ts) reach into this file.
import crypto from "node:crypto";
import { SESSION_COOKIE, AGENT_TOKEN_PREFIX } from "@/lib/constants";
import { getUserById, type User, type Role } from "@/lib/auth";

// The canonical resource URI this server is the audience for (RFC 8707).
// Must match the URL callers use to reach the MCP endpoint.
//
// VERCEL_PROJECT_PRODUCTION_URL (not VERCEL_URL — that's per-deployment and would
// rotate the audience, and therefore every already-issued token, on every push).
export const MCP_RESOURCE =
  process.env.MCP_RESOURCE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/mcp`
    : "http://localhost:3000/api/mcp");

const VALID_ROLES = ["customer", "support", "admin"] as const;
function isRole(value: string): value is Role {
  return (VALID_ROLES as readonly string[]).includes(value);
}

// ── Stateless signing ─────────────────────────────────────────────────────────
//
// Sessions and agent tokens are HMAC-signed strings, not server-side lookups.
// This is the deploy fix for Vercel: a session/token minted by one serverless
// instance must verify on every other instance, since there is no shared Map.
//
// SECRET falls back to a hardcoded constant, deliberately — a *random* fallback
// would silently re-introduce the exact bug this file exists to fix (a cookie
// minted on instance A fails to verify on instance B, because each instance
// picked its own random secret at cold start). Set AUTH_SECRET in Vercel; the
// fallback exists so a misconfigured deploy degrades to "insecure" rather than
// "broken", which matters more for a demo whose admin password is in the README.
const SECRET = process.env.AUTH_SECRET ?? "agentbridge-demo-insecure-default-do-not-reuse";

// Two independent HMAC "domains" so a session cookie can never be replayed as a
// bearer token (or vice versa) even though both are otherwise the same scheme.
const DOMAIN_SESSION = "s:";
const DOMAIN_TOKEN = "t:";

function sign(domain: string, payload: string): string {
  return crypto.createHmac("sha256", SECRET).update(domain + payload).digest("base64url");
}

/** payload -> "<base64url(payload)>.<base64url(hmac)>" */
function signPayload(domain: string, payload: string): string {
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(domain, payload)}`;
}

/** Verify + decode. Returns the original payload string, or null if malformed/tampered. */
function verifySigned(domain: string, value: string): string | null {
  const dot = value.indexOf(".");
  if (dot === -1) return null;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const expected = sign(domain, payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return payload;
}

/**
 * Round the expiry to a fixed bucket so re-issuing the same user+role within the
 * same bucket produces a byte-identical string. This isn't a nicety — three routes
 * (/api/me, /api/audit, /api/switch-role) can all auto-provision a fresh session in
 * parallel on first load; without bucketing they'd each mint a different value and
 * race on Set-Cookie. It's also why a copy-pasted agent token doesn't change out
 * from under an MCP client mid-session.
 */
function bucketedExpiry(ttlMs: number, bucketMs: number): number {
  return Math.ceil((Date.now() + ttlMs) / bucketMs) * bucketMs;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h >>>= 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── UI sessions ───────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // 7 days
const SESSION_BUCKET_MS = 24 * 60 * 60 * 1000;     // 1 day

export function createSession(user: User): string {
  const exp = bucketedExpiry(SESSION_TTL_MS, SESSION_BUCKET_MS);
  return signPayload(DOMAIN_SESSION, `${user.id}.${user.role}.${exp}`);
}

/** Decode + verify a session cookie. The returned user's role comes from the signed
 *  payload, not from the USERS table — that's what lets /api/switch-role change a
 *  caller's effective role without any server-side mutation. */
export function userForSession(cookieValue: string): User | null {
  const payload = verifySigned(DOMAIN_SESSION, cookieValue);
  if (!payload) return null;

  const [userId, role, expStr] = payload.split(".");
  const exp = Number(expStr);
  if (!userId || !role || !isRole(role) || !Number.isFinite(exp) || exp <= Date.now()) return null;

  const base = getUserById(userId);
  if (!base) return null;
  return { ...base, role };
}

// ── Agent tokens (RFC 8707 audience-bound, expiring) ─────────────────────────

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;   // 8 hours
const TOKEN_BUCKET_MS = 60 * 60 * 1000;    // 1 hour

export function issueToken(user: User): string {
  const exp = bucketedExpiry(TOKEN_TTL_MS, TOKEN_BUCKET_MS);
  const audHash = djb2(MCP_RESOURCE);
  const signed = signPayload(DOMAIN_TOKEN, `${user.id}.${user.role}.${exp}.${audHash}`);
  return `${AGENT_TOKEN_PREFIX}.${signed}`;
}

/** Decode + verify a bearer token, enforcing audience binding (RFC 8707) and expiry.
 *  Like userForSession, the role comes from the payload, not the USERS table. */
export function userForToken(token: string): User | null {
  const prefix = `${AGENT_TOKEN_PREFIX}.`;
  if (!token.startsWith(prefix)) return null;

  const payload = verifySigned(DOMAIN_TOKEN, token.slice(prefix.length));
  if (!payload) return null;

  const [userId, role, expStr, audHash] = payload.split(".");
  const exp = Number(expStr);
  if (!userId || !role || !isRole(role) || !Number.isFinite(exp) || exp <= Date.now()) return null;
  if (audHash !== djb2(MCP_RESOURCE)) return null;

  const base = getUserById(userId);
  if (!base) return null;
  return { ...base, role };
}

// ── Auto-provisioning ─────────────────────────────────────────────────────────
//
// The judge-facing requirement is "land on the URL already signed in." Doing that
// in middleware is impossible (Edge runtime, no node:crypto); doing it client-side
// means a visible /login flash before the redirect. So every route that needs a
// user calls this first: it trusts an existing valid cookie, or mints a fresh
// alice/customer session on the spot.

export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: SESSION_TTL_MS / 1000, // seconds — an explicit maxAge survives an iOS
                                  // WKWebView (the ChatGPT in-app browser) tearing
                                  // down and re-launching; a bare session cookie
                                  // does not, and the judge would silently be
                                  // reset to customer every time they reopen the link.
};

type CookieStore = {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options?: Record<string, unknown>): void;
};

export function getOrProvisionUser(cookieStore: CookieStore): { user: User | null; provisioned: boolean } {
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const existing = raw ? userForSession(raw) : null;
  if (existing) return { user: existing, provisioned: false };

  // DEMO_MODE=false turns this back into a normal login-required app (and disables
  // /api/switch-role) — the escape hatch for anyone reusing this repo for real.
  if (process.env.DEMO_MODE === "false") return { user: null, provisioned: false };

  const alice = getUserById("u_alice")!;
  cookieStore.set(SESSION_COOKIE, createSession(alice), COOKIE_OPTS);
  return { user: alice, provisioned: true };
}
