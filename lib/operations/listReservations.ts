import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok } from "@/lib/result";

export const listReservations = defineOperation({
  name: "listReservations",
  title: "List Reservations",
  description: "Return all current reservations.",
  permission: "read",
  tags: ["booking", "reservation"],
  inputSchema: {},
  async handler(_input) {
    const reservations = store.getReservations();
    return ok({ reservations, count: reservations.length });
  },
});
