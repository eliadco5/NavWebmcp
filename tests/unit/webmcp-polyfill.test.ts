// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// setup.ts calls vi.resetModules() before each test, so each dynamic import
// produces a fresh module. The polyfill installs modelContext with
// configurable: false, so we can't delete it from the same document object.
// Instead, replace global.document with a fresh plain object each test; the
// polyfill only needs `typeof document !== "undefined"` and a writable object
// to defineProperty on.

beforeEach(() => {
  try {
    Object.defineProperty(global, "document", {
      value: Object.create(null),
      configurable: true,
      writable: true,
    });
  } catch {
    (global as Record<string, unknown>)["document"] = Object.create(null);
  }
});

// ── installWebMCPPolyfill ────────────────────────────────────────────────────

describe("installWebMCPPolyfill", () => {
  it("installs document.modelContext after calling", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    expect(document.modelContext).toBeDefined();
  });

  it("is idempotent: calling twice returns the same modelContext object", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const first = document.modelContext;
    installWebMCPPolyfill();
    expect(document.modelContext).toBe(first);
  });

  it("installed modelContext has registerTool method", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    expect(typeof document.modelContext.registerTool).toBe("function");
  });

  it("installed modelContext has executeTool method", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    expect(typeof document.modelContext.executeTool).toBe("function");
  });

  it("installed modelContext has getTools method", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    expect(typeof document.modelContext.getTools).toBe("function");
  });

  it("installed modelContext has ontoolchange property (initially null)", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    expect("ontoolchange" in document.modelContext).toBe(true);
    expect(document.modelContext.ontoolchange).toBeNull();
  });

  it("installed modelContext has instructions property", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    expect("instructions" in document.modelContext).toBe(true);
  });
});

// ── registerTool — valid names ────────────────────────────────────────────────

function makeTool(name: string) {
  return {
    name,
    description: "a test tool",
    execute: vi.fn().mockResolvedValue("result"),
  };
}

describe("registerTool — valid names", () => {
  it("simple name registers without error", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    await expect(document.modelContext.registerTool(makeTool("myTool"))).resolves.toBeUndefined();
  });

  it("name with dots is accepted", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    await expect(document.modelContext.registerTool(makeTool("my.tool.v2"))).resolves.toBeUndefined();
  });

  it("name with underscores and dashes is accepted", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    await expect(document.modelContext.registerTool(makeTool("my_tool-v2"))).resolves.toBeUndefined();
  });

  it("name exactly 128 characters long is accepted", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const longName = "a".repeat(128);
    await expect(document.modelContext.registerTool(makeTool(longName))).resolves.toBeUndefined();
  });

  it("after registering, getTools() contains the tool", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    await document.modelContext.registerTool(makeTool("myTool"));
    const found = document.modelContext.getTools().find((t) => t.name === "myTool");
    expect(found).toBeDefined();
  });
});

// ── registerTool — invalid names ─────────────────────────────────────────────

describe("registerTool — invalid names (DOMException DataError)", () => {
  it("empty string throws DOMException DataError", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    await expect(document.modelContext.registerTool(makeTool(""))).rejects.toMatchObject({
      name: "DataError",
    });
  });

  it("129-char name throws DOMException DataError", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const tooLong = "a".repeat(129);
    await expect(document.modelContext.registerTool(makeTool(tooLong))).rejects.toMatchObject({
      name: "DataError",
    });
  });

  it("name with '/' throws DOMException DataError", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    await expect(document.modelContext.registerTool(makeTool("my/tool"))).rejects.toMatchObject({
      name: "DataError",
    });
  });

  it("name with spaces throws DOMException DataError", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    await expect(document.modelContext.registerTool(makeTool("my tool"))).rejects.toMatchObject({
      name: "DataError",
    });
  });

  it("name with '@' throws DOMException DataError", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    await expect(document.modelContext.registerTool(makeTool("my@tool"))).rejects.toMatchObject({
      name: "DataError",
    });
  });
});

// ── executeTool ──────────────────────────────────────────────────────────────

