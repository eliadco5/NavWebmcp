import { describe, it, expect, beforeEach } from "vitest";
import type { Operation } from "@/lib/operations/types";

// Dynamic imports used because setup.ts resets modules before each test.

describe("computeCapabilityHash", () => {
  it("returns an 8-character hex string for an empty op list", async () => {
    const { computeCapabilityHash } = await import("@/lib/capabilities");
    const v = computeCapabilityHash([]);
    expect(typeof v).toBe("string");
    expect(v).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is stable: same ops → same hash", async () => {
    await import("@/lib/operations/index");
    const { computeCapabilityHash } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const v1 = computeCapabilityHash(registry);
    const v2 = computeCapabilityHash(registry);
    expect(v1).toBe(v2);
  });

  it("changes when ops differ (adding one op changes the hash)", async () => {
    await import("@/lib/operations/index");
    const { computeCapabilityHash } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const before = computeCapabilityHash(registry);

    // Create a synthetic extra op
    const extraOp: Operation = {
      name: "syntheticTestOp",
      title: "Synthetic",
      description: "test",
      inputSchema: {},
      permission: "read",
      roles: ["admin"],
      handler: async () => ({ success: true, data: null }),
    };
    const after = computeCapabilityHash([...registry, extraOp]);
    expect(before).not.toBe(after);
  });

  it("different op order → same hash (sorted internally)", async () => {
    await import("@/lib/operations/index");
    const { computeCapabilityHash } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const reversed = [...registry].reverse();
    expect(computeCapabilityHash(registry)).toBe(computeCapabilityHash(reversed));
  });

  it("returns a different hash for two different op arrays", async () => {
    const { computeCapabilityHash } = await import("@/lib/capabilities");
    const op1: Operation = {
      name: "opA",
      title: "A",
      description: "a",
      inputSchema: {},
      permission: "read",
      roles: ["customer"],
      handler: async () => ({ success: true, data: null }),
    };
    const op2: Operation = {
      name: "opB",
      title: "B",
      description: "b",
      inputSchema: {},
      permission: "write",
      roles: ["admin"],
      handler: async () => ({ success: true, data: null }),
    };
    expect(computeCapabilityHash([op1])).not.toBe(computeCapabilityHash([op2]));
  });
});

describe("visibleOps", () => {
  it("customer does not see admin-only ops (listAllReservations, cancelAnyReservation, getDailyRevenueSummary)", async () => {
    await import("@/lib/operations/index");
    const { visibleOps } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const ops = visibleOps("customer", registry);
    const names = ops.map((o) => o.name);
    expect(names).not.toContain("listAllReservations");
    expect(names).not.toContain("cancelAnyReservation");
    expect(names).not.toContain("getDailyRevenueSummary");
  });

  it("admin sees all ops", async () => {
    await import("@/lib/operations/index");
    const { visibleOps } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const adminOps = visibleOps("admin", registry);
    const names = adminOps.map((o) => o.name);
    expect(names).toContain("listAllReservations");
    expect(names).toContain("cancelAnyReservation");
    expect(names).toContain("getDailyRevenueSummary");
    expect(names).toContain("createReservation");
    // Admin should see at least as many ops as any other role
    const customerOps = visibleOps("customer", registry);
    expect(adminOps.length).toBeGreaterThanOrEqual(customerOps.length);
  });

  it("support does not see admin-only finance ops (getDailyRevenueSummary)", async () => {
    await import("@/lib/operations/index");
    const { visibleOps } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const ops = visibleOps("support", registry);
    const names = ops.map((o) => o.name);
    expect(names).not.toContain("getDailyRevenueSummary");
    expect(names).not.toContain("issueRefund");
  });

  it("support includes support-accessible ops like listAllReservations", async () => {
    await import("@/lib/operations/index");
    const { visibleOps } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const ops = visibleOps("support", registry);
    const names = ops.map((o) => o.name);
    expect(names).toContain("listAllReservations");
    expect(names).toContain("createReservation");
  });

  it("customer sees booking ops that allow customer role", async () => {
    await import("@/lib/operations/index");
    const { visibleOps } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const ops = visibleOps("customer", registry);
    const names = ops.map((o) => o.name);
    expect(names).toContain("createReservation");
    expect(names).toContain("searchAvailability");
    expect(names).toContain("listReservations");
  });
});

