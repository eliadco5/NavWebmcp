import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok } from "@/lib/result";
import type { Slot } from "@/lib/store";
import { IsoDate, SlotSchema, TimeHHMM } from "./schemas";

export const searchAvailability = defineOperation({
  name: "searchAvailability",
  title: "Search Availability",
  description:
    "Search available booking slots for a given date and party size, optionally at one time. Returns a list of open time slots.",
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
    time: TimeHHMM().optional().describe("Only the slot at this time (24-hour HH:MM), e.g. '18:00'"),
  },
  outputSchema: {
    slots: z.array(SlotSchema).describe("Open slots that fit the party; pass a slot's id to createReservation"),
    count: z.number().int(),
    message: z.string(),
  },
  async handler({ date, partySize, time }, _ctx) {
    const slots: Slot[] = store.searchAvailability(date, partySize).filter((s) => time === undefined || s.time === time);
    const message = slots.length === 0
      ? `No availability on ${date}${time ? ` at ${time}` : ""} for ${partySize} people.`
      : `${slots.length} slot(s) available.`;
    return ok({ slots, count: slots.length, message });
  },
});

export type SearchAvailabilityOp = typeof searchAvailability;
