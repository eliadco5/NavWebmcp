import type { FeatureIntro } from "../types";

export const agentTabIntro: FeatureIntro = {
  id: "agent-tab",
  version: 1,
  tab: "agent",
  title: "The Agent tab",
  steps: [
    {
      title: "Let an AI agent run the app",
      body:
        "This tab is where you hand the app to an AI agent. Everything you can do in the UI, " +
        "an agent can do too, under the same role and permission checks.",
    },
    {
      target: "agent-connect",
      placement: "right",
      title: "Connect an agent",
      body:
        "Copy this command to add the app as an MCP server in Claude Code. " +
        "The token is tied to your current role, so the agent sees only what you can see.",
    },
    {
      target: "agent-capabilities",
      placement: "left",
      title: "What the agent can do",
      body:
        "The capability manifest lists every operation your role can reach. " +
        "Agents read this first to find out what they are allowed to do.",
    },
    {
      target: "agent-explore",
      placement: "left",
      title: "Browse the tools",
      body:
        "Explore the operation tree the same way an agent does: load only the tools " +
        "you need, instead of all of them at once.",
    },
    {
      target: "agent-reset",
      placement: "right",
      title: "Reset if you get stuck",
      body:
        "If the demo data ends up somewhere you can't use (for example every guest is " +
        "checked out), this puts it back to the starting state.",
    },
  ],
};
