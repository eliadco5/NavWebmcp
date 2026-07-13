import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { roleSatisfies } from "@/lib/auth";
import { registry } from "./registry";
import { zodToJsonSchema } from "zod-to-json-schema";

function describeOne(name: string, role: string) {
  const op = registry.find((o) => o.name === name);
  if (!op) return { name, error: "UNKNOWN_TOOL", message: `No operation named '${name}'.` };
  if (!roleSatisfies(role as never, op.roles)) return { name, error: "FORBIDDEN", message: `Role '${role}' cannot access '${name}'.` };
  const jsonSchema = zodToJsonSchema(z.object(op.inputSchema as Record<string, z.ZodTypeAny>), { $refStrategy: "none" });
  return {
    name: op.name, title: op.title, description: op.description,
    permission: op.permission, roles: op.roles, module: op.module,
    requiresConfirmation: op.requiresConfirmation ?? false,
    parallelSafe: op.parallelSafe ?? (op.permission === "read"),
    inputSchema: jsonSchema,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const describeTool = defineOperation<any, any>({
  name: "describe_tool",
  title: "Describe Tool",
  description: "Return the full input schema and metadata for one or more functions by name. Use after explore() to get exact parameters before invoking.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    name: z.union([z.string(), z.array(z.string())]).describe("Function name or array of names to describe."),
  },
  async handler({ name }, ctx) {
    if (typeof name === "string") return ok(describeOne(name, ctx.role));
    return ok({ tools: name.map((n: string) => describeOne(n, ctx.role)) });
  },
});
