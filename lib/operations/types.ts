import { z } from "zod";
import type { ActionPreview, Result } from "@/lib/result";
import type { Role } from "@/lib/auth";
import { IDEMPOTENCY_KEY_FIELD, IdempotencyKeySchema, isIdempotentOp } from "@/lib/idempotency/port";
import {
  CONFIRMATION_TOKEN_FIELD, ConfirmationTokenSchema, DRY_RUN_FIELD, DryRunSchema, type ApprovedBy,
} from "@/lib/confirmation/port";
import { installList, type ListInfo, type ListSpec } from "./paging";

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
  /** The human sign-in session behind this call (lib/management/sessions.ts). */
  sessionId?: string;
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
  /** Credits the caller asks for (SMB CreditRequest). Optional: without it the
   *  server hands back what the call cost, minus load. */
  creditRequest?: number;
  /** Nesting depth: 0 for the top-level call, +1 per nested level. Set by execute(). */
  depth?: number;
  /** Shared by every call of one request (by reference): how many operations
   *  ran underneath the top-level one. Set by execute(); caps fan-out. */
  fanout?: { count: number };
  /** The idempotency key this call runs under (its own idempotencyKey, or one
   *  derived from its parent's for a write inside a keyed composite). Set by
   *  execute(); never inherited as-is. */
  idempotencyKey?: string;
  /** True when execute() answered from a stored result instead of running. */
  idempotencyReplayed?: boolean;
  /** Per call: how many nested writes of each op it has started, so derived
   *  child keys are stable across retries. Set by execute(). */
  childKeySeq?: Map<string, number>;
  /** How this destructive call was approved (2.6.0). Set by execute(); per call. */
  approvedBy?: ApprovedBy;
  /** This call ran as a dryRun: preview only, nothing written. Per call. */
  dryRun?: boolean;
  /** The user's answer to an MCP elicitation for this request, and the
   *  confirmation tokens it was about. Set by the MCP adapter; inherited by
   *  nested calls, and each token still only matches the one call it was
   *  minted for. */
  elicitation?: { approved: boolean; tokens: readonly string[] };
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
  /** The success `data` may carry keys beyond `outputSchema` (invoke relays another
   *  op's data verbatim). Published as `additionalProperties: true`. */
  openOutput?: boolean;
  tags?: string[];
  module?: string;                // dot-path of owning leaf module (e.g. "reservation.booking")
  parallelSafe?: boolean;         // defaults: read=true, write=false
  alwaysOn?: boolean;             // always registered regardless of loaded-tools selection
  /** In the in-page (WebMCP) surface, served by the page's own UiComponentRegistry
   *  (lib/ui-components/local.ts) instead of POST /api/call. `handler` is the
   *  server implementation, used by MCP clients through the UI relay. */
  runsInPage?: boolean;
  /** Credit metering (lib/credits, docs/credits.md). `weight` replaces the
   *  default base cost (read 1, write 2); a composite sets it to the number of
   *  operations it runs. */
  credits?: { weight?: number };
  /** Longest the handler may run before execute() gives up with HANDLER_TIMEOUT.
   *  Defaults to OP_DEADLINE_MS (15 s). */
  deadlineMs?: number;
  /** SOC2 audit tuning (lib/audit). Both optional: defaults redact known
   *  PII/secret keys and infer the target record from ids in input/output. */
  audit?: {
    /** Extra input/output keys whose values must not be stored. */
    redact?: string[];
    /** The record this call acts on. Return null for "none". */
    target?: (input: Record<string, unknown>, output: unknown) => { type: string; id: string } | null | undefined;
  };
  handler: (
    input: z.infer<z.ZodObject<TShape>>,
    ctx: OperationContext
  ) => Promise<Result<z.infer<z.ZodObject<TOutShape>>>>;
  /** What the write would do, without doing it (2.6.0): shown on
   *  CONFIRMATION_REQUIRED and returned by dryRun. A failure (NOT_FOUND, say)
   *  is returned as is, so nobody is asked to approve an impossible action.
   *  Optional: without one, a generic preview lists the arguments. */
  preview?: (
    input: z.infer<z.ZodObject<TShape>>,
    ctx: OperationContext
  ) => Promise<Result<ActionPreview>>;
  /** A list operation (2.7.0): `limit`, `cursor` and `fields` are published on
   *  it and execute() pages the handler's full result. All optional for the
   *  caller: without them the full list comes back, as before. */
  list?: ListSpec;
  /** Filled by defineOperation from `list`; read by execute(). */
  listInfo?: ListInfo;
}

/** Writes that accept dryRun: every write that runs on the server (the same
 *  set that accepts idempotencyKey). */
export const acceptsDryRun = isIdempotentOp;

export function defineOperation<
  TShape extends z.ZodRawShape,
  TOutShape extends z.ZodRawShape,
>(op: Operation<TShape, TOutShape>): Operation<TShape, TOutShape> {
  // Idempotency keys (2.1.0) are injected here, once, rather than added to every
  // write op's schema by hand: the field is published wherever the input schema
  // is (MCP, describe_tool, getCapabilities' hash, WebMCP) and the strict-input
  // check accepts it. execute() strips it before the handler runs.
  if (isIdempotentOp(op) && !(IDEMPOTENCY_KEY_FIELD in op.inputSchema)) {
    (op.inputSchema as z.ZodRawShape)[IDEMPOTENCY_KEY_FIELD] = IdempotencyKeySchema().optional();
  }
  // Previews and confirmation tokens (2.6.0), injected the same way.
  if (acceptsDryRun(op) && !(DRY_RUN_FIELD in op.inputSchema)) {
    (op.inputSchema as z.ZodRawShape)[DRY_RUN_FIELD] = DryRunSchema().optional();
  }
  if (op.requiresConfirmation && !(CONFIRMATION_TOKEN_FIELD in op.inputSchema)) {
    (op.inputSchema as z.ZodRawShape)[CONFIRMATION_TOKEN_FIELD] = ConfirmationTokenSchema().optional();
  }
  // Optional pagination and field selection (2.7.0).
  if (op.list && !op.listInfo) {
    op.listInfo = installList(op.name, op.list, op.inputSchema, op.outputSchema);
  }
  return op;
}
