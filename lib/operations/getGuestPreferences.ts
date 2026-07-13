import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail } from "@/lib/result";

interface GuestPreferences {
  guestId: string;
  dietaryRestrictions: string[];
  seatingPreference: string;
  specialNotes: string;
  updatedAt: string | null;
}

declare global {
  var __crmPreferences: Map<string, GuestPreferences> | undefined;
}

const preferencesMap = globalThis.__crmPreferences ?? (globalThis.__crmPreferences = new Map<string, GuestPreferences>([
  ["g_001", { guestId: "g_001", dietaryRestrictions: ["gluten-free"], seatingPreference: "window", specialNotes: "Prefers quiet seating away from the bar", updatedAt: "2024-06-01T10:00:00Z" }],
  ["g_002", { guestId: "g_002", dietaryRestrictions: ["vegan"], seatingPreference: "booth", specialNotes: "", updatedAt: "2024-06-02T12:00:00Z" }],
  ["g_003", { guestId: "g_003", dietaryRestrictions: ["nut-allergy"], seatingPreference: "outdoor", specialNotes: "Severe nut allergy — kitchen alert required on every visit", updatedAt: "2024-06-03T09:00:00Z" }],
]));

export const getGuestPreferences = defineOperation({
  name: "getGuestPreferences",
  title: "Get Guest Preferences",
  description: "Retrieve dining preferences and dietary restrictions for a guest.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  module: "crm.preferences",
  inputSchema: {
    guestId: z.string().describe("The unique guest identifier"),
  },
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
