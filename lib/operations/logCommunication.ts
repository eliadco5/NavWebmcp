import { z } from "zod";
import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { crmCommunications, type CommunicationEntry } from "@/lib/seed";

const communications = crmCommunications();

export const logCommunication = defineOperation({
  name: "logCommunication",
  title: "Log Communication",
  description: "Log a new communication entry (call, email, or note) for a guest.",
  permission: "write",
  roles: ["support", "admin"],
  module: "crm.communications",
  inputSchema: {
    guestId: z.string().describe("The unique guest identifier"),
    type: z.enum(["call", "email", "note"]).describe("Type of communication"),
    subject: z.string().min(1).describe("Short subject or title for the communication"),
    body: z.string().min(1).describe("Full details of the communication"),
  },
  async handler({ guestId, type, subject, body }, ctx) {
    const commId = `comm_${String(communications.length + 1).padStart(3, "0")}`;
    const entry: CommunicationEntry = {
      commId,
      guestId,
      type,
      subject,
      body,
      agentId: ctx.userId,
      createdAt: new Date().toISOString(),
    };
    communications.push(entry);
    return ok({ communication: entry });
  },
});
