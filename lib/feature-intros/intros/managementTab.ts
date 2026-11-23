import type { FeatureIntro } from "../types";

export const managementTabIntro: FeatureIntro = {
  id: "management-tab",
  version: 1,
  tab: "management",
  roles: ["admin"],
  title: "The Management tab",
  steps: [
    {
      title: "See how people and agents use the app",
      body:
        "Management shows every operation call split by who made it: a person clicking in the app, " +
        "or an AI agent acting for them. It is admin only.",
    },
    {
      target: "mgmt-health",
      placement: "bottom",
      title: "Is it compliant right now?",
      body:
        "This line says whether the audit trail is stored durably, how long it's kept, and where it's " +
        "exported. Warnings here are worth fixing before an audit.",
    },
    {
      target: "mgmt-views",
      placement: "bottom",
      title: "Audit, sessions and agents",
      body:
        "Audit trail answers \"who created or changed this record?\" and can verify nothing was tampered with. " +
        "Sessions & agents shows who's connected, and lets you revoke a session or disconnect one agent.",
    },
  ],
};
