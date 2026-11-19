import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { getUserById } from "@/lib/auth";
import { z } from "zod";

export const getContext = defineOperation({
  name: "getContext",
  title: "Get Context",
  description: "Return current application context: page name, auth status, locale.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  tags: ["context"],
  inputSchema: {},
  outputSchema: {
    page: z.string(),
    authenticated: z.boolean(),
    locale: z.string(),
    user: z.object({ id: z.string(), displayName: z.string() }).nullable(),
  },
  async handler(_input, ctx) {
    const user = getUserById(ctx.userId);
    return ok({
      page: "booking",
      authenticated: true,
      locale: "en-US",
      user: user ? { id: user.id, displayName: user.displayName } : null,
    });
  },
});
