import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { crmGuests } from "@/lib/seed";

const guestsMap = crmGuests();

export const searchGuests = defineOperation({
  name: "searchGuests",
  title: "Search Guests",
  description: "Search guest profiles by name or email. Returns matching guest records.",
  permission: "read",
  roles: ["support", "admin"],
  module: "crm.guests",
  inputSchema: {
    query: z.string().describe("Name or email search term"),
  },
  async handler({ query }, ctx) {
    const q = query.toLowerCase();
    const results = Array.from(guestsMap.values()).filter(
      (g) => g.name.toLowerCase().includes(q) || g.email.toLowerCase().includes(q)
    );
    return ok({ guests: results, total: results.length });
  },
});
