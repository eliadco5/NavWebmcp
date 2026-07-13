import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { roleSatisfies } from "@/lib/auth";
import { addLoaded } from "@/lib/loadedTools";
import { registry } from "./registry";

export const loadTools = defineOperation({
  name: "load_tools",
  title: "Load Tools",
  description:
    "Promote functions to native MCP tools so they appear in tools/list with full schemas (Path A). " +
    "Use when you'll call the same functions repeatedly. After calling, re-fetch tools/list.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    names: z.array(z.string()).min(1).describe("Function names to promote to native tools"),
  },
  async handler({ names }, ctx) {
    const results: { name: string; status: string; message?: string }[] = [];
    const toLoad: string[] = [];
    for (const name of names) {
      const op = registry.find((o) => o.name === name);
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
