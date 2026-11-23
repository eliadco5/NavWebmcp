import { AgentBridge, type AgentBridgeOptions } from "@/lib/agentbridge";
import { registry } from "@/lib/operations";
import { AGENT_INSTRUCTIONS } from "@/lib/agent-instructions";
import { runUiOpLocally } from "@/lib/ui-components/local";
import type { Result } from "@/lib/result";

let _bridge: AgentBridge | null = null;

/** Fire-and-forget: an audit report must never slow down or fail the agent's call. */
function reportInPageCall(name: string, input: Record<string, unknown>, result: Result<unknown>) {
  if (typeof window === "undefined") return;
  try {
    void fetch("/api/audit/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        operation: name,
        input,
        success: result.success,
        errorCode: result.success ? undefined : result.error.code,
      }),
    }).catch(() => undefined);
  } catch {
    /* never let reporting break the call */
  }
}

/**
 * Initialise the in-page AgentBridge, registering every operation from the
 * shared registry into document.modelContext. Idempotent — the underlying
 * AgentBridge is a singleton, but the registration loop runs on every call
 * (see below), not just the first.
 *
 * `dispatch` is injected rather than calling `op.handler` directly: op
 * handlers read/write lib/store.ts's and lib/auditlog.ts's globalThis
 * singletons, which in a browser resolve to the browser's OWN globalThis — a
 * throwaway store the server, other tabs, and the real MCP server never see.
 * Every call here must go through the server the same way the UI's own
 * buttons already do (app/providers.tsx's serverCall -> POST /api/call), so
 * mutations land in the one real store and get audit-logged where /api/audit
 * can actually read them back.
 */
export function initAgentBridge(
  options: AgentBridgeOptions,
  dispatch: (name: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
): AgentBridge {
  if (!_bridge) {
    _bridge = new AgentBridge({ instructions: AGENT_INSTRUCTIONS, ...options });
    // Expose on window for console inspection
    if (typeof window !== "undefined") {
      (window as unknown as Record<string, unknown>)["agentBridge"] = _bridge;
    }
  }

  // Re-loop every call, not just the first: a role switch (app/providers.tsx's
  // switchRole) doesn't reconstruct the bridge, but newly-visible ops for the
  // upgraded role still need registering. AgentBridge.register() is idempotent
  // by name, so re-registering an already-visible op here is a cheap no-op.
  for (const op of registry) {
    _bridge.register({
      name: op.name,
      title: op.title,
      description: op.description,
      inputSchema: op.inputSchema,
      outputSchema: op.outputSchema,
      permission: op.permission,
      roles: op.roles,
      requiresConfirmation: op.requiresConfirmation,
      untrustedOutput: op.untrustedOutput,
      dispatchesOps: op.dispatchesOps,
      tags: op.tags,
      // ui_* ops act on this page's own components, so they never go to the server.
      handler: op.runsInPage
        ? async (input) => {
            const result = await runUiOpLocally(op.name, input);
            // The server never sees these, so it can't observe them: report
            // writes for the audit trail (recorded as client-asserted).
            if (op.permission === "write") reportInPageCall(op.name, input, result);
            return result;
          }
        : (input, _ctx, options) => dispatch(op.name, input, options?.signal),
    });
  }

  return _bridge;
}

export function getBridge(): AgentBridge | null {
  return _bridge;
}
