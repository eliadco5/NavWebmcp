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

const DOMAIN_UPLOAD = "u:";
const UPLOAD_TTL_MS = 10 * 60 * 1000;

/** Short-lived capability to upload attachments for one bug report — lets the
 *  reporter (any role) add files to the report they just created, and nothing else. */
export function signUploadToken(reportId: string, now = Date.now()): string {
  return signPayload(DOMAIN_UPLOAD, JSON.stringify({ r: reportId, e: now + UPLOAD_TTL_MS }));
}

export function verifyUploadToken(token: string, reportId: string, now = Date.now()): boolean {
  const payload = verifySigned(DOMAIN_UPLOAD, token);
  if (!payload) return false;
  try {
    const { r, e } = JSON.parse(payload) as { r?: string; e?: number };
    return r === reportId && typeof e === "number" && e > now;
  } catch {
    return false;
  }
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

/** A fresh, unguessable session id (no dots — it lives inside a dotted payload). */
export function newSessionId(): string {
  return `s_${crypto.randomBytes(12).toString("base64url").replace(/[-_]/g, "x")}`;
}

/** Deterministic fallback id for callers that don't pass one (tests, and
 *  cookies minted before session ids existed). Same user+role+expiry bucket →
 *  same id, preserving createSession()'s byte-identical re-issue property. */
function derivedSessionId(userId: string, role: string, exp: number): string {
  return `s_d${djb2(`${userId}.${role}.${exp}`)}`;
}

/**
 * Mint a session cookie. `sid` identifies the human session for monitoring and
 * revocation (lib/management/sessions.ts): /api/login passes a fresh one,
 * /api/switch-role carries the existing one over so a role change is the same
 * session, not a new login.
 */
export function createSession(user: User, sid?: string): string {
  const exp = bucketedExpiry(SESSION_TTL_MS, SESSION_BUCKET_MS);
  const id = sid ?? derivedSessionId(user.id, user.role, exp);
  return signPayload(DOMAIN_SESSION, `${user.id}.${user.role}.${exp}.${id}`);
}

export interface SessionClaims {
  user: User;
  sid: string;
  exp: number;
}

/** Decode + verify a session cookie, returning the user and the session id. */
export function sessionForCookie(cookieValue: string): SessionClaims | null {
  const payload = verifySigned(DOMAIN_SESSION, cookieValue);
  if (!payload) return null;

  const [userId, role, expStr, sid] = payload.split(".");
  const exp = Number(expStr);
  if (!userId || !role || !isRole(role) || !Number.isFinite(exp) || exp <= Date.now()) return null;

  const base = getUserById(userId);
  if (!base) return null;
  return { user: { ...base, role }, sid: sid || derivedSessionId(userId, role, exp), exp };
}

/** Decode + verify a session cookie. The returned user's role comes from the signed
 *  payload, not from the USERS table — that's what lets /api/switch-role change a
 *  caller's effective role without any server-side mutation. */
export function userForSession(cookieValue: string): User | null {
  return sessionForCookie(cookieValue)?.user ?? null;
}

// ── Agent tokens (RFC 8707 audience-bound, expiring) ─────────────────────────

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;   // 8 hours
const TOKEN_BUCKET_MS = 60 * 60 * 1000;    // 1 hour

/** A fresh client id for an explicitly connected agent (no dots). */
export function newClientId(): string {
  return `c_${crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;
}

/** The default agent client of a session: one per session + role, stable for
 *  the session's lifetime, so the token /api/me hands out keeps identifying the
 *  same client across page loads. */
export function defaultClientId(sid: string, role: Role): string {
  return `c_d${djb2(`${sid}.${role}`)}`;
}

export interface IssueTokenOptions {
  /** Agent client this token identifies (lib/management/clients.ts). */
  clientId?: string;
  /** Human session that authorised it, if any. */
  sid?: string;
}

/**
 * Mint an agent bearer token. Each token names an agent client (`cid`), so two
 * agents of the same user are distinguishable in the audit trail and each can
 * be revoked on its own. Same user+role+client within an hour bucket still
 * re-issues a byte-identical token.
 */
export function issueToken(user: User, options: IssueTokenOptions = {}): string {
  const exp = bucketedExpiry(TOKEN_TTL_MS, TOKEN_BUCKET_MS);
  const audHash = djb2(MCP_RESOURCE);
  const cid = options.clientId ?? (options.sid ? defaultClientId(options.sid, user.role) : `legacy-${user.id}`);
  const sid = options.sid ?? "";
  const signed = signPayload(DOMAIN_TOKEN, `${user.id}.${user.role}.${exp}.${audHash}.${cid}.${sid}`);
  return `${AGENT_TOKEN_PREFIX}.${signed}`;
}

export interface TokenClaims {
  user: User;
  clientId: string;
  sid?: string;
  exp: number;
}

/** Decode + verify a bearer token, enforcing audience binding (RFC 8707) and
 *  expiry. Does NOT check revocation — that needs the management store, see
 *  lib/management/auth.ts. */
export function claimsForToken(token: string): TokenClaims | null {
  const prefix = `${AGENT_TOKEN_PREFIX}.`;
  if (!token.startsWith(prefix)) return null;

  const payload = verifySigned(DOMAIN_TOKEN, token.slice(prefix.length));
  if (!payload) return null;

  const [userId, role, expStr, audHash, cid, sid] = payload.split(".");
  const exp = Number(expStr);
  if (!userId || !role || !isRole(role) || !Number.isFinite(exp) || exp <= Date.now()) return null;
  if (audHash !== djb2(MCP_RESOURCE)) return null;

  const base = getUserById(userId);
  if (!base) return null;
  return { user: { ...base, role }, clientId: cid || `legacy-${userId}`, sid: sid || undefined, exp };
}

/** Like userForSession, the role comes from the payload, not the USERS table. */
export function userForToken(token: string): User | null {
  return claimsForToken(token)?.user ?? null;
}

// ── Auto-provisioning (demo mode only) ────────────────────────────────────────
//
// Login is required by default: a visitor with no valid session is sent to
// /login (app/page.tsx) and every API route answers 401.
//
// DEMO_MODE=true brings back the old judge-facing "land on the URL already signed
// in" behaviour: every route that needs a user calls getOrProvisionUser first, and
// it mints a fresh alice/customer session on the spot for a visitor with none.
// (Doing that in middleware is impossible — Edge runtime, no node:crypto.)
//
// DEMO_MODE=false additionally switches off the demo shortcuts (the role switcher
// and "Reset demo data"); see app/api/switch-role and app/api/bench/reset.

/** True only when DEMO_MODE is explicitly "true". */
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

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

export function getOrProvisionUser(
  cookieStore: CookieStore
): { user: User | null; provisioned: boolean; sid?: string } {
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const existing = raw ? sessionForCookie(raw) : null;
  if (existing) return { user: existing.user, provisioned: false, sid: existing.sid };

  // Not in demo mode: no session means not signed in. The caller answers 401
  // (API routes) or redirects to /login (app/page.tsx).
  if (!isDemoMode()) return { user: null, provisioned: false };

  // A fresh id rather than the derived one: after a logout (which ends the
  // session server-side) a re-provisioned visitor must not land back on the
  // ended session.
  const alice = getUserById("u_alice")!;
  const sid = newSessionId();
  cookieStore.set(SESSION_COOKIE, createSession(alice, sid), COOKIE_OPTS);
  return { user: alice, provisioned: true, sid };
}