describe("capabilityManifest", () => {
  it("returns {protocolVersion, capabilityHash, count, tools} shape for admin", async () => {
    await import("@/lib/operations/index");
    const { capabilityManifest } = await import("@/lib/capabilities");
    const { PROTOCOL_VERSION } = await import("@/lib/protocol");
    const { registry } = await import("@/lib/operations/index");
    const manifest = capabilityManifest("admin", registry);
    expect(manifest.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(typeof manifest.capabilityHash).toBe("string");
    expect(typeof manifest.count).toBe("number");
    expect(Array.isArray(manifest.tools)).toBe(true);
    expect(manifest).not.toHaveProperty("version");
  });

  it("each tool has {name, title, permission, roles, requiresConfirmation}", async () => {
    await import("@/lib/operations/index");
    const { capabilityManifest } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const manifest = capabilityManifest("admin", registry);
    for (const tool of manifest.tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.title).toBe("string");
      expect(typeof tool.permission).toBe("string");
      expect(Array.isArray(tool.roles)).toBe(true);
      expect(typeof tool.requiresConfirmation).toBe("boolean");
    }
  });

  it("customer manifest has fewer tools than admin manifest", async () => {
    await import("@/lib/operations/index");
    const { capabilityManifest } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const adminManifest = capabilityManifest("admin", registry);
    const customerManifest = capabilityManifest("customer", registry);
    expect(customerManifest.count).toBeLessThan(adminManifest.count);
    expect(customerManifest.tools.length).toBeLessThan(adminManifest.tools.length);
  });

  it("count matches tools array length", async () => {
    await import("@/lib/operations/index");
    const { capabilityManifest } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const manifest = capabilityManifest("support", registry);
    expect(manifest.count).toBe(manifest.tools.length);
  });

  it("requiresConfirmation defaults to false for ops without it set", async () => {
    await import("@/lib/operations/index");
    const { capabilityManifest } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const manifest = capabilityManifest("customer", registry);
    // createReservation does NOT have requiresConfirmation set
    const tool = manifest.tools.find((t) => t.name === "createReservation");
    expect(tool).toBeDefined();
    expect(tool!.requiresConfirmation).toBe(false);
  });

  it("requiresConfirmation is true for ops that set it", async () => {
    await import("@/lib/operations/index");
    const { capabilityManifest } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const manifest = capabilityManifest("admin", registry);
    const issueRefund = manifest.tools.find((t) => t.name === "issueRefund");
    expect(issueRefund).toBeDefined();
    expect(issueRefund!.requiresConfirmation).toBe(true);
    const cancelAny = manifest.tools.find((t) => t.name === "cancelAnyReservation");
    expect(cancelAny).toBeDefined();
    expect(cancelAny!.requiresConfirmation).toBe(true);
  });

  it("capabilityHash in manifest is an 8-char hex string", async () => {
    await import("@/lib/operations/index");
    const { capabilityManifest } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const manifest = capabilityManifest("admin", registry);
    expect(manifest.capabilityHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("admin and customer differ on capabilityHash but agree on protocolVersion", async () => {
    await import("@/lib/operations/index");
    const { capabilityManifest } = await import("@/lib/capabilities");
    const { registry } = await import("@/lib/operations/index");
    const adminM = capabilityManifest("admin", registry);
    const customerM = capabilityManifest("customer", registry);
    expect(adminM.capabilityHash).not.toBe(customerM.capabilityHash);
    expect(adminM.protocolVersion).toBe(customerM.protocolVersion);
  });
});
