import { z } from "zod";
import type { Result } from "@/lib/result";

export type Permission = "read" | "write";

export interface Operation<
  TShape extends z.ZodRawShape = z.ZodRawShape,
  TOut = unknown,
> {
  name: string;
  title: string;
  description: string;
  inputSchema: TShape;
  permission: Permission;
  requiresConfirmation?: boolean;
  tags?: string[];
  handler: (input: z.infer<z.ZodObject<TShape>>) => Promise<Result<TOut>>;
}

export function defineOperation<
  TShape extends z.ZodRawShape,
  TOut,
>(op: Operation<TShape, TOut>): Operation<TShape, TOut> {
  return op;
}
