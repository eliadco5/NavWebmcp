import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok } from "@/lib/result";
import type { Slot } from "@/lib/store";
import { IsoDate, SlotSchema } from "./schemas";

export const searchAvailability = defineOperation({
  name: "searchAvailability",
  title: "Search Availability",
  description:
    "Search available booking slots for a given date and party size. Returns a list of open time slots.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "reservation.availability",
  tags: ["booking", "availability"],
  inputSchema: {
    date: IsoDate().describe("Date to search in YYYY-MM-DD format"),
    partySize: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe("Number of people in the party"),
  },
  outputSchema: {
    slots: z.array(SlotSchema).describe("Open slots that fit the party; pass a slot's id to createReservation"),
    count: z.number().int(),
    message: z.string(),
  },
  async handler({ date, partySize }, _ctx) {
    const slots: Slot[] = store.searchAvailability(date, partySize);
    const message = slots.length === 0
      ? `No availability on ${date} for ${partySize} people.`
      : `${slots.length} slot(s) available.`;
    return ok({ slots, count: slots.length, message });
  },
});

export type SearchAvailabilityOp = typeof searchAvailability;
