import type { BugReportSink } from "./index";

/**
 * Placeholder for the future in-app chat: a submitted report would be posted
 * into a support conversation (with the report id as a deep link) so the
 * reporter can follow up. Disabled until that chat exists — implement send()
 * and flip enabled() when it does; nothing else needs to change.
 */
export const chatSink: BugReportSink = {
  name: "chat",
  enabled: () => false,
  async send() {
    throw new Error("In-app chat sink is not implemented yet.");
  },
};
