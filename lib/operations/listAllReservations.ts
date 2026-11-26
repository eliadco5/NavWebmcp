import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok } from "@/lib/result";
import { z } from "zod";
import { IsoDate, ReservationSchema, ReservationStatus } from "./schemas";

export const listAllReservations = defineOperation({
  name: "listAllReservations",
  title: "List All Reservations",
  description: "Return all reservations across all users, optionally by status or date range. Available to support and admin roles only.",
  permission: "read",
  roles: ["support", "admin"],
  module: "reservation.admin",
  tags: ["booking", "reservation", "admin"],
  list: { key: "reservations", id: "id" },
  inputSchema: {
    status: ReservationStatus.optional().describe("Only reservations with this status"),
    from: IsoDate().optional().describe("Only reservations on or after this date (YYYY-MM-DD)"),
    to: IsoDate().optional().describe("Only reservations on or before this date (YYYY-MM-DD)"),
  },
  outputSchema: {
    reservations: z.array(ReservationSchema),
    count: z.number().int(),
  },
  async handler({ status, from, to }, _ctx) {
    // An undated (front-desk) reservation is left out once a date range is asked for.
    const reservations = store.getAllReservations().filter((r) =>
      (status === undefined || r.status === status) &&
      (from === undefined || (r.date !== undefined && r.date >= from)) &&
      (to === undefined || (r.date !== undefined && r.date <= to)));
    return ok({ reservations, count: reservations.length });
  },
});
