import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { getUserById } from "@/lib/auth";
import { credits } from "@/lib/credits/port";
import { z } from "zod";
import { RoleSchema } from "./schemas";

/** The platform keeps every date in UTC (stores, seed data, "today" defaults all
 *  use toISOString().slice(0, 10)), so that is the timezone agents must resolve
 *  relative dates ("tomorrow", "next Friday") against. */
export const PLATFORM_TIMEZONE = "UTC";

export const getContext = defineOperation({
  name: "getContext",
  title: "Get Context",
  description:
    "Return the caller's context: who they are, their role, the platform's current date and time, and " +
    "your current credit balance (calls cost credits by type, size and run time). " +
    "Resolve relative dates (\"tomorrow\", \"tonight\") against `today` and `timezone`, never against your own clock.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  tags: ["context"],
  inputSchema: {},
  outputSchema: {
    page: z.string().nullable().describe("The UI page the user is on; null when the server cannot know it (MCP, API calls)"),
    authenticated: z.boolean(),
    locale: z.string().describe("BCP 47 locale for user-facing text"),
    user: z.object({ id: z.string(), displayName: z.string() }).nullable(),
    role: RoleSchema.describe("The caller's role; it decides which operations are visible"),
    now: z.string().describe("Current platform time, ISO 8601 in UTC"),
    today: z.string().describe("Current platform date, YYYY-MM-DD in `timezone`"),
    timezone: z.string().describe("IANA timezone that every date and time on this platform is in"),
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
    const now = new Date();
    return ok({
      // The server never sees the browser's page; a fixed "booking" here misled
      // MCP agents into thinking the user was looking at a booking screen.
      page: null,
      authenticated: true,
      locale: "en-US",
      user: user ? { id: user.id, displayName: user.displayName } : null,
      role: ctx.role,
      now: now.toISOString(),
      today: now.toISOString().slice(0, 10),
      timezone: PLATFORM_TIMEZONE,
      ...(snapshot && { credits: snapshot }),
    });
  },
});
