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
