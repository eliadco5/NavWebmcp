import { describe, it, expect } from "vitest";

// setup.ts deletes __auditLog + calls vi.resetModules() before each test.

describe("auditLog.record", () => {
  it("returns an entry with the expected shape", async () => {
    const { auditLog } = await import("@/lib/auditlog");
    const entry = auditLog.record("testOp", { foo: "bar" }, true, "agent");
    expect(entry).toMatchObject({
      operation: "testOp",
      input: { foo: "bar" },
      success: true,
      source: "agent",
    });
  });

  it("id is a non-empty string", async () => {
    const { auditLog } = await import("@/lib/auditlog");
    const entry = auditLog.record("op", {}, true, "ui");
    expect(typeof entry.id).toBe("string");
    expect(entry.id.length).toBeGreaterThan(0);
  });

  it("timestamp is a valid ISO string", async () => {
    const { auditLog } = await import("@/lib/auditlog");
    const entry = auditLog.record("op", {}, true, "ui");
    expect(() => new Date(entry.timestamp).toISOString()).not.toThrow();
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  it("source 'agent' is preserved correctly", async () => {
    const { auditLog } = await import("@/lib/auditlog");
    const entry = auditLog.record("op", {}, true, "agent");
    expect(entry.source).toBe("agent");
  });

  it("source 'ui' is preserved correctly", async () => {
    const { auditLog } = await import("@/lib/auditlog");
    const entry = auditLog.record("op", {}, false, "ui");
    expect(entry.source).toBe("ui");
  });

  it("default source is 'ui' when not specified", async () => {
    const { auditLog } = await import("@/lib/auditlog");
    const entry = auditLog.record("op", {}, true);
    expect(entry.source).toBe("ui");
  });
});

describe("auditLog.getEntries", () => {
  it("returns newest-first: record A then B → B is at index 0", async () => {
    const { auditLog } = await import("@/lib/auditlog");
    const a = auditLog.record("opA", {}, true, "ui");
    const b = auditLog.record("opB", {}, true, "ui");
    const entries = auditLog.getEntries();
    expect(entries[0].id).toBe(b.id);
    expect(entries[1].id).toBe(a.id);
  });

  it("returns a copy: mutating the returned array does not affect internal state", async () => {
    const { auditLog } = await import("@/lib/auditlog");
    auditLog.record("op", {}, true, "ui");
    const entries = auditLog.getEntries();
    const originalLength = entries.length;
    entries.push({ id: "fake", timestamp: "", operation: "fake", input: {}, success: true, source: "ui" });
    expect(auditLog.getEntries().length).toBe(originalLength);
  });

  it("cap at 100: recording 101 entries leaves exactly 100", async () => {
    const { auditLog } = await import("@/lib/auditlog");
    for (let i = 0; i < 101; i++) {
      auditLog.record(`op${i}`, {}, true, "ui");
    }
    expect(auditLog.getEntries().length).toBe(100);
  });

  it("cap at 100: oldest entry is dropped when over the limit", async () => {
    const { auditLog } = await import("@/lib/auditlog");
    // Record first as "oldest"
    const oldest = auditLog.record("oldest", {}, true, "ui");
    for (let i = 0; i < 100; i++) {
      auditLog.record(`newer${i}`, {}, true, "ui");
    }
    const entries = auditLog.getEntries();
    const ids = entries.map((e) => e.id);
    expect(ids).not.toContain(oldest.id);
  });
});
