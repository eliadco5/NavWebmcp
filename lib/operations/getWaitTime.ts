import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { frontofficeStore } from "@/lib/seed";

const store = frontofficeStore();

const AVG_DINING_MINUTES = 60;

export const getWaitTime = defineOperation({
  name: "getWaitTime",
  title: "Get Wait Time",
  description: "Get the current estimated wait time for walk-in guests.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "frontoffice.occupancy",
  inputSchema: {
    partySize: z.number().int().min(1).max(20).describe("Number of guests in the walk-in party"),
  },
  async handler({ partySize }, _ctx) {
    const now = Date.now();

    // Find available tables that fit the party
    const directlyAvailable = Array.from(store.tables.values()).some(
      (t) => t.status === "available" && t.capacity >= partySize
    );

    if (directlyAvailable) {
      return ok({ partySize, estimatedWaitMinutes: 0, tableAvailable: true, message: "A table is available now" });
    }

    // Estimate wait based on nearest table that will free up and fits the party
    let shortestWait = Infinity;
    for (const table of store.tables.values()) {
      if (table.capacity < partySize) continue;
      if (table.status === "occupied" && table.seatedAt) {
        const minutesSeated = Math.floor((now - new Date(table.seatedAt).getTime()) / 60000);
        const remainingMinutes = Math.max(0, AVG_DINING_MINUTES - minutesSeated);
        if (remainingMinutes < shortestWait) shortestWait = remainingMinutes;
      }
    }

    if (shortestWait === Infinity) {
      // All suitable tables are reserved with no seated time info — give a generic estimate
      return ok({ partySize, estimatedWaitMinutes: 30, tableAvailable: false, message: "All suitable tables are reserved; estimated wait is approximately 30 minutes" });
    }

    return ok({ partySize, estimatedWaitMinutes: shortestWait, tableAvailable: false, message: `Estimated wait is approximately ${shortestWait} minutes` });
  },
});
