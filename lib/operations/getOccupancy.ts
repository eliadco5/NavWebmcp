import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { frontofficeStore } from "@/lib/seed";

const store = frontofficeStore();

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
