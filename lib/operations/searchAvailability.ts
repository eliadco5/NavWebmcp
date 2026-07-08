import { z } from "zod";
import { defineOperation } from "./types";
import { store } from "@/lib/store";
import { ok } from "@/lib/result";
import type { Slot } from "@/lib/store";

export const searchAvailability = defineOperation({
  name: "searchAvailability",
  title: "Search Availability",
  description:
    "Search available booking slots for a given date and party size. Returns a list of open time slots.",
  permission: "read",
  tags: ["booking", "availability"],
  inputSchema: {
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
      .describe("Date to search in YYYY-MM-DD format"),
    partySize: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe("Number of people in the party"),
  },
  async handler({ date, partySize }) {
    const slots: Slot[] = store.searchAvailability(date, partySize);
    const message = slots.length === 0
      ? `No availability on ${date} for ${partySize} people.`
      : `${slots.length} slot(s) available.`;
    return ok({ slots, count: slots.length, message });
  },
});

export type SearchAvailabilityOp = typeof searchAvailability;
