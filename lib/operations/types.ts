import { z } from "zod";
import type { Result } from "@/lib/result";
import type { Role } from "@/lib/auth";

export type { Role };
export type Permission = "read" | "write";

/** Which surface a call arrived through. */
export type Channel = "ui" | "webmcp" | "mcp" | "internal";

/** Who is acting: a person clicking in the UI, an AI agent acting on a
 *  person's behalf, or the platform itself (seed data, scheduled jobs). */
export type ActorType = "human" | "agent" | "system";

/** How much the server trusts the actor classification. MCP calls carry a
 *  server-minted bearer token ("verified"); the WebMCP/UI split on /api/call
 *  is declared by the browser ("asserted") — fine for telemetry, and recorded
 *  as such so an auditor can tell the two apart. */
export type ActorAssurance = "verified" | "asserted";

export interface AgentIdentity {
  clientId: string;
  name?: string;
  version?: string;
  sessionId?: string;
}

export interface Actor {
  type: ActorType;
  /** The accountable human principal. For agents, the user who authorised it. */
  userId: string;
  role: Role;
  assurance: ActorAssurance;
  agent?: AgentIdentity;
}

export interface CallMeta {
  /** One per top-level request; shared by every nested call it fans out to. */
  requestId: string;
  /** One per operation invocation. Absent on the request-level context a
   *  surface builds; execute() assigns it, and a nested call made from inside
   *  a handler sees it as its parent. */
  callId?: string;
  /** Set on calls made by another operation (invoke, composites). */
  parentCallId?: string;
  channel: Channel;
  ip?: string;
  userAgent?: string;
}

export interface OperationContext {
  userId: string;
  role: Role;
  token: string;
  /** Filled by execute() when the caller didn't supply one (tests, scripts). */
  actor?: Actor;
  meta?: CallMeta;
}

export interface Operation<
  TShape extends z.ZodRawShape = z.ZodRawShape,
  TOutShape extends z.ZodRawShape = z.ZodRawShape,
> {
  name: string;
  title: string;
  description: string;
  inputSchema: TShape;
  /** Shape of the success `data`. Published as MCP `outputSchema` and, wrapped
   *  in the Result envelope, as the WebMCP `outputSchema`. */
  outputSchema: TOutShape;
  permission: Permission;
  roles: Role[];                  // which roles may call this operation
  requiresConfirmation?: boolean;
  /** Output contains free text written by users/staff (WebMCP untrustedContentHint). */
  untrustedOutput?: boolean;
  /** Runs other operations by name (invoke). Its annotations must not claim read-only,
   *  whatever `permission` says, since it can reach any write or destructive op. */
  dispatchesOps?: boolean;
  tags?: string[];
  module?: string;                // dot-path of owning leaf module (e.g. "reservation.booking")
  parallelSafe?: boolean;         // defaults: read=true, write=false
  alwaysOn?: boolean;             // always registered regardless of loaded-tools selection
  /** In the in-page (WebMCP) surface, served by the page's own UiComponentRegistry
   *  (lib/ui-components/local.ts) instead of POST /api/call. `handler` is the
   *  server implementation, used by MCP clients through the UI relay. */
  runsInPage?: boolean;
  handler: (
    input: z.infer<z.ZodObject<TShape>>,
    ctx: OperationContext
  ) => Promise<Result<z.infer<z.ZodObject<TOutShape>>>>;
}

export function defineOperation<
  TShape extends z.ZodRawShape,
  TOutShape extends z.ZodRawShape,
>(op: Operation<TShape, TOutShape>): Operation<TShape, TOutShape> {
  return op;
}
