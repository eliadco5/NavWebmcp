import type { Role } from "@/lib/auth";
import type {
  Actor, ActorAssurance, ActorType, AgentIdentity, CallMeta, Channel,
} from "@/lib/operations/types";

export interface AuditEntry {
  id: string;
  timestamp: string;
  operation: string;
  input: Record<string, unknown>;
  /** The op's `data` on success, or its `error` object on failure — what the
   *  platform actually sent back to the caller. Optional only for backwards
   *  compatibility with call sites that predate this field. */
  output?: unknown;
  success: boolean;
  source: "ui" | "agent";
  /** Who and how — set for every call that goes through execute(). Optional
   *  only so older entries (and the legacy record() signature) stay valid. */
  userId?: string;
  role?: Role;
  actorType?: ActorType;
  assurance?: ActorAssurance;
  sessionId?: string;
  agent?: AgentIdentity;
  channel?: Channel;
  requestId?: string;
  callId?: string;
  parentCallId?: string;
  errorCode?: string;
  durationMs?: number;
  /** Set by scopeFeed() on another user's entry: only enough is left to tell
   *  the page that data changed (operation, outcome, time). */
  redacted?: true;
}

/**
 * What one viewer may see of the activity feed (GET /api/audit). Admins see
 * everything. Everyone else sees their own calls in full, and only the bare
 * fact of other users' calls — enough for app/providers.tsx to refresh panels
 * after someone else's write, without exposing anyone else's inputs/outputs.
 */
export function scopeFeed(entries: AuditEntry[], viewer: { id: string; role: Role }): AuditEntry[] {
  if (viewer.role === "admin") return entries;
  return entries.map((e) =>
    e.userId === viewer.id
      ? e
      : { id: e.id, timestamp: e.timestamp, operation: e.operation, success: e.success, source: e.source, input: {}, redacted: true }
  );
}

export interface CallRecord {
  operation: string;
  input: Record<string, unknown>;
  success: boolean;
  output?: unknown;
  actor: Actor;
  meta: CallMeta;
  errorCode?: string;
  durationMs?: number;
}

class AuditLog {
  private entries: AuditEntry[] = [];

  /** Record one operation call with its full actor/channel context. */
  recordCall(c: CallRecord): AuditEntry {
    return this.push({
      id: c.meta.callId ?? crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      operation: c.operation,
      input: c.input,
      output: c.output,
      success: c.success,
      source: c.actor.type === "human" ? "ui" : "agent",
      userId: c.actor.userId,
      role: c.actor.role,
      actorType: c.actor.type,
      assurance: c.actor.assurance,
      sessionId: c.actor.sessionId,
      agent: c.actor.agent,
      channel: c.meta.channel,
      requestId: c.meta.requestId,
      callId: c.meta.callId,
      parentCallId: c.meta.parentCallId,
      errorCode: c.errorCode,
      durationMs: c.durationMs,
    });
  }

  private push(entry: AuditEntry): AuditEntry {
    this.entries.unshift(entry);
    if (this.entries.length > 100) this.entries.pop();
    return entry;
  }

  record(
    operation: string,
    input: Record<string, unknown>,
    success: boolean,
    source: "ui" | "agent" = "ui",
    output?: unknown
  ): AuditEntry {
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      operation,
      input,
      output,
      success,
      source,
    };
    return this.push(entry);
  }

  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  /** For lib/shared-state. Empty means "nothing recorded on this instance yet",
   *  which restore() must be able to distinguish from "never hydrated". */
  snapshot(): AuditEntry[] {
    return [...this.entries];
  }

  /** Restore IN PLACE — see BookingStore.restore() for why. */
  restore(data: AuditEntry[]): void {
    this.entries.length = 0;
    this.entries.push(...data);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __auditLog: AuditLog | undefined;
}

export const auditLog: AuditLog =
  globalThis.__auditLog ?? (globalThis.__auditLog = new AuditLog());
