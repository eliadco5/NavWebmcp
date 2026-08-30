import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { crmPreferences, type GuestPreferences } from "@/lib/seed";

const preferencesMap = crmPreferences();

export const updateGuestPreferences = defineOperation({
  name: "updateGuestPreferences",
  title: "Update Guest Preferences",
  description: "Update dietary restrictions, seating preferences, and special notes for a guest.",
  permission: "write",
  roles: ["customer", "support", "admin"],
  module: "crm.preferences",
  inputSchema: {
    guestId: z.string().describe("The unique guest identifier"),
    dietaryRestrictions: z.array(z.string()).optional().describe("List of dietary restrictions or allergies"),
    seatingPreference: z.string().optional().describe("Preferred seating area (e.g. window, booth, outdoor)"),
    specialNotes: z.string().optional().describe("Free-text special notes or requests"),
  },
  async handler({ guestId, dietaryRestrictions, seatingPreference, specialNotes }, ctx) {
    const existing: GuestPreferences = preferencesMap.get(guestId) ?? {
      guestId,
      dietaryRestrictions: [],
      seatingPreference: "no preference",
      specialNotes: "",
      updatedAt: null,
    };
    const updated: GuestPreferences = {
      ...existing,
      ...(dietaryRestrictions !== undefined && { dietaryRestrictions }),
      ...(seatingPreference !== undefined && { seatingPreference }),
      ...(specialNotes !== undefined && { specialNotes }),
      updatedAt: new Date().toISOString(),
    };
    preferencesMap.set(guestId, updated);
    return ok({ preferences: updated });
  },
});
