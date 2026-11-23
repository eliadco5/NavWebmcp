// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";

// Dynamic imports: setup.ts resets modules before each test.

const filters = {
  status: z.enum(["open", "done"]).optional().describe("Status"),
  department: z.string().min(1).max(50).optional().describe("Department"),
};

async function setup() {
  const { UiComponentRegistry } = await import("@/lib/ui-components/registry");
  const { tableStateSchema } = await import("@/lib/ui-components/kinds");
  const reg = new UiComponentRegistry();
  const schema = tableStateSchema(filters, ["title", "priority"] as const);
  let state: Record<string, unknown> = { filters: {}, sort: [] };
  const registration: Parameters<typeof reg.register>[0] = {
    id: "t.table",
    kind: "table",
    title: "T",
    schema: schema as never,
    getState: () => state,
    setState: (s) => { state = s; },
    actions: { reset: { description: "Reset", run: (_a, set) => set({ filters: {}, sort: [] }) } },
    getView: () => ({ total: 2, shown: 2 }),
  };
  const unregister = reg.register(registration);
  return { reg, registration, unregister, getState: () => state, setStateExternally: (s: Record<string, unknown>) => { state = s; } };
}

const setCmd = (patch: Record<string, unknown>, expectedVersion?: number) => ({
  cmdId: "c1", type: "set_state" as const, componentId: "t.table", patch,
  ...(expectedVersion !== undefined && { expectedVersion }),
});

describe("mergePatch", () => {
  it("merges objects, replaces arrays, and deletes on null", async () => {
    const { mergePatch } = await import("@/lib/ui-components/registry");
    expect(mergePatch(
      { filters: { a: 1, b: 2 }, sort: [{ column: "x" }] },
      { filters: { b: null, c: 3 }, sort: [] },
    )).toEqual({ filters: { a: 1, c: 3 }, sort: [] });
  });
});

describe("UiComponentRegistry", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { ctx = await setup(); });

  it("lists the contract with JSON stateSchema, version 1 and actions", () => {
    const [c] = ctx.reg.list();
    expect(c).toMatchObject({ id: "t.table", kind: "table", version: 1, state: { filters: {}, sort: [] }, view: { total: 2, shown: 2 } });
    expect(c.actions).toEqual([{ name: "reset", description: "Reset" }]);
    expect((c.stateSchema as { properties: Record<string, unknown> }).properties).toHaveProperty("filters");
    expect(ctx.reg.list("tabs")).toEqual([]);
  });

  it("applies a valid patch and bumps the version", async () => {
    const r = await ctx.reg.applyCommand(setCmd({ filters: { status: "open" }, sort: [{ column: "priority", direction: "desc" }] }));
    expect(r).toEqual({ success: true, data: {
      componentId: "t.table",
      state: { filters: { status: "open" }, sort: [{ column: "priority", direction: "desc" }] },
      version: 2,
    } });
    expect(ctx.getState()).toEqual({ filters: { status: "open" }, sort: [{ column: "priority", direction: "desc" }] });
  });

  it("clears one filter with null and keeps the others", async () => {
    await ctx.reg.applyCommand(setCmd({ filters: { status: "open", department: "kitchen" } }));
    const r = await ctx.reg.applyCommand(setCmd({ filters: { status: null } }));
    expect(r.success && r.data).toMatchObject({ state: { filters: { department: "kitchen" } } });
  });

  it.each([
    ["an unknown filter value", { filters: { status: "nope" } }],
    ["an unknown filter key", { filters: { colour: "red" } }],
    ["an unsortable column", { sort: [{ column: "createdAt", direction: "asc" }] }],
    ["too many sort keys", { sort: [{ column: "title", direction: "asc" }, { column: "priority", direction: "asc" }] }],
    ["an unknown top-level key", { page: 2 }],
  ])("rejects %s with UI_INVALID_PATCH and changes nothing", async (_why, patch) => {
    const r = await ctx.reg.applyCommand(setCmd(patch));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("UI_INVALID_PATCH");
    expect(ctx.getState()).toEqual({ filters: {}, sort: [] });
    expect(ctx.reg.get("t.table")!.version).toBe(1);
  });

  it("rejects a stale expectedVersion after the user changed the state", async () => {
    ctx.setStateExternally({ filters: { status: "done" }, sort: [] });
    ctx.reg.touch("t.table");
    expect(ctx.reg.get("t.table")!.version).toBe(2);
    const r = await ctx.reg.applyCommand(setCmd({ filters: { status: "open" } }, 1));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("UI_STALE_STATE");
    expect(ctx.getState()).toEqual({ filters: { status: "done" }, sort: [] });
  });

  it("touch() without a real change keeps the version", () => {
    ctx.reg.touch("t.table");
    expect(ctx.reg.get("t.table")!.version).toBe(1);
  });

  it("runs actions and reports the resulting state", async () => {
    await ctx.reg.applyCommand(setCmd({ filters: { status: "open" } }));
    const r = await ctx.reg.applyCommand({ cmdId: "c2", type: "action", componentId: "t.table", action: "reset" });
    expect(r).toEqual({ success: true, data: { componentId: "t.table", action: "reset", state: { filters: {}, sort: [] }, version: 3 } });
  });

  it("reports unknown components and actions", async () => {
    const a = await ctx.reg.applyCommand({ ...setCmd({}), componentId: "nope" });
    expect(!a.success && a.error.code).toBe("UI_COMPONENT_NOT_FOUND");
    expect(!a.success && a.error.message).toContain("t.table");
    const b = await ctx.reg.applyCommand({ cmdId: "c3", type: "action", componentId: "t.table", action: "explode" });
    expect(!b.success && b.error.code).toBe("UI_UNKNOWN_ACTION");
  });

  it("unregister removes it; a stale unregister never removes a re-registration", async () => {
    const { reg, registration, unregister } = ctx;
    const again = reg.register({ ...registration });
    unregister(); // stale: from the first registration
    expect(reg.get("t.table")).toBeDefined();
    again();
    expect(reg.get("t.table")).toBeUndefined();
  });

  it("notifies subscribers on changes", async () => {
    let calls = 0;
    ctx.reg.subscribe(() => calls++);
    await ctx.reg.applyCommand(setCmd({ filters: { status: "open" } }));
    expect(calls).toBe(1);
  });
});

