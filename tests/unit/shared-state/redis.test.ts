import { describe, it, expect, afterEach, vi } from "vitest";

describe("getRedis", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when no env vars are configured", async () => {
    const { getRedis } = await import("@/lib/shared-state/redis");
    expect(getRedis()).toBeNull();
  });

  it("returns a client when KV_REST_API_URL/TOKEN are set", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://example.upstash.io");
    vi.stubEnv("KV_REST_API_TOKEN", "test-token");
    const { getRedis, resetRedisClientForTests } = await import("@/lib/shared-state/redis");
    resetRedisClientForTests();
    expect(getRedis()).not.toBeNull();
  });

  it("returns a client when UPSTASH_REDIS_REST_URL/TOKEN are set", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    const { getRedis, resetRedisClientForTests } = await import("@/lib/shared-state/redis");
    resetRedisClientForTests();
    expect(getRedis()).not.toBeNull();
  });

  it("caches the client across calls until reset", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://example.upstash.io");
    vi.stubEnv("KV_REST_API_TOKEN", "test-token");
    const { getRedis, resetRedisClientForTests } = await import("@/lib/shared-state/redis");
    resetRedisClientForTests();
    const a = getRedis();
    const b = getRedis();
    expect(a).toBe(b);
  });
});
