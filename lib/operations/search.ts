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
    "Find functions and modules by Linux-style path glob. " +
    "Patterns match against synthesized 'module/path/functionName' strings. " +
    "'**' crosses segment boundaries; '*' matches within one segment; '?' matches one char. " +
    "A bare keyword (no metachar, no slash) is treated as '**/*keyword*'. " +
    "Use search() when you know *what* you need but not *where* in the tree it lives. " +
    "Use explore() when you want to navigate a known module path.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    pattern: ShortText(200)
      .min(1)
      .describe(
        "Linux-style glob matched against module/function paths. " +
        "Examples: \"**/*reservation*\", \"finance/**\", \"*refund*\", or a bare keyword like \"reservation\"."
      ),
  },
  outputSchema: {
    functions: z.array(SearchFnSchema),
    modules: z.array(ModuleNodeSchema),
  },
  async handler({ pattern }, ctx) {
    return ok(searchTree(pattern, ctx.role, registry));
  },
});
