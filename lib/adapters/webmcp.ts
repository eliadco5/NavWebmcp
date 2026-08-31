import { AgentBridge, type AgentBridgeOptions } from "@/lib/agentbridge";
import { registry } from "@/lib/operations";
import { AGENT_INSTRUCTIONS } from "@/lib/agent-instructions";

let _bridge: AgentBridge | null = null;

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
  dispatch: (name: string, params: Record<string, unknown>) => Promise<unknown>
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
      permission: op.permission,
      roles: op.roles,
      requiresConfirmation: op.requiresConfirmation,
      tags: op.tags,
      handler: (input) => dispatch(op.name, input),
    });
  }

  return _bridge;
}

export function getBridge(): AgentBridge | null {
  return _bridge;
}
