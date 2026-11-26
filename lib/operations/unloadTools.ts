import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { removeLoaded } from "@/lib/loadedTools";
import { ShortText } from "./schemas";

export const unloadTools = defineOperation({
  name: "unload_tools",
  title: "Unload Tools",
  description: "Remove functions added by load_tools. Re-fetch tools/list after.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    names: z.array(ShortText(128).min(1)).min(1).max(50).describe("Function names"),
  },
  outputSchema: {
    removed: z.array(z.string()),
    message: z.string(),
  },
  async handler({ names }, ctx) {
    removeLoaded(ctx.token, names);
    return ok({ removed: names, message: `Unloaded ${names.length} tool(s). Re-fetch tools/list to confirm removal.` });
  },
});
