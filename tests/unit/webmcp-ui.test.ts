// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

// In-page surface: ui_* tools are served by the page's own component registry,
// never by the injected server dispatch (POST /api/call).

describe("initAgentBridge routes ui_* ops to the page", () => {
  it("ui_list / ui_set_state act on the live registry without calling dispatch", async () => {
    const { initAgentBridge } = await import("@/lib/adapters/webmcp");
    const { getUiRegistry } = await import("@/lib/ui-components/registry");
    const { tableStateSchema } = await import("@/lib/ui-components/kinds");

    let state: Record<string, unknown> = { filters: {}, sort: [] };
    getUiRegistry().register({
      id: "tasks.table", kind: "table", title: "Tasks",
      schema: tableStateSchema({ status: z.enum(["open"]).optional().describe("s") }, ["priority"] as const) as never,
      getState: () => state, setState: (n) => { state = n; },
    });

    const dispatch = vi.fn().mockResolvedValue({ success: true, data: {} });
    const bridge = initAgentBridge({ getUserId: () => "u_bob", getUserRole: () => "admin" }, dispatch);

    const list = (await bridge.call("ui_list", {})) as { success: boolean; data: { components: { id: string }[]; tabId: string } };
    expect(list.success).toBe(true);
    expect(list.data.components.map((c) => c.id)).toEqual(["tasks.table"]);
    expect(list.data.tabId).toMatch(/^tab_/);

    const set = (await bridge.call("ui_set_state", { componentId: "tasks.table", patch: { filters: { status: "open" } } })) as { success: boolean };
    expect(set.success).toBe(true);
    expect(state).toEqual({ filters: { status: "open" }, sort: [] });

    // Strict input still applies on the in-page path.
    const bad = (await bridge.call("ui_set_state", { componentId: "tasks.table", patch: {}, extra: 1 })) as { success: boolean; error: { code: string } };
    expect(bad.error.code).toBe("INVALID_INPUT");

    expect(dispatch).not.toHaveBeenCalled();
    // Business ops still go to the server.
    await bridge.call("getContext", {});
    expect(dispatch).toHaveBeenCalledWith("getContext", {}, undefined);
    // First import of the full registry: ~1s alone, 5-7s under the parallel suite.
  }, 20_000);

  it("ui_set_state needs no confirmation dialog", async () => {
    const { initAgentBridge } = await import("@/lib/adapters/webmcp");
    const onConfirmation = vi.fn().mockResolvedValue(false);
    const bridge = initAgentBridge({ getUserId: () => "u_alice", getUserRole: () => "customer", onConfirmation }, vi.fn());
    await bridge.call("ui_set_state", { componentId: "nothing.here", patch: {} });
    expect(onConfirmation).not.toHaveBeenCalled();
  });
});
