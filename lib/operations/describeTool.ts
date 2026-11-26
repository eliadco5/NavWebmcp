import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { roleSatisfies } from "@/lib/auth";
import { getOpByName } from "./dispatch";
import { suggestOpNames } from "./execute";
import type { Role } from "./types";
import { inputObject, outputObject, toJsonSchema } from "@/lib/schema";
import { ShortText, DescribedToolSchema } from "./schemas";
import { creditCost } from "@/lib/credits/policy";
import { isIdempotentOp } from "@/lib/idempotency/port";

function describeOne(name: string, role: Role): z.infer<typeof DescribedToolSchema> {
  const op = getOpByName().get(name);
  if (!op) {
    const suggestions = suggestOpNames(name, role);
    return { name, error: "UNKNOWN_TOOL", message: `No operation named '${name}'.`, ...(suggestions.length > 0 ? { suggestions } : {}) };
  }
  if (!roleSatisfies(role as never, op.roles)) return { name, error: "FORBIDDEN", message: `Role '${role}' cannot access '${name}'.` };
  return {
    name: op.name, title: op.title, description: op.description,
    permission: op.permission, roles: op.roles, module: op.module,
    requiresConfirmation: op.requiresConfirmation ?? false,
    parallelSafe: op.parallelSafe ?? (op.permission === "read"),
    ...(isIdempotentOp(op) && { idempotent: true as const }),
    credits: creditCost(op),
    inputSchema: toJsonSchema(inputObject(op.inputSchema)),
    outputSchema: toJsonSchema(outputObject(op.outputSchema, op.openOutput)),
  };
}

export const describeTool = defineOperation({
  name: "describe_tool",
  title: "Describe Tool",
  description:
    "Full input and output schemas, and metadata, for one or more functions. Call before invoking one you haven't used.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    name: z
      .union([ShortText(128).min(1), z.array(ShortText(128).min(1)).max(50)])
      .describe("A function name, or an array of names"),
  },
  // A single name returns one entry at the top level; an array returns { tools }.
  outputSchema: {
    ...DescribedToolSchema.partial().shape,
    tools: z.array(DescribedToolSchema).optional().describe("Present when an array of names was requested"),
  },
  async handler({ name }, ctx) {
    if (typeof name === "string") return ok(describeOne(name, ctx.role));
    return ok({ tools: name.map((n) => describeOne(n, ctx.role)) });
  },
});