describe("executeTool", () => {
  it("throws DOMException NotFoundError for unknown tool", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    await expect(document.modelContext.executeTool("unknown", {})).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("calls the tool's execute function with the provided input", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const execute = vi.fn().mockResolvedValue("done");
    await document.modelContext.registerTool({ name: "myTool", description: "d", execute });
    await document.modelContext.executeTool("myTool", { x: 1 });
    expect(execute).toHaveBeenCalledWith({ x: 1 });
  });

  it("forwards the execute function's return value", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const execute = vi.fn().mockResolvedValue({ answer: 42 });
    await document.modelContext.registerTool({ name: "calcTool", description: "d", execute });
    const result = await document.modelContext.executeTool("calcTool", {});
    expect(result).toEqual({ answer: 42 });
  });

  it("execute function receives exactly the input passed", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const execute = vi.fn().mockResolvedValue(null);
    await document.modelContext.registerTool({ name: "t", description: "d", execute });
    const input = { foo: "bar", nested: { a: 1 } };
    await document.modelContext.executeTool("t", input);
    expect(execute).toHaveBeenCalledWith(input);
  });
});

// ── AbortSignal / unregister ─────────────────────────────────────────────────

describe("AbortSignal / unregister", () => {
  it("tool appears in getTools() before abort", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const controller = new AbortController();
    await document.modelContext.registerTool(makeTool("abortable"), { signal: controller.signal });
    expect(document.modelContext.getTools().find((t) => t.name === "abortable")).toBeDefined();
  });

  it("tool is removed from getTools() after controller.abort()", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const controller = new AbortController();
    await document.modelContext.registerTool(makeTool("abortable"), { signal: controller.signal });
    controller.abort();
    expect(document.modelContext.getTools().find((t) => t.name === "abortable")).toBeUndefined();
  });
});

// ── ontoolchange event ───────────────────────────────────────────────────────

describe("ontoolchange event", () => {
  it("registering a tool dispatches a 'toolchange' CustomEvent", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const listener = vi.fn();
    document.modelContext.addEventListener("toolchange", listener);
    await document.modelContext.registerTool(makeTool("evtTool"));
    expect(listener).toHaveBeenCalledTimes(1);
    document.modelContext.removeEventListener("toolchange", listener);
  });

  it("toolchange event has tool property equal to the registered tool", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const listener = vi.fn();
    document.modelContext.addEventListener("toolchange", listener);
    const tool = makeTool("evtTool2");
    await document.modelContext.registerTool(tool);
    const evt = listener.mock.calls[0][0] as Event & { tool: unknown; action: string };
    expect(evt.tool).toBe(tool);
    document.modelContext.removeEventListener("toolchange", listener);
  });

  it("toolchange event has action === 'registered' on register", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const listener = vi.fn();
    document.modelContext.addEventListener("toolchange", listener);
    await document.modelContext.registerTool(makeTool("evtTool3"));
    const evt = listener.mock.calls[0][0] as Event & { action: string };
    expect(evt.action).toBe("registered");
    document.modelContext.removeEventListener("toolchange", listener);
  });

  it("toolchange event has action === 'unregistered' after abort", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const controller = new AbortController();
    await document.modelContext.registerTool(makeTool("abortEvt"), { signal: controller.signal });
    const listener = vi.fn();
    document.modelContext.addEventListener("toolchange", listener);
    controller.abort();
    const evt = listener.mock.calls[0][0] as Event & { action: string };
    expect(evt.action).toBe("unregistered");
    document.modelContext.removeEventListener("toolchange", listener);
  });

  it("ontoolchange callback property is called on register", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    const cb = vi.fn();
    document.modelContext.ontoolchange = cb;
    await document.modelContext.registerTool(makeTool("cbTool"));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// ── instructions field ───────────────────────────────────────────────────────

describe("instructions field", () => {
  it("is initially null", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    expect(document.modelContext.instructions).toBeNull();
  });

  it("can be set and read back", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    document.modelContext.instructions = "test instructions";
    expect(document.modelContext.instructions).toBe("test instructions");
  });

  it("can be updated multiple times", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    document.modelContext.instructions = "first";
    document.modelContext.instructions = "second";
    expect(document.modelContext.instructions).toBe("second");
  });
});

// ── protocolVersion field ───────────────────────────────────────────────────

describe("protocolVersion field", () => {
  it("is initially null", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    expect(document.modelContext.protocolVersion).toBeNull();
  });

  it("can be set and read back", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    document.modelContext.protocolVersion = "1.0.0";
    expect(document.modelContext.protocolVersion).toBe("1.0.0");
  });

  it("can be updated multiple times", async () => {
    const { installWebMCPPolyfill } = await import("@/lib/webmcp-polyfill");
    installWebMCPPolyfill();
    document.modelContext.protocolVersion = "1.0.0";
    document.modelContext.protocolVersion = "1.1.0";
    expect(document.modelContext.protocolVersion).toBe("1.1.0");
  });
});
