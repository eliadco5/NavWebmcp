import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok } from "@/lib/result";
import { ReservationSchema } from "./schemas";

export const listReservations = defineOperation({
  name: "listReservations",
  title: "List Reservations",
  description: "Return all current reservations.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "reservation.search",
  tags: ["booking", "reservation"],
  inputSchema: {},
  outputSchema: {
    reservations: z.array(ReservationSchema).describe("The caller's own reservations"),
    count: z.number().int(),
  },
  async handler(_input, ctx) {
    const reservations = store.getReservations(ctx.userId);
    return ok({ reservations, count: reservations.length });
  },
});
