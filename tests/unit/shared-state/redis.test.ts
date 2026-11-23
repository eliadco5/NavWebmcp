import { describe, it, expect, afterEach, vi } from "vitest";

describe("getRedis", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when REDIS_URL isn't configured", async () => {
    const { getRedis } = await import("@/lib/shared-state/redis");
    expect(await getRedis()).toBeNull();
  });

  it("does not attempt a connection when REDIS_URL isn't configured", async () => {
    // If this tried to connect, it would hang/reject against a nonexistent
    // server instead of resolving null immediately.
    const { getRedis } = await import("@/lib/shared-state/redis");
    const start = Date.now();
    await getRedis();
    expect(Date.now() - start).toBeLessThan(100);
  });
});

// A configured but unreachable Redis must degrade to the in-memory fallback
// quickly. node-redis's connect() never settles while the server is down, so
// without the timeout every request would hang until the platform killed it.
describe("getRedis with an unreachable Redis", () => {
  afterEach(async () => {
    (await import("@/lib/shared-state/redis")).resetRedisClientForTests();
    vi.unstubAllEnvs();
  });

  it("gives up within the connect timeout and returns null", async () => {
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1"); // nothing listens on port 1
    vi.stubEnv("REDIS_CONNECT_TIMEOUT_MS", "300");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getRedis, isRedisDown } = await import("@/lib/shared-state/redis");
    const start = Date.now();
    expect(await getRedis()).toBeNull();
    expect(Date.now() - start).toBeLessThan(1500);
    expect(isRedisDown()).toBe(true);

    // During the cooldown it answers immediately instead of waiting again.
    const again = Date.now();
    expect(await getRedis()).toBeNull();
    expect(Date.now() - again).toBeLessThan(50);
    warn.mockRestore();
  });

  it("the audit trail still records (in memory) and doesn't hang", async () => {
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
    vi.stubEnv("REDIS_CONNECT_TIMEOUT_MS", "300");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { appendAuditEvent } = await import("@/lib/audit/store");
    const start = Date.now();
    const e = await appendAuditEvent({
      v: 1, id: "e1", ts: new Date().toISOString(), category: "operation", action: "op", outcome: "success",
      channel: "ui", actor: { type: "human", userId: "u_alice", role: "customer", assurance: "asserted" },
    });
    expect(e?.seq).toBe(1);
    expect(Date.now() - start).toBeLessThan(1500);
    warn.mockRestore();
  });
});
