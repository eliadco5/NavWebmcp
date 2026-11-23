import { ok, fail, type Result } from "@/lib/result";
import { getUiRegistry, type UiComponentRegistry } from "./registry";
import { UI_ERROR, type UiKind } from "./contract";

// In-page implementation of the ui_* ops (lib/operations/ui.ts holds the server
// one). lib/adapters/webmcp.ts routes ops marked `runsInPage` here, so an
// in-page agent acts on this tab's live registry with no server round trip.

const TAB_KEY = "navwebmcp.ui.tabId";

/** Stable per browser tab (survives reloads, not shared with other tabs). */
export function getTabId(): string {
  if (typeof window === "undefined") return "server";
  try {
    let id = sessionStorage.getItem(TAB_KEY);
    if (!id) {
      id = `tab_${crypto.randomUUID()}`;
      sessionStorage.setItem(TAB_KEY, id);
    }
    return id;
  } catch {
    // Storage disabled: fall back to one id per page load.
    return ((window as unknown as { __navTabId?: string }).__navTabId ??= `tab_${crypto.randomUUID()}`);
  }
}

const newCmdId = () => `cmd_${crypto.randomUUID()}`;

export async function runUiOpLocally(
  name: string,
  input: Record<string, unknown>,
  registry: UiComponentRegistry = getUiRegistry()
): Promise<Result<unknown>> {
  const tabId = getTabId();
  // An in-page agent addressing another tab goes through the server relay instead.
  if (typeof input.tabId === "string" && input.tabId !== tabId) {
    return fail(UI_ERROR.NO_PAGE, `This page is tab '${tabId}'. Drive other tabs from an MCP client, not the in-page agent.`);
  }
  const componentId = input.componentId as string;

  switch (name) {
    case "ui_list":
      return ok({
        tabId,
        activeTab: registry.activeTab(),
        openTabs: 1,
        components: registry.list(input.kind as UiKind | undefined),
      });
    case "ui_get_state": {
      const c = registry.get(componentId);
      if (!c) {
        const ids = registry.list().map((x) => x.id).join(", ") || "none";
        return fail(UI_ERROR.NOT_FOUND, `No mounted component '${componentId}'. Mounted: ${ids}. It may be on another tab: switch tabs via app.nav first.`);
      }
      return ok({ componentId: c.id, kind: c.kind, state: c.state, version: c.version, ...(c.view && { view: c.view }) });
    }
    case "ui_set_state":
      return registry.applyCommand({
        cmdId: newCmdId(), type: "set_state", componentId,
        patch: input.patch as Record<string, unknown>,
        ...(typeof input.expectedVersion === "number" && { expectedVersion: input.expectedVersion }),
      });
    case "ui_action":
      return registry.applyCommand({
        cmdId: newCmdId(), type: "action", componentId,
        action: input.action as string,
        ...(input.args !== undefined && { args: input.args as Record<string, unknown> }),
      });
    default:
      return fail("UNKNOWN_TOOL", `'${name}' is not a UI operation.`);
  }
}
