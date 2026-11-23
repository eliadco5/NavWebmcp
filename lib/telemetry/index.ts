// Usage telemetry for every operation call: in-app metrics (lib/telemetry/
// metrics.ts, summarised by ./summary.ts) and, when configured, OpenTelemetry
// export (./otlp.ts). Importing this module from a server entry point turns it
// on for execute() via ./port.ts.
import { installTelemetry, type CallObservation } from "./port";
import { recordCallMetrics } from "./metrics";
import { enqueueOtlp } from "./otlp";

export type { CallObservation } from "./port";
export { getUsageSummary, liveConnections, LATENCY_SLO_MS, type UsageSummary, type UsageQuery } from "./summary";

/** Never throws, and never blocks on the network beyond one metrics write. */
export async function observeCall(o: CallObservation): Promise<void> {
  await Promise.allSettled([recordCallMetrics(o), enqueueOtlp(o)]);
}

installTelemetry(observeCall);
