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
