import { singleton, singletonMap, resetMap, resetArray } from "./store";

// The 5 demo guest profiles. Exported so UI panels for roles that can't call
// searchGuests (customers) still have a way to pick a guestId — see CrmPanel.
export const DEMO_GUEST_IDS = ["g_001", "g_002", "g_003", "g_004", "g_005"] as const;

export interface Guest {
  guestId: string;
  name: string;
  email: string;
  phone: string;
  createdAt: string;
}

const CRM_GUESTS_KEY = "__crmGuests";
function buildCrmGuests(): [string, Guest][] {
  return [
    ["g_001", { guestId: "g_001", name: "Alice Hartman", email: "alice.hartman@email.com", phone: "+1-555-0101", createdAt: "2024-01-15T10:00:00Z" }],
    ["g_002", { guestId: "g_002", name: "Brian Torres", email: "brian.torres@email.com", phone: "+1-555-0202", createdAt: "2024-02-20T14:30:00Z" }],
    ["g_003", { guestId: "g_003", name: "Catherine Wu", email: "catherine.wu@email.com", phone: "+1-555-0303", createdAt: "2024-03-05T09:15:00Z" }],
    ["g_004", { guestId: "g_004", name: "David Okafor", email: "david.okafor@email.com", phone: "+1-555-0404", createdAt: "2024-04-10T11:45:00Z" }],
    ["g_005", { guestId: "g_005", name: "Elena Rossi", email: "elena.rossi@email.com", phone: "+1-555-0505", createdAt: "2024-05-22T16:00:00Z" }],
  ];
}
export function crmGuests(): Map<string, Guest> { return singletonMap(CRM_GUESTS_KEY, buildCrmGuests); }
export function resetCrmGuests(): void { resetMap(CRM_GUESTS_KEY, buildCrmGuests); }

export interface GuestPreferences {
  guestId: string;
  dietaryRestrictions: string[];
  seatingPreference: string;
  specialNotes: string;
  updatedAt: string | null;
}

const CRM_PREFERENCES_KEY = "__crmPreferences";
function buildCrmPreferences(): [string, GuestPreferences][] {
  return [
    ["g_001", { guestId: "g_001", dietaryRestrictions: ["gluten-free"], seatingPreference: "window", specialNotes: "Prefers quiet seating away from the bar", updatedAt: "2024-06-01T10:00:00Z" }],
    ["g_002", { guestId: "g_002", dietaryRestrictions: ["vegan"], seatingPreference: "booth", specialNotes: "", updatedAt: "2024-06-02T12:00:00Z" }],
    ["g_003", { guestId: "g_003", dietaryRestrictions: ["nut-allergy"], seatingPreference: "outdoor", specialNotes: "Severe nut allergy — kitchen alert required on every visit", updatedAt: "2024-06-03T09:00:00Z" }],
  ];
}
export function crmPreferences(): Map<string, GuestPreferences> { return singletonMap(CRM_PREFERENCES_KEY, buildCrmPreferences); }
export function resetCrmPreferences(): void { resetMap(CRM_PREFERENCES_KEY, buildCrmPreferences); }

export interface LoyaltyRedemption {
  date: string;
  pointsRedeemed: number;
  description: string;
}

export interface LoyaltyAccount {
  guestId: string;
  tier: "bronze" | "silver" | "gold" | "platinum";
  pointBalance: number;
  lifetimePoints: number;
  redemptionHistory: LoyaltyRedemption[];
}

const CRM_LOYALTY_KEY = "__crmLoyalty";
function buildCrmLoyalty(): [string, LoyaltyAccount][] {
  return [
    ["g_001", { guestId: "g_001", tier: "gold", pointBalance: 4200, lifetimePoints: 12500, redemptionHistory: [{ date: "2024-05-10", pointsRedeemed: 500, description: "Free dessert" }] }],
    ["g_002", { guestId: "g_002", tier: "silver", pointBalance: 1850, lifetimePoints: 4300, redemptionHistory: [] }],
    ["g_003", { guestId: "g_003", tier: "platinum", pointBalance: 9800, lifetimePoints: 35000, redemptionHistory: [{ date: "2024-04-22", pointsRedeemed: 2000, description: "Complimentary dinner for two" }] }],
    ["g_004", { guestId: "g_004", tier: "bronze", pointBalance: 320, lifetimePoints: 320, redemptionHistory: [] }],
    ["g_005", { guestId: "g_005", tier: "silver", pointBalance: 2100, lifetimePoints: 5800, redemptionHistory: [{ date: "2024-03-15", pointsRedeemed: 300, description: "Complimentary appetizer" }] }],
  ];
}
export function crmLoyalty(): Map<string, LoyaltyAccount> { return singletonMap(CRM_LOYALTY_KEY, buildCrmLoyalty); }
export function resetCrmLoyalty(): void { resetMap(CRM_LOYALTY_KEY, buildCrmLoyalty); }

export function computeLoyaltyTier(lifetimePoints: number): LoyaltyAccount["tier"] {
  if (lifetimePoints >= 20000) return "platinum";
  if (lifetimePoints >= 8000) return "gold";
  if (lifetimePoints >= 2000) return "silver";
  return "bronze";
}

export interface CommunicationEntry {
  commId: string;
  guestId: string;
  type: "call" | "email" | "note";
  subject: string;
  body: string;
  agentId: string;
  createdAt: string;
}

const CRM_COMMUNICATIONS_KEY = "__crmCommunications";
function buildCrmCommunications(): CommunicationEntry[] {
  return [
    { commId: "comm_001", guestId: "g_001", type: "call", subject: "Reservation inquiry", body: "Guest called to ask about weekend availability for a party of six.", agentId: "staff_01", createdAt: "2024-06-10T14:00:00Z" },
    { commId: "comm_002", guestId: "g_001", type: "email", subject: "Birthday dinner confirmation", body: "Sent confirmation email for birthday dinner on June 20. Cake arranged with kitchen.", agentId: "staff_02", createdAt: "2024-06-11T09:30:00Z" },
    { commId: "comm_003", guestId: "g_002", type: "note", subject: "Vegan menu follow-up", body: "Confirmed vegan tasting menu availability with kitchen for upcoming Friday visit.", agentId: "staff_01", createdAt: "2024-06-12T11:00:00Z" },
    { commId: "comm_004", guestId: "g_003", type: "call", subject: "Complaint — cold food", body: "Guest reported food was served cold during last visit. Apologised and offered complimentary appetizer on next visit.", agentId: "staff_03", createdAt: "2024-06-13T16:45:00Z" },
    { commId: "comm_005", guestId: "g_004", type: "email", subject: "Welcome email sent", body: "Sent onboarding welcome email with loyalty programme details.", agentId: "staff_02", createdAt: "2024-06-14T08:00:00Z" },
  ];
}
export function crmCommunications(): CommunicationEntry[] { return singleton(CRM_COMMUNICATIONS_KEY, buildCrmCommunications); }
export function resetCrmCommunications(): void { resetArray(CRM_COMMUNICATIONS_KEY, buildCrmCommunications); }
