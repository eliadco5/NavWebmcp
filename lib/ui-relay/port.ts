// Indirection between the ui_* operations and the relay store.
//
// The operation registry is also bundled into the browser (app/providers.tsx
// imports it), and the store pulls in the Node `redis` client, which must never
// reach the client bundle. So the ops depend only on this dependency-free port,
// and lib/ui-relay/store.ts installs itself here when a SERVER entry point
// imports it (lib/adapters/mcp.ts, app/api/call/route.ts, app/api/ui/*).
import type { Result } from "@/lib/result";
import type { UiCommand, UiPageSnapshot } from "@/lib/ui-components/contract";

export interface StoredSnapshot extends UiPageSnapshot {
  updatedAt: number;
}

export interface UiRelayPort {
  pickPage(userId: string, tabId?: string): Promise<StoredSnapshot | null>;
  livePages(userId: string): Promise<StoredSnapshot[]>;
  enqueueCommand(userId: string, tabId: string, cmd: UiCommand): Promise<void>;
  awaitResult(userId: string, cmdId: string): Promise<Result<unknown> | undefined>;
}

declare global {
  // eslint-disable-next-line no-var
  var __uiRelayPort: UiRelayPort | undefined;
}

export function installUiRelay(port: UiRelayPort): void {
  globalThis.__uiRelayPort = port;
}

export function uiRelay(): UiRelayPort | undefined {
  return globalThis.__uiRelayPort;
}
