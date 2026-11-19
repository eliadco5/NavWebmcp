import { z } from "zod";
import type { Result } from "@/lib/result";
import type { Role } from "@/lib/auth";

export type { Role };
export type Permission = "read" | "write";

export interface OperationContext {
  userId: string;
  role: Role;
  token: string;
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
