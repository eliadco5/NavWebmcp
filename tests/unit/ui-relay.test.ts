// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { adminCtx, supportCtx } from "@/tests/helpers";

// Dynamic imports: setup.ts resets modules (and the relay's globalThis state)
// before each test.

const { jar } = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
  }),
}));

const snap = (tabId: string, over: Record<string, unknown> = {}) => ({
  tabId, activeTab: "tasks", visible: true, focusedAt: 1000, components: [], ...over,
});

describe("relay store", () => {
  it("expires snapshots after SNAPSHOT_TTL_MS", async () => {
    const s = await import("@/lib/ui-relay/store");
    await s.putSnapshot("u1", snap("a"), 0);
    expect(await s.livePages("u1", s.SNAPSHOT_TTL_MS - 1)).toHaveLength(1);
    expect(await s.livePages("u1", s.SNAPSHOT_TTL_MS)).toHaveLength(0);
  });

  it("picks the explicit tab, else visible before hidden, else last focused", async () => {
    const s = await import("@/lib/ui-relay/store");
    await s.putSnapshot("u1", snap("old", { focusedAt: 1 }));
    await s.putSnapshot("u1", snap("new", { focusedAt: 2 }));
    await s.putSnapshot("u1", snap("hidden", { focusedAt: 3, visible: false }));
    expect((await s.pickPage("u1"))!.tabId).toBe("new");
    expect((await s.pickPage("u1", "old"))!.tabId).toBe("old");
    expect(await s.pickPage("u1", "missing")).toBeNull();
    await s.removeSnapshot("u1", "new");
    expect((await s.pickPage("u1"))!.tabId).toBe("old");
  });

  it("delivers each command once, to the right tab", async () => {
    const s = await import("@/lib/ui-relay/store");
    const cmd = { cmdId: "c1", type: "action" as const, componentId: "x", action: "reset" };
    await s.enqueueCommand("u1", "a", cmd);
    expect(await s.claimCommands("u1", "b")).toEqual([]);
    expect(await s.claimCommands("u1", "a")).toEqual([cmd]);
    expect(await s.claimCommands("u1", "a")).toEqual([]);
  });

  it("isolates users: no shared pages, queues or results", async () => {
    const s = await import("@/lib/ui-relay/store");
    await s.putSnapshot("u1", snap("a"));
    expect(await s.livePages("u2")).toEqual([]);
    await s.enqueueCommand("u1", "a", { cmdId: "c1", type: "action", componentId: "x", action: "reset" });
    expect(await s.claimCommands("u2", "a")).toEqual([]);
    await s.putResult("u2", "c1", { success: true, data: {} });
    expect(await s.awaitResult("u1", "c1", { timeoutMs: 30, pollMs: 5 })).toBeUndefined();
  });

  it("awaitResult returns the result once posted, and only once", async () => {
    const s = await import("@/lib/ui-relay/store");
    setTimeout(() => void s.putResult("u1", "c9", { success: true, data: { ok: 1 } }), 20);
    expect(await s.awaitResult("u1", "c9", { timeoutMs: 500, pollMs: 5 })).toEqual({ success: true, data: { ok: 1 } });
    expect(await s.awaitResult("u1", "c9", { timeoutMs: 20, pollMs: 5 })).toBeUndefined();
  });
});

