import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok } from "@/lib/result";
import { ReservationSchema, ReservationStatus } from "./schemas";

export const listReservations = defineOperation({
  name: "listReservations",
  title: "List Reservations",
  description: "Return all current reservations.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "reservation.search",
  tags: ["booking", "reservation"],
  list: { key: "reservations", id: "id" },
  inputSchema: {
    status: ReservationStatus.optional().describe("Only reservations with this status"),
  },
  outputSchema: {
    reservations: z.array(ReservationSchema).describe("The caller's own reservations"),
    count: z.number().int(),
  },
  async handler({ status }, ctx) {
    const reservations = store.getReservations(ctx.userId).filter((r) => status === undefined || r.status === status);
    return ok({ reservations, count: reservations.length });
  },
});
