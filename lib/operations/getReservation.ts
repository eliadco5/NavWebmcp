import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok, fail } from "@/lib/result";

export const getReservation = defineOperation({
  name: "getReservation",
  title: "Get Reservation",
  description: "Look up a specific reservation by ID.",
  permission: "read",
  tags: ["booking", "reservation"],
  inputSchema: {
    reservationId: z.string().describe("ID of the reservation to retrieve"),
  },
  async handler({ reservationId }) {
    const reservation = store.getReservation(reservationId);
    if (!reservation) return fail("NOT_FOUND", `Reservation ${reservationId} not found`);
    return ok({ reservation });
  },
});