describe("server ui_* ops through the relay", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  async function ops() {
    await import("@/lib/ui-relay/store");
    const { runOne } = await import("@/lib/operations/dispatch");
    await import("@/lib/operations/index");
    return runOne;
  }

  /** A fake browser tab signed in as adminCtx's user. */
  async function fakePage(tabId = "tab_1") {
    const s = await import("@/lib/ui-relay/store");
    const { UiComponentRegistry } = await import("@/lib/ui-components/registry");
    const { tableStateSchema } = await import("@/lib/ui-components/kinds");
    const reg = new UiComponentRegistry();
    let state: Record<string, unknown> = { filters: {}, sort: [] };
    reg.register({
      id: "tasks.table", kind: "table", title: "Tasks",
      schema: tableStateSchema({ status: z.enum(["open"]).optional().describe("s") }, ["priority"] as const) as never,
      getState: () => state, setState: (n) => { state = n; },
    });
    const publish = () => s.putSnapshot(adminCtx.userId, { ...snap(tabId), components: reg.list() });
    await publish();
    const timer = setInterval(async () => {
      for (const cmd of await s.claimCommands(adminCtx.userId, tabId)) {
        await s.putResult(adminCtx.userId, cmd.cmdId, await reg.applyCommand(cmd));
        await publish();
      }
    }, 5);
    stop = () => clearInterval(timer);
    return { getState: () => state };
  }

  it("ui_list / ui_set_state / ui_get_state round-trip to the user's tab", async () => {
    const runOne = await ops();
    const page = await fakePage();
    const list = await runOne("ui_list", {}, adminCtx);
    expect(list.success && list.data).toMatchObject({ tabId: "tab_1", activeTab: "tasks", openTabs: 1 });

    const set = await runOne("ui_set_state", {
      componentId: "tasks.table",
      patch: { filters: { status: "open" }, sort: [{ column: "priority", direction: "desc" }] },
    }, adminCtx);
    expect(set).toEqual({ success: true, data: {
      componentId: "tasks.table",
      state: { filters: { status: "open" }, sort: [{ column: "priority", direction: "desc" }] },
      version: 2,
    } });
    expect(page.getState()).toMatchObject({ filters: { status: "open" } });

    const get = await runOne("ui_get_state", { componentId: "tasks.table" }, adminCtx);
    expect(get.success && (get.data as { version: number }).version).toBe(2);
  });

  it("passes the page's validation error through", async () => {
    const runOne = await ops();
    await fakePage();
    const r = await runOne("ui_set_state", { componentId: "tasks.table", patch: { filters: { status: "bogus" } } }, adminCtx);
    expect(!r.success && r.error.code).toBe("UI_INVALID_PATCH");
  });

  it("UI_NO_ACTIVE_PAGE when the user has no open tab, even if another user has one", async () => {
    const runOne = await ops();
    await fakePage();
    for (const name of ["ui_list", "ui_set_state"]) {
      const args = name === "ui_list" ? {} : { componentId: "tasks.table", patch: {} };
      const r = await runOne(name, args, supportCtx);
      expect(!r.success && r.error.code, name).toBe("UI_NO_ACTIVE_PAGE");
    }
  });

  it("UI_TIMEOUT when the tab never answers", async () => {
    const runOne = await ops();
    const s = await import("@/lib/ui-relay/store");
    s.relayTuning.timeoutMs = 40;
    s.relayTuning.pollMs = 5;
    await s.putSnapshot(adminCtx.userId, snap("dead"));
    const r = await runOne("ui_action", { componentId: "tasks.table", action: "reset" }, adminCtx);
    expect(!r.success && r.error.code).toBe("UI_TIMEOUT");
  });

  it("UI_COMPONENT_NOT_FOUND from ui_get_state lists what is mounted", async () => {
    const runOne = await ops();
    await fakePage();
    const r = await runOne("ui_get_state", { componentId: "finance.table" }, adminCtx);
    expect(!r.success && r.error.code).toBe("UI_COMPONENT_NOT_FOUND");
    expect(!r.success && r.error.message).toContain("tasks.table");
  });

  it("ui_* ops are never destructive and need no confirmation", async () => {
    await import("@/lib/operations/index");
    const { registry } = await import("@/lib/operations/registry");
    const { mcpAnnotations } = await import("@/lib/adapters/mcp");
    for (const op of registry.filter((o) => o.name.startsWith("ui_"))) {
      expect(op.requiresConfirmation, op.name).toBeFalsy();
      expect(op.runsInPage && op.alwaysOn, op.name).toBe(true);
      expect(mcpAnnotations(op).destructiveHint, op.name).toBe(false);
    }
  });
});

describe("relay routes", () => {
  beforeEach(async () => {
    const { createSession } = await import("@/lib/auth-tokens");
    const { getUserById, SESSION_COOKIE } = await import("@/lib/auth");
    jar.set(SESSION_COOKIE, createSession(getUserById("u_bob")!));
  });

  const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });

  it("snapshot → relay → result, scoped to the session's user", async () => {
    const snapshotRoute = await import("@/app/api/ui/snapshot/route");
    const relayRoute = await import("@/app/api/ui/relay/route");
    const s = await import("@/lib/ui-relay/store");

    expect((await snapshotRoute.POST(post(snap("tab_r")))).status).toBe(200);
    expect((await s.pickPage("u_bob"))!.tabId).toBe("tab_r");

    await s.enqueueCommand("u_bob", "tab_r", { cmdId: "c1", type: "action", componentId: "x", action: "reset" });
    const first = await (await relayRoute.POST(post({ tabId: "tab_r" }))).json();
    expect(first.data.commands).toHaveLength(1);

    await relayRoute.POST(post({ tabId: "tab_r", results: [{ cmdId: "c1", result: { success: true, data: { ok: true } } }] }));
    expect(await s.awaitResult("u_bob", "c1", { timeoutMs: 10, pollMs: 5 })).toEqual({ success: true, data: { ok: true } });

    await snapshotRoute.POST(post({ tabId: "tab_r", closed: true }));
    expect(await s.pickPage("u_bob")).toBeNull();
  });

  it("rejects malformed snapshots and unauthenticated callers", async () => {
    const snapshotRoute = await import("@/app/api/ui/snapshot/route");
    expect((await snapshotRoute.POST(post({ tabId: "" }))).status).toBe(400);
    jar.clear();
    expect((await snapshotRoute.POST(post(snap("tab_r")))).status).toBe(401);
  });
});
