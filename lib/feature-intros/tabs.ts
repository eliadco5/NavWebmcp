// Tab ids of the AppShell tab strip (components/AppShell.tsx). Lives here, not
// in AppShell, so the feature-intro registry and its tests can check that every
// intro points at a real tab without importing a React component.
export const TAB_IDS = [
  "reservations",
  "frontdesk",
  "guests",
  "tasks",
  "housekeeping",
  "finance",
  "agent",
] as const;

export type TabId = (typeof TAB_IDS)[number];
