import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { getNode, expandWildcard, platformManifest } from "@/lib/modules";
import { registry } from "./registry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const explore = defineOperation<any, any>({
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
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Module path(s). Omit for platform overview. Supports dot-paths, wildcards, or arrays."),
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
    const results = path.map((p: string) => {
      if (p === "*" || p.endsWith(".*")) return { path: p, nodes: expandWildcard(p, role, registry) };
      const node = getNode(p, role, registry);
      if (!node) return { path: p, error: `Module '${p}' not found.` };
      return node;
    });
    return ok({ results });
  },
});
