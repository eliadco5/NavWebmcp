import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok } from "@/lib/result";
import { z } from "zod";
import { ReservationSchema } from "./schemas";

export const listAllReservations = defineOperation({
  name: "listAllReservations",
  title: "List All Reservations",
  description: "Return all reservations across all users. Available to support and admin roles only.",
  permission: "read",
  roles: ["support", "admin"],
  module: "reservation.admin",
  tags: ["booking", "reservation", "admin"],
  inputSchema: {},
  outputSchema: {
    reservations: z.array(ReservationSchema),
    count: z.number().int(),
  },
  async handler(_input, _ctx) {
    const reservations = store.getAllReservations();
    return ok({ reservations, count: reservations.length });
  },
});
