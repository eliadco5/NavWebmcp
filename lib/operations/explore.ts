import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { getNode, expandWildcard, platformManifest } from "@/lib/modules";
import { registry } from "./registry";
import { ShortText, ModuleNodeSchema, ExploreNodeSchema } from "./schemas";

export const explore = defineOperation({
  name: "explore",
  title: "Explore",
  description:
    "Navigate the platform's module tree. " +
    "No path → platform overview and top-level modules. " +
    "Dot-path (e.g. 'reservation.booking') → sub-modules and functions. " +
    "'x.*' → all descendants of x. '*' → entire tree. " +
    "Array of paths → fetch multiple nodes in one call.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  inputSchema: {
    path: z
      .union([ShortText(128), z.array(ShortText(128)).max(50)])
      .optional()
      .describe("Module path(s). Omit for platform overview. Supports dot-paths, wildcards, or arrays."),
  },
  // Exactly one group of fields is present, depending on the form of `path`:
  // none → app/description/modules; one path → a node; "x.*" → nodes; array → results.
  outputSchema: {
    app: z.string().optional().describe("Platform name (overview form)"),
    description: z.string().optional(),
    modules: z.array(ModuleNodeSchema).optional().describe("Top-level modules (overview form)"),
    ...ExploreNodeSchema.omit({ description: true }).partial().shape,
    nodes: z.array(ExploreNodeSchema).optional().describe("Descendants (wildcard form)"),
    results: z
      .array(z.union([
        ExploreNodeSchema,
        z.object({ path: z.string(), nodes: z.array(ExploreNodeSchema) }),
        z.object({ path: z.string(), error: z.string() }),
      ]))
      .optional()
      .describe("One entry per requested path (array form)"),
  },
  async handler({ path }, ctx) {
    const role = ctx.role;
    if (path === undefined || path === null) return ok(platformManifest(role, registry));
    if (typeof path === "string" && (path === "*" || path.endsWith(".*"))) {
      return ok({ nodes: expandWildcard(path, role, registry) });
    }
    if (typeof path === "string") {
      const node = getNode(path, role, registry);
      if (!node) return fail("NOT_FOUND", `Module '${path}' not found.`);
      return ok(node);
    }
    const results = path.map((p) => {
      if (p === "*" || p.endsWith(".*")) return { path: p, nodes: expandWildcard(p, role, registry) };
      const node = getNode(p, role, registry);
      if (!node) return { path: p, error: `Module '${p}' not found.` };
      return node;
    });
    return ok({ results });
  },
});
