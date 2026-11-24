import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { getUserById } from "@/lib/auth";
import { credits } from "@/lib/credits/port";
import { z } from "zod";

export const getContext = defineOperation({
  name: "getContext",
  title: "Get Context",
  description:
    "Return current application context: page name, auth status, locale, and your current credit balance " +
    "(calls cost credits by type, size and run time).",
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
    credits: z
      .object({
        balance: z.number().describe("Credits available now"),
        window: z.number().describe("Most credits you may hold right now"),
        maxWindow: z.number().describe("The window grows up to this while your calls stay quick and cheap"),
        refillPerSec: z.number().describe("Credits that trickle back per second"),
        frozen: z.boolean().describe("An administrator has paused this caller"),
      })
      .optional()
      .describe("Absent when calls aren't metered. If a result carries credits.hint, follow it."),
  },
  async handler(_input, ctx) {
    const user = getUserById(ctx.userId);
    const snapshot = ctx.actor ? await credits()?.peek(ctx.actor) : undefined;
    return ok({
      page: "booking",
      authenticated: true,
      locale: "en-US",
      user: user ? { id: user.id, displayName: user.displayName } : null,
      ...(snapshot && { credits: snapshot }),
    });
  },
});
