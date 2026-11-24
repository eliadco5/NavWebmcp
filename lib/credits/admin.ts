// What the management layer sees and changes: every ledger with its live
// (refilled) balance, and per-principal overrides.
import { profile, type ProfileName } from "./policy";
import { effectiveProfile, getOverride, listLedgers, refill, setOverride, type Override } from "./ledger";

export interface CreditLedgerView {
  /** "a:<clientId>" for an agent client, "h:<userId>" for a person. */
  principal: string;
  kind: "agent" | "human";
  /** The agent client id or user id behind it. */
  id: string;
  balance: number;
  outstanding: number;
  window: number;
  maxWindow: number;
  refillPerSec: number;
  frozen: boolean;
  calls: number;
  spent: number;
  refused: number;
  lastAt?: string;
  override?: Override;
}

function kindOf(principal: string): { kind: ProfileName; id: string } {
  return principal.startsWith("a:") ? { kind: "agent", id: principal.slice(2) } : { kind: "human", id: principal.slice(2) };
}

export async function listCreditLedgers(now = Date.now()): Promise<CreditLedgerView[]> {
  const rows = await listLedgers();
  return rows
    .map(({ principal, ledger, override }) => {
      const { kind, id } = kindOf(principal);
      const p = effectiveProfile(profile(kind), override);
      const l = ledger ? refill(ledger, p, now) : null;
      return {
        principal,
        kind,
        id,
        balance: l ? Math.floor(l.balance) : p.initialWindow,
        outstanding: l?.outstanding ?? 0,
        window: l?.window ?? p.initialWindow,
        maxWindow: p.maxWindow,
        refillPerSec: p.refillPerSec,
        frozen: Boolean(override?.frozen),
        calls: l?.calls ?? 0,
        spent: l?.spent ?? 0,
        refused: l?.refused ?? 0,
        lastAt: l ? new Date(l.lastAt).toISOString() : undefined,
        ...(override && { override }),
      } satisfies CreditLedgerView;
    })
    .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
}

export interface PolicyChange {
  maxWindow?: number;
  refillPerSec?: number;
  frozen?: boolean;
  /** Drop the override: back to the profile defaults. */
  reset?: boolean;
}

/** Returns the override now in force (null after a reset). */
export async function setCreditPolicy(principal: string, change: PolicyChange, by: string): Promise<Override | null> {
  if (change.reset) {
    await setOverride(principal, null);
    return null;
  }
  const current = (await getOverride(principal)) ?? {};
  const next: Override = {
    ...current,
    ...(change.maxWindow !== undefined && { maxWindow: change.maxWindow }),
    ...(change.refillPerSec !== undefined && { refillPerSec: change.refillPerSec }),
    ...(change.frozen !== undefined && { frozen: change.frozen }),
    by,
    at: new Date().toISOString(),
  };
  await setOverride(principal, next);
  return next;
}

/** "a:<clientId>" / "h:<userId>" from what an admin types. */
export function principalFor(kind: "agent" | "human", id: string): string {
  return `${kind === "agent" ? "a" : "h"}:${id}`;
}
