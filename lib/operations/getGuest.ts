import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";
import { crmGuests } from "@/lib/seed";

const guestsMap = crmGuests();

export const getGuest = defineOperation({
  name: "getGuest",
  title: "Get Guest",
  description: "Retrieve a guest profile by guest ID.",
  permission: "read",
  roles: ["support", "admin"],
  module: "crm.guests",
  inputSchema: {
    guestId: z.string().describe("The unique guest identifier"),
  },
  async handler({ guestId }, ctx) {
    const guest = guestsMap.get(guestId);
    if (!guest) return fail("NOT_FOUND", `Guest ${guestId} not found`);
    return ok({ guest });
  },
});
