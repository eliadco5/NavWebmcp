import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { crmGuests } from "@/lib/seed";
import { ShortText, GuestSchema } from "./schemas";

const guestsMap = crmGuests();

export const searchGuests = defineOperation({
  name: "searchGuests",
  title: "Search Guests",
  description: "Search guest profiles by name or email. Returns matching guest records.",
  permission: "read",
  roles: ["support", "admin"],
  module: "crm.guests",
  list: { key: "guests", id: "guestId" },
  inputSchema: {
    query: ShortText().describe("Name or email search term"),
  },
  outputSchema: {
    guests: z.array(GuestSchema),
    total: z.number().int(),
  },
  untrustedOutput: true,
  async handler({ query }, ctx) {
    const q = query.toLowerCase();
    const results = Array.from(guestsMap.values()).filter(
      (g) => g.name.toLowerCase().includes(q) || g.email.toLowerCase().includes(q)
    );
    return ok({ guests: results, total: results.length });
  },
});