describe("tabs kind", () => {
  it("activeTab() reads the first tabs component and the enum limits values", async () => {
    const { UiComponentRegistry } = await import("@/lib/ui-components/registry");
    const { tabsStateSchema } = await import("@/lib/ui-components/kinds");
    const reg = new UiComponentRegistry();
    let state: Record<string, unknown> = { activeTab: "reservations" };
    reg.register({
      id: "app.nav", kind: "tabs", title: "Tabs",
      schema: tabsStateSchema(["reservations", "tasks"] as const) as never,
      getState: () => state, setState: (s) => { state = s; },
    });
    expect(reg.activeTab()).toBe("reservations");
    const ok = await reg.applyCommand({ cmdId: "c", type: "set_state", componentId: "app.nav", patch: { activeTab: "tasks" } });
    expect(ok.success).toBe(true);
    expect(reg.activeTab()).toBe("tasks");
    const hidden = await reg.applyCommand({ cmdId: "c", type: "set_state", componentId: "app.nav", patch: { activeTab: "finance" } });
    expect(!hidden.success && hidden.error.code).toBe("UI_INVALID_PATCH");
  });
});

describe("runUiOpLocally (in-page surface)", () => {
  it("serves all four ops from the given registry", async () => {
    const { runUiOpLocally } = await import("@/lib/ui-components/local");
    const { reg } = await setup();
    const list = await runUiOpLocally("ui_list", {}, reg);
    expect(list.success && (list.data as { components: unknown[] }).components).toHaveLength(1);
    const get = await runUiOpLocally("ui_get_state", { componentId: "t.table" }, reg);
    expect(get).toEqual({ success: true, data: { componentId: "t.table", kind: "table", state: { filters: {}, sort: [] }, version: 1, view: { total: 2, shown: 2 } } });
    const set = await runUiOpLocally("ui_set_state", { componentId: "t.table", patch: { filters: { status: "open" } } }, reg);
    expect(set.success && (set.data as { version: number }).version).toBe(2);
    const act = await runUiOpLocally("ui_action", { componentId: "t.table", action: "reset" }, reg);
    expect(act.success && (act.data as { state: unknown }).state).toEqual({ filters: {}, sort: [] });
    const missing = await runUiOpLocally("ui_get_state", { componentId: "nope" }, reg);
    expect(!missing.success && missing.error.code).toBe("UI_COMPONENT_NOT_FOUND");
  });
});
