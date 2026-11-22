import type { Role } from "@/lib/auth";
import type { TabId } from "./tabs";

export interface IntroStep {
  /** Value of a `data-intro="..."` attribute to spotlight. Omit for a centred step. */
  target?: string;
  title: string;
  body: string;
  placement?: "top" | "bottom" | "left" | "right";
}

export interface FeatureIntro {
  /** Stable kebab-case id. Never reuse an id for a different feature. */
  id: string;
  /** Bump to show the intro again after a meaningful change to the feature. */
  version: number;
  /** The AppShell tab whose first load starts this intro. */
  tab: TabId;
  /** Roles that see it. Omit for every role. */
  roles?: Role[];
  /** Shown in the "What's new" list. */
  title: string;
  steps: IntroStep[];
}
