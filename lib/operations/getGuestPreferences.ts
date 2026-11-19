import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { crmPreferences, type GuestPreferences } from "@/lib/seed";
import { Id, PreferencesSchema } from "./schemas";

const preferencesMap = crmPreferences();

export const getGuestPreferences = defineOperation({
  name: "getGuestPreferences",
  title: "Get Guest Preferences",
  description: "Retrieve dining preferences and dietary restrictions for a guest.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "crm.preferences",
  inputSchema: {
    guestId: Id().describe("The unique guest identifier"),
  },
  outputSchema: { preferences: PreferencesSchema.describe("Defaults are returned for a guest with no saved preferences") },
  untrustedOutput: true,
  async handler({ guestId }, ctx) {
    const preferences = preferencesMap.get(guestId) ?? {
      guestId,
      dietaryRestrictions: [],
      seatingPreference: "no preference",
      specialNotes: "",
      updatedAt: null,
    };
    return ok({ preferences });
  },
});
