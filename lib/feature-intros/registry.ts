// Every user-facing feature ships with an entry here. See README, "Shipping a
// new feature". Pure and isomorphic: imported by the client (IntroProvider),
// the /api/intros route, and the tests.
import type { Role } from "@/lib/auth";
import type { FeatureIntro } from "./types";
import { agentTabIntro } from "./intros/agentTab";
import { managementTabIntro } from "./intros/managementTab";

export type { FeatureIntro, IntroStep } from "./types";

export const FEATURE_INTROS: FeatureIntro[] = [agentTabIntro, managementTabIntro];

/** What gets stored as "seen". Including the version means a bump re-shows it. */
export function introKey(intro: Pick<FeatureIntro, "id" | "version">): string {
  return `${intro.id}@${intro.version}`;
}

export function isKnownIntroKey(key: string): boolean {
  return FEATURE_INTROS.some((i) => introKey(i) === key);
}

export function introsForRole(role: Role, intros: FeatureIntro[] = FEATURE_INTROS): FeatureIntro[] {
  return intros.filter((i) => !i.roles || i.roles.includes(role));
}

/** Intros for this tab and role that the user hasn't finished or skipped yet. */
export function pendingIntros(
  tab: string,
  role: Role,
  seen: ReadonlySet<string>,
  intros: FeatureIntro[] = FEATURE_INTROS,
): FeatureIntro[] {
  return introsForRole(role, intros).filter((i) => i.tab === tab && !seen.has(introKey(i)));
}
