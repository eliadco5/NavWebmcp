import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { roleSatisfies } from "@/lib/auth";
import { addLoaded } from "@/lib/loadedTools";
import { getOpByName } from "./dispatch";
import { ShortText } from "./schemas";

const LoadStatus = z.enum(["LOADED", "NO_OP", "FORBIDDEN", "UNKNOWN_TOOL"]);

export const loadTools = defineOperation({
  name: "load_tools",
  title: "Load Tools",
  description:
    "Add functions to tools/list as native tools, for ones you'll call often. Re-fetch tools/list after.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    names: z.array(ShortText(128).min(1)).min(1).max(50).describe("Function names"),
  },
  outputSchema: {
    results: z.array(z.object({
      name: z.string(),
      status: LoadStatus,
      message: z.string().optional(),
    })),
    message: z.string(),
  },
  async handler({ names }, ctx) {
    const results: { name: string; status: z.infer<typeof LoadStatus>; message?: string }[] = [];
    const toLoad: string[] = [];
    for (const name of names) {
      const op = getOpByName().get(name);
      if (!op) { results.push({ name, status: "UNKNOWN_TOOL", message: `No operation named '${name}'.` }); continue; }
      if (op.alwaysOn) { results.push({ name, status: "NO_OP", message: "Already always-on." }); continue; }
      if (!roleSatisfies(ctx.role, op.roles)) { results.push({ name, status: "FORBIDDEN", message: `Role '${ctx.role}' cannot access '${name}'.` }); continue; }
      toLoad.push(name);
      results.push({ name, status: "LOADED" });
    }
    if (toLoad.length > 0) addLoaded(ctx.token, toLoad);
    const loaded = results.filter((r) => r.status === "LOADED").length;
    return ok({ results, message: loaded > 0 ? `Loaded ${loaded} tool(s). Re-fetch tools/list to see the promoted tools.` : "No new tools were loaded." });
  },
});
