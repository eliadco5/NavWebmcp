// Browser side of the UI relay (server side: lib/ui-relay/store.ts). While the
// user is signed in, this tab:
//   - publishes its mounted components (snapshot) on every change, on focus,
//     and as a heartbeat, so the server knows what an MCP client can drive;
//   - polls for relayed commands, applies them through the SAME
//     UiComponentRegistry.applyCommand an in-page agent uses, and posts the
//     results straight back.
import { getUiRegistry, type UiComponentRegistry } from "@/lib/ui-components/registry";
import { getTabId } from "@/lib/ui-components/local";
import type { UiCommand } from "@/lib/ui-components/contract";

const HEARTBEAT_MS = 10_000;          // < SNAPSHOT_TTL_MS (30s)
const POLL_VISIBLE_MS = 1_000;
const POLL_HIDDEN_MS = 5_000;
const PUBLISH_DEBOUNCE_MS = 200;

export interface UiRelayClientOptions {
  registry?: UiComponentRegistry;
  fetchImpl?: typeof fetch;
}

export function startUiRelay({ registry = getUiRegistry(), fetchImpl = fetch }: UiRelayClientOptions = {}): () => void {
  const tabId = getTabId();
  let stopped = false;
  let focusedAt = Date.now();
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const snapshot = () => ({
    tabId,
    activeTab: registry.activeTab(),
    visible: document.visibilityState === "visible",
    focusedAt,
    components: registry.list(),
  });

  const publishNow = async () => {
    if (stopped) return;
    try {
      await fetchImpl("/api/ui/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot()),
      });
    } catch {
      // transient — the heartbeat retries
    }
  };
  const publish = () => {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(publishNow, PUBLISH_DEBOUNCE_MS);
  };

  const poll = async (results: { cmdId: string; result: unknown }[] = []) => {
    if (stopped) return;
    let commands: UiCommand[] = [];
    try {
      const res = await fetchImpl("/api/ui/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId, results }),
      });
      if (res.ok) commands = ((await res.json()) as { data?: { commands?: UiCommand[] } }).data?.commands ?? [];
    } catch {
      // A result lost here makes the agent's call time out (UI_TIMEOUT); the
      // change itself was applied and shows up in the next snapshot.
    }
    if (stopped) return;
    if (commands.length) {
      const next = [];
      for (const cmd of commands) next.push({ cmdId: cmd.cmdId, result: await registry.applyCommand(cmd) });
      publish();
      void poll(next); // hand the results back right away
      return;
    }
    const delay = document.visibilityState === "visible" ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
    pollTimer = setTimeout(() => void poll(), delay);
  };

  const onFocus = () => { focusedAt = Date.now(); publish(); };
  const onVisibility = () => { if (document.visibilityState === "visible") focusedAt = Date.now(); publish(); };
  const onPageHide = () => {
    navigator.sendBeacon?.("/api/ui/snapshot", JSON.stringify({ tabId, closed: true }));
  };

  const unsubscribe = registry.subscribe(publish);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  const heartbeat = setInterval(publishNow, HEARTBEAT_MS);
  void publishNow();
  void poll();

  return () => {
    stopped = true;
    unsubscribe();
    clearTimeout(publishTimer);
    clearTimeout(pollTimer);
    clearInterval(heartbeat);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
  };
}
