import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";

declare global {
  var __frontofficeStore:
    | {
        tables: Map<string, { id: string; status: "available" | "occupied" | "reserved"; capacity: number; reservationId?: string; seatedAt?: string; guestId?: string }>;
        reservations: Map<string, { id: string; guestId: string; guestName: string; partySize: number; tableId?: string; status: "pending" | "checked-in" | "checked-out" | "cancelled" }>;
        bills: Map<string, { reservationId: string; tableId: string; items: { name: string; qty: number; price: number }[]; total: number; generatedAt: string }>;
        shiftNotes: { id: string; note: string; author: string; createdAt: string; date: string }[];
      }
    | undefined;
}

const store = globalThis.__frontofficeStore ?? (globalThis.__frontofficeStore = {
  tables: new Map([
    ["t_01", { id: "t_01", status: "available", capacity: 2 }],
    ["t_02", { id: "t_02", status: "occupied", capacity: 4, reservationId: "res_001", seatedAt: new Date(Date.now() - 45 * 60000).toISOString(), guestId: "g_001" }],
    ["t_03", { id: "t_03", status: "available", capacity: 4 }],
    ["t_04", { id: "t_04", status: "reserved", capacity: 6, reservationId: "res_002" }],
    ["t_05", { id: "t_05", status: "available", capacity: 2 }],
  ]),
  reservations: new Map([
    ["res_001", { id: "res_001", guestId: "g_001", guestName: "Alice Martin", partySize: 2, tableId: "t_02", status: "checked-in" }],
    ["res_002", { id: "res_002", guestId: "g_002", guestName: "Bob Chen", partySize: 5, status: "pending" }],
    ["res_003", { id: "res_003", guestId: "g_003", guestName: "Carol Diaz", partySize: 3, status: "pending" }],
  ]),
  bills: new Map(),
  shiftNotes: [
    { id: "sn_001", note: "VIP guest at t_02, allergic to nuts.", author: "support_jane", createdAt: new Date(Date.now() - 2 * 3600000).toISOString(), date: new Date().toISOString().slice(0, 10) },
    { id: "sn_002", note: "POS terminal 3 rebooted, all clear.", author: "support_mike", createdAt: new Date(Date.now() - 1 * 3600000).toISOString(), date: new Date().toISOString().slice(0, 10) },
  ],
});

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
