import { AgentBridge, type AgentBridgeOptions } from "@/lib/agentbridge";
import { registry } from "@/lib/operations";

let _bridge: AgentBridge | null = null;

/**
 * Initialise the in-page AgentBridge, registering every operation from the
 * shared registry into document.modelContext. Idempotent — returns the same
 * instance if already initialised.
 */
export function initAgentBridge(options: AgentBridgeOptions = {}): AgentBridge {
  if (_bridge) return _bridge;

  _bridge = new AgentBridge(options);

  for (const op of registry) {
    _bridge.register({
      name: op.name,
      title: op.title,
      description: op.description,
      inputSchema: op.inputSchema,
      permission: op.permission,
      requiresConfirmation: op.requiresConfirmation,
      tags: op.tags,
      handler: op.handler,
    });
  }

  // Expose on window for console inspection
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>)["agentBridge"] = _bridge;
  }

  return _bridge;
}

export function getBridge(): AgentBridge | null {
  return _bridge;
}
