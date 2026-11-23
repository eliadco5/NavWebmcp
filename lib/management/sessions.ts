// Human sessions and agent clients: who is connected, since when, last seen
// when, and whether they've been ended. Backed by lib/management/records.ts.
//
// A human session is one sign-in (its `sid` is inside the signed session
// cookie, see lib/auth-tokens.ts). An agent client is one agent connection a
// user authorised (its `cid` is inside the bearer token). Ending either is
// enforced on the next request by lib/management/auth.ts.
import type { Role } from "@/lib/auth";
import { getRecord, listEntries, listRecords, putRecord, putRecordIfAbsent } from "./records";

/** Activity within this window counts as a live connection. */
export const CONNECTED_WINDOW_MS = 5 * 60 * 1000;
/** Don't write a heartbeat more often than this per id. */
const TOUCH_THROTTLE_MS = 60 * 1000;

export interface HumanSession {
  sid: string;
  userId: string;
  /** Role at sign-in; a demo role switch keeps the same session. */
  role: Role;
  startedAt: string;
  ip?: string;
  userAgent?: string;
  /** Auto-provisioned by DEMO_MODE rather than a real sign-in. */
  provisioned?: boolean;
}

export interface AgentClient {
  clientId: string;
  userId: string;
  role: Role;
  /** "default": the per-session token shown in the Agent panel.
   *  "connected": minted explicitly with a label via /api/agent-clients. */
  kind: "default" | "connected" | "legacy";
  label?: string;
  /** Human session that authorised it. */
  sid?: string;
  createdAt: string;
}

export interface EndRecord {
  at: string;
  reason: "logout" | "revoked";
  /** userId of whoever ended it. */
  by?: string;
}

export interface SeenRecord {
  at: string;
  ip?: string;
  userAgent?: string;
}

/** Agent software as reported by the client (MCP clientInfo). Self-declared. */
export interface SoftwareRecord {
  name?: string;
  version?: string;
  at: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __mgmtTouched: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __mgmtSoftware: Map<string, string> | undefined;
}

function touched(): Map<string, number> {
  return (globalThis.__mgmtTouched ??= new Map());
}

// ── Writes ───────────────────────────────────────────────────────────────────

export function recordSession(session: HumanSession): Promise<boolean> {
  return putRecordIfAbsent("sessions", session.sid, session);
}

export function recordClient(client: AgentClient): Promise<boolean> {
  return putRecordIfAbsent("clients", client.clientId, client);
}

/** End a session or client. The first end wins: a later logout can't turn a
 *  revocation into a mere logout. */
export async function endRecord(id: string, reason: EndRecord["reason"], by?: string): Promise<boolean> {
  touched().delete(id);
  return putRecordIfAbsent("ended", id, { at: new Date().toISOString(), reason, by });
}

/**
 * Heartbeat. Returns true when it actually wrote (at most once a minute per id
 * per instance) — callers use that as the cue to also make sure the
 * session/client record exists, so the per-request cost stays one read.
 */
export async function touch(id: string, seen: Omit<SeenRecord, "at"> = {}, now = Date.now()): Promise<boolean> {
  const last = touched().get(id);
  if (last !== undefined && now - last < TOUCH_THROTTLE_MS) return false;
  touched().set(id, now);
  await putRecord("seen", id, { ...seen, at: new Date(now).toISOString() });
  return true;
}

/** Remember which agent software a client runs. Written when it changes (per
 *  instance), so it costs nothing on the steady-state call path. */
export async function noteAgentSoftware(clientId: string, name?: string, version?: string): Promise<void> {
  if (!name && !version) return;
  const key = `sw:${clientId}`;
  const sig = `${name ?? ""}@${version ?? ""}`;
  const mem = (globalThis.__mgmtSoftware ??= new Map<string, string>());
  if (mem.get(key) === sig) return;
  mem.set(key, sig);
  await putRecord("software", clientId, { name, version, at: new Date().toISOString() });
}

// ── Reads ────────────────────────────────────────────────────────────────────

export function getEnd(id: string): Promise<EndRecord | null> {
  return getRecord<EndRecord>("ended", id);
}

export interface Liveness {
  lastSeenAt?: string;
  endedAt?: string;
  endReason?: EndRecord["reason"];
  endedBy?: string;
  /** Not ended and seen within CONNECTED_WINDOW_MS. */
  connected: boolean;
}

async function livenessIndex(): Promise<{
  ended: Map<string, EndRecord>;
  seen: Map<string, SeenRecord & { id: string }>;
}> {
  const [ends, seens] = await Promise.all([
    listRecordsWithIds<EndRecord>("ended"),
    listRecordsWithIds<SeenRecord>("seen"),
  ]);
  return { ended: new Map(ends.map((e) => [e.id, e])), seen: new Map(seens.map((s) => [s.id, s])) };
}

/** Ended/seen values don't carry their own id (it's the hash field). */
async function listRecordsWithIds<T>(kind: "ended" | "seen"): Promise<(T & { id: string })[]> {
  return (await listEntries<T>(kind)).map(([id, v]) => ({ ...v, id }));
}

function liveness(id: string, idx: Awaited<ReturnType<typeof livenessIndex>>, now: number) {
  const end = idx.ended.get(id);
  const seen = idx.seen.get(id);
  return {
    seen,
    live: {
      lastSeenAt: seen?.at,
      endedAt: end?.at,
      endReason: end?.reason,
      endedBy: end?.by,
      connected: !end && !!seen && now - Date.parse(seen.at) < CONNECTED_WINDOW_MS,
    } satisfies Liveness,
  };
}

export type SessionView = HumanSession & Liveness & { ip?: string; userAgent?: string };
export type ClientView = AgentClient & Liveness & { agentName?: string; agentVersion?: string };

export async function listSessions(filter: { userId?: string } = {}, now = Date.now()): Promise<SessionView[]> {
  const [sessions, idx] = await Promise.all([listRecords<HumanSession>("sessions"), livenessIndex()]);
  return sessions
    .filter((s) => !filter.userId || s.userId === filter.userId)
    .map((s) => {
      const { seen, live } = liveness(s.sid, idx, now);
      return { ...s, ...live, ip: seen?.ip ?? s.ip, userAgent: seen?.userAgent ?? s.userAgent };
    })
    .sort((a, b) => (b.lastSeenAt ?? b.startedAt).localeCompare(a.lastSeenAt ?? a.startedAt));
}

export async function listClients(filter: { userId?: string } = {}, now = Date.now()): Promise<ClientView[]> {
  const [clients, idx, software] = await Promise.all([
    listRecords<AgentClient>("clients"),
    livenessIndex(),
    listEntries<SoftwareRecord>("software"),
  ]);
  const sw = new Map(software);
  return clients
    .filter((c) => !filter.userId || c.userId === filter.userId)
    .map((c) => {
      const { live } = liveness(c.clientId, idx, now);
      const s = sw.get(c.clientId);
      return { ...c, ...live, agentName: s?.name, agentVersion: s?.version };
    })
    .sort((a, b) => (b.lastSeenAt ?? b.createdAt).localeCompare(a.lastSeenAt ?? a.createdAt));
}

export function getClient(clientId: string): Promise<AgentClient | null> {
  return getRecord<AgentClient>("clients", clientId);
}

export function getSession(sid: string): Promise<HumanSession | null> {
  return getRecord<HumanSession>("sessions", sid);
}
