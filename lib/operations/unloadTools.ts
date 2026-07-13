import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { removeLoaded } from "@/lib/loadedTools";

export const unloadTools = defineOperation({
  name: "unload_tools",
  title: "Unload Tools",
  description: "Remove previously promoted functions from the native tool list. After calling, re-fetch tools/list to confirm removal.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    names: z.array(z.string()).min(1).describe("Function names to remove from native tools"),
  },
  async handler({ names }, ctx) {
    removeLoaded(ctx.token, names);
    return ok({ removed: names, message: `Unloaded ${names.length} tool(s). Re-fetch tools/list to confirm removal.` });
  },
});
