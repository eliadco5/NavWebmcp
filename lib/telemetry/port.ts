// Indirection between execute() and lib/telemetry — same reason as
// lib/audit/port.ts: execute is bundled into the browser, lib/telemetry uses
// the Redis client. lib/telemetry/index.ts installs itself here when a server
// entry point imports it.
import type { Actor, CallMeta, Permission } from "@/lib/operations/types";

export interface CallObservation {
  operation: string;
  permission?: Permission;
  success: boolean;
  errorCode?: string;
  actor: Actor;
  meta: CallMeta;
  durationMs: number;
  /** Wall-clock start, ms since epoch. */
  startedAt: number;
}

export type CallObserver = (o: CallObservation) => Promise<unknown>;

declare global {
  // eslint-disable-next-line no-var
  var __telemetryObserver: CallObserver | undefined;
}

export function installTelemetry(fn: CallObserver): void {
  globalThis.__telemetryObserver = fn;
}

export function telemetryObserver(): CallObserver | undefined {
  return globalThis.__telemetryObserver;
}
