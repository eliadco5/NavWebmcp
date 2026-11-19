import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { store } from "@/lib/store";
import { z } from "zod";

// Average dining duration in minutes used for turnover estimate
const AVG_DINING_MINUTES = 60;

export const getOccupancy = defineOperation({
  name: "getOccupancy",
  title: "Get Occupancy",
  description: "Real-time view of all tables: occupied, available, and estimated wait time.",
  permission: "read",
  roles: ["support", "admin"],
  module: "frontoffice.occupancy",
  inputSchema: {},
  outputSchema: {
    tables: z.array(z.object({
      tableId: z.string(),
      status: z.enum(["available", "occupied", "reserved"]),
      capacity: z.number().int(),
      reservationId: z.string().nullable(),
      seatedAt: z.string().nullable(),
      minutesSeated: z.number().int().nullable(),
      estimatedAvailableIn: z.number().int().nullable().describe("Minutes until the table is expected to free up"),
    })),
    summary: z.object({
      total: z.number().int(),
      available: z.number().int(),
      occupied: z.number().int(),
      reserved: z.number().int(),
    }),
  },
  async handler(_input, _ctx) {
    const now = Date.now();
    const tableList = Array.from(store.tables.values()).map((table) => {
      let minutesSeated: number | null = null;
      let estimatedAvailableIn: number | null = null;

      if (table.status === "occupied" && table.seatedAt) {
        minutesSeated = Math.floor((now - new Date(table.seatedAt).getTime()) / 60000);
        estimatedAvailableIn = Math.max(0, AVG_DINING_MINUTES - minutesSeated);
      }

      return {
        tableId: table.id,
        status: table.status,
        capacity: table.capacity,
        reservationId: table.reservationId ?? null,
        seatedAt: table.seatedAt ?? null,
        minutesSeated,
        estimatedAvailableIn,
      };
    });

    const available = tableList.filter((t) => t.status === "available").length;
    const occupied = tableList.filter((t) => t.status === "occupied").length;
    const reserved = tableList.filter((t) => t.status === "reserved").length;

    return ok({ tables: tableList, summary: { total: tableList.length, available, occupied, reserved } });
  },
});
