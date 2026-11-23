// Input schemas shared by the /api/admin/* routes and the admin.* operations,
// so a filter means the same thing on both surfaces. Client-safe (zod only).
import { z } from "zod";

const Str = (max = 100) => z.string().min(1).max(max);
const Iso = () => z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "Must be an ISO date/time");

export const AuditQueryShape = {
  userId: Str(64).optional().describe("Accountable user (for agents: who authorised it)"),
  actorType: z.enum(["human", "agent", "system"]).optional().describe("human = a person in the app; agent = an AI agent acting for a user; system = the platform"),
  channel: z.enum(["ui", "webmcp", "mcp", "internal"]).optional().describe("Surface: ui (app), webmcp (in-page agent), mcp (external agent), internal"),
  category: z.enum(["operation", "auth", "admin"]).optional().describe("operation = a business call; auth = sign-in and credentials; admin = management actions"),
  action: Str(64).optional().describe("Operation name, or e.g. auth.login / admin.agent_client_revoked"),
  outcome: z.enum(["success", "failure", "denied"]).optional().describe("denied = stopped by an access control"),
  targetType: Str(40).optional().describe("e.g. reservation, guest, task, session, agentClient"),
  targetId: Str(64).optional().describe("Record id, with targetType"),
  clientId: Str(64).optional().describe("Agent client id"),
  sessionId: Str(64).optional().describe("Human sign-in session id"),
  requestId: Str(64).optional().describe("All calls of one request (a composite and its nested calls)"),
  since: Iso().optional().describe("Only events at or after this ISO time"),
  until: Iso().optional().describe("Only events at or before this ISO time"),
  beforeSeq: z.number().int().positive().optional().describe("Cursor: nextBeforeSeq from the previous page"),
  limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
};
export const AuditQuerySchema = z.object(AuditQueryShape).strict();

export const UsageQueryShape = {
  from: Iso().optional().describe("Default: 24h before `to`"),
  to: Iso().optional().describe("Default: now"),
  topOperations: z.number().int().min(1).max(100).optional().describe("Default 20"),
};
export const UsageQuerySchema = z.object(UsageQueryShape).strict();

/** URLSearchParams → plain object, numbers coerced for the numeric fields. */
export function paramsToObject(params: URLSearchParams, numeric: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of params) {
    if (v === "") continue;
    out[k] = numeric.includes(k) ? Number(v) : v;
  }
  return out;
}

export function issues(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}
