import { z } from "zod";
import { defineOperation } from "./types";
import { bookOrchestration } from "@/lib/core/book";
import { makeDispatch } from "./dispatch";
import { IsoDate, TimeHHMM, ShortText, ReservationSchema } from "./schemas";

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
    date: IsoDate().describe("Date in YYYY-MM-DD format"),
    time: TimeHHMM().describe("Desired time slot in 24-hour HH:MM, e.g. '18:00'"),
    partySize: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe("Number of guests (1–20)"),
    name: ShortText(100).min(1).describe("Guest name for the reservation"),
  },
  outputSchema: {
    reservation: ReservationSchema.describe("The created reservation"),
    validated: z.boolean().describe("True when the post-booking check confirmed the slot is no longer open"),
  },
  async handler(input, ctx) {
    return bookOrchestration(input, makeDispatch(ctx));
  },
});
