// Indirection between execute() and lib/credits — same reason as
// lib/telemetry/port.ts: execute is bundled into the browser, while the credit
// ledger uses the Redis client and async_hooks. lib/credits/index.ts installs
// itself here when a server entry point imports it (app/api/call/route.ts,
// lib/adapters/mcp.ts). With nothing installed (the browser, unit tests that
// don't import it) calls are simply not metered.
import type { CreditInfo } from "@/lib/result";
import type { Actor, CallMeta, Operation } from "@/lib/operations/types";

export type { CreditInfo };

export interface AdmitRequest {
  operation: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  op?: Operation<any, any>;
  args: Record<string, unknown>;
  actor: Actor;
  meta: CallMeta;
}

export interface CallOutcome {
  durationMs: number;
  /** Serialized size of what the call returned. */
  responseBytes: number;
  /** Operations actually executed underneath this call (invoke, composites). */
  nestedOps: number;
}

export type Admission =
  | {
      admitted: true;
      /** Settle the call's real cost and compute the grant. Never throws.
       *  Null when the call isn't metered (system actor, metering off). */
      finish(outcome: CallOutcome): Promise<(CreditInfo & { hinted: boolean }) | null>;
    }
  | { admitted: false; credits: CreditInfo };

/** What getContext reports, so an agent can plan before it starts. */
export interface CreditSnapshot {
  balance: number;
  window: number;
  maxWindow: number;
  refillPerSec: number;
  frozen: boolean;
}

export interface CreditsPort {
  admit(req: AdmitRequest): Promise<Admission>;
  /** Current state for this actor, or null when it isn't metered. */
  peek(actor: Actor): Promise<CreditSnapshot | null>;
}

declare global {
  // eslint-disable-next-line no-var
  var __creditsPort: CreditsPort | undefined;
}

export function installCredits(port: CreditsPort): void {
  globalThis.__creditsPort = port;
}

export function credits(): CreditsPort | undefined {
  return globalThis.__creditsPort;
}
