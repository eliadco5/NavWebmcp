import { z } from "zod";
import { defineOperation } from "./types";
import { bookOrchestration } from "@/lib/core/book";
import { makeDispatch } from "./dispatch";

export const bookOp = defineOperation({
  name: "book",
  title: "Book a Table",
  description:
    "Book a table in ONE step: finds the matching open slot for the date and time, " +
    "reserves it, and validates the booking. Prefer this over calling " +
    "searchAvailability + createReservation separately.",
  permission: "write",
  roles: ["customer", "support", "admin"],
  module: "reservation.booking",
  tags: ["booking"],
  inputSchema: {
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
      .describe("Date in YYYY-MM-DD format"),
    time: z.string().describe("Desired time slot, e.g. '18:00'"),
    partySize: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe("Number of guests (1–20)"),
    name: z.string().min(1).max(100).describe("Guest name for the reservation"),
  },
  async handler(input, ctx) {
    return bookOrchestration(input, makeDispatch(ctx));
  },
});
