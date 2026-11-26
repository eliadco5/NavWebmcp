import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { searchTree } from "@/lib/modules";
import { registry } from "./registry";
import { ShortText, SearchFnSchema, ModuleNodeSchema } from "./schemas";

export const search = defineOperation({
  name: "search",
  title: "Search",
  description:
    "Find functions and modules by glob over 'module/path/function' ('**' any depth, '*' one segment, '?' one char). " +
    "A bare word means '**/*word*'.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    pattern: ShortText(200)
      .min(1)
      .describe('e.g. "*refund*", "finance/**", or "reservation"'),
  },
  outputSchema: {
    functions: z.array(SearchFnSchema),
    modules: z.array(ModuleNodeSchema),
  },
  async handler({ pattern }, ctx) {
    return ok(searchTree(pattern, ctx.role, registry));
  },
});
