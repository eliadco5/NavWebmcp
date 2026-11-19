import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { crmPreferences, type GuestPreferences } from "@/lib/seed";
import { Id, ShortText, LongText, PreferencesSchema } from "./schemas";

const preferencesMap = crmPreferences();

export const updateGuestPreferences = defineOperation({
  name: "updateGuestPreferences",
  title: "Update Guest Preferences",
  description: "Update dietary restrictions, seating preferences, and special notes for a guest.",
  permission: "write",
  roles: ["customer", "support", "admin"],
  module: "crm.preferences",
  inputSchema: {
    guestId: Id().describe("The unique guest identifier"),
    dietaryRestrictions: z.array(ShortText(100)).max(20).optional().describe("List of dietary restrictions or allergies"),
    seatingPreference: ShortText(100).optional().describe("Preferred seating area (e.g. window, booth, outdoor)"),
    specialNotes: LongText().optional().describe("Free-text special notes or requests"),
  },
  outputSchema: { preferences: PreferencesSchema },
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
