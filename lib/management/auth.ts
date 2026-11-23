// Request authentication with revocation and activity tracking.
//
// lib/auth-tokens.ts verifies signatures and expiry, statelessly. This layer
// adds what a stateless check can't: has this session been ended (logout,
// admin revocation) or this agent client been revoked — and it records the
// heartbeat that drives "who's connected right now". Every API route and the
// MCP endpoint authenticate through here.
import { SESSION_COOKIE } from "@/lib/constants";
import {
  getOrProvisionUser, claimsForToken, COOKIE_OPTS, type TokenClaims,
} from "@/lib/auth-tokens";
import type { User } from "@/lib/auth";
import { endRecord, getEnd, recordClient, recordSession, revokeRecord, touch } from "./sessions";
import { auditAuth, humanActor } from "@/lib/audit";

type CookieStore = Parameters<typeof getOrProvisionUser>[0] & {
  delete?(name: string): void;
};

export interface RequestInfo {
  ip?: string;
  userAgent?: string;
}

export function requestInfo(headers?: Headers): RequestInfo {
  const forwarded = headers?.get("x-forwarded-for");
  return {
    ip: forwarded ? forwarded.split(",")[0].trim() : headers?.get("x-real-ip") ?? undefined,
    userAgent: headers?.get("user-agent")?.slice(0, 300) ?? undefined,
  };
}

export type SessionAuth =
  | { user: User; sid: string; provisioned: boolean }
  | { user: null; sid?: undefined; provisioned: false; reason: "NO_SESSION" | "SESSION_ENDED" };

/**
 * The cookie-session counterpart of getOrProvisionUser(), plus: a session that
 * was ended (logout / admin revocation) is rejected even though its cookie is
 * still validly signed, and its cookie is cleared.
 */
export async function authenticateSession(cookieStore: CookieStore, info: RequestInfo = {}): Promise<SessionAuth> {
  const { user, provisioned, sid } = getOrProvisionUser(cookieStore);
  if (!user || !sid) return { user: null, provisioned: false, reason: "NO_SESSION" };

  const end = provisioned ? null : await getEnd(sid);
  if (end) {
    cookieStore.delete?.(SESSION_COOKIE);
    // Use of a revoked session is a security signal; a logged-out tab still
    // polling once before its cookie is cleared is routine, so only the former.
    if (end.reason === "revoked") {
      await auditAuth({
        action: "auth.session_rejected",
        outcome: "denied",
        errorCode: "SESSION_ENDED",
        actor: humanActor(user, sid),
        ...info,
        target: { type: "session", id: sid },
      });
    }
    return { user: null, provisioned: false, reason: "SESSION_ENDED" };
  }

  if (await touch(sid, info)) {
    await recordSession({
      sid,
      userId: user.id,
      role: user.role,
      startedAt: new Date().toISOString(),
      ...info,
      provisioned: provisioned || undefined,
    });
  }
  return { user, sid, provisioned };
}

/** Record a fresh sign-in (called by /api/login with the sid it just minted). */
export async function startSession(sid: string, user: User, info: RequestInfo = {}): Promise<void> {
  await recordSession({ sid, userId: user.id, role: user.role, startedAt: new Date().toISOString(), ...info });
  await touch(sid, info);
}

export async function endSession(sid: string, reason: "logout" | "revoked", by?: string): Promise<boolean> {
  return reason === "revoked" ? revokeRecord(sid, by) : endRecord(sid, reason, by);
}

export async function revokeClient(clientId: string, by?: string): Promise<boolean> {
  return revokeRecord(clientId, by);
}

/**
 * Verify a bearer token AND that its agent client hasn't been revoked, nor the
 * human session that authorised it (a logout does not disconnect agents; an
 * admin revoking the session does).
 */
export async function authenticateAgentToken(
  bearer: string,
  seen: RequestInfo = {}
): Promise<TokenClaims | null> {
  const claims = claimsForToken(bearer);
  if (!claims) return null;

  const [clientEnd, sessionEnd] = await Promise.all([
    getEnd(claims.clientId),
    claims.sid ? getEnd(claims.sid) : Promise.resolve(null),
  ]);
  if (clientEnd || sessionEnd?.reason === "revoked") {
    // A revoked agent still trying to connect: worth seeing.
    await auditAuth({
      action: "auth.agent_token_rejected",
      outcome: "denied",
      errorCode: "UNAUTHENTICATED",
      actor: {
        type: "agent",
        userId: claims.user.id,
        role: claims.user.role,
        assurance: "verified",
        sessionId: claims.sid,
        agent: { clientId: claims.clientId },
      },
      channel: "mcp",
      ...seen,
      target: clientEnd ? { type: "agentClient", id: claims.clientId } : { type: "session", id: claims.sid! },
    });
    return null;
  }

  if (await touch(claims.clientId, seen)) {
    await recordClient({
      clientId: claims.clientId,
      userId: claims.user.id,
      role: claims.user.role,
      kind: claims.clientId.startsWith("legacy-") ? "legacy" : claims.clientId.startsWith("c_d") ? "default" : "connected",
      sid: claims.sid,
      createdAt: new Date().toISOString(),
    });
  }
  return claims;
}

export { COOKIE_OPTS };
