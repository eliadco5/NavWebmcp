import { describe, it, expect, vi } from "vitest";

// No UPSTASH_*/KV_* env vars are set anywhere in this suite, so getRedis()
// returns null and every one of these exercises the no-Redis fallback path —
// exactly the local-dev/CI behavior this feature must never disturb.

describe("withSharedState — no Redis configured", () => {
  it("is a pass-through: the handler still runs and its return value is unchanged", async () => {
    const { withSharedState } = await import("@/lib/shared-state");
    const handler = vi.fn(async (x: number) => x * 2);
    const wrapped = withSharedState(handler);

    const result = await wrapped(21);

    expect(result).toBe(42);
    expect(handler).toHaveBeenCalledWith(21);
  });

  it("does not touch any store singleton when disabled", async () => {
    const { withSharedState } = await import("@/lib/shared-state");
    const { crmGuests } = await import("@/lib/seed");

    const before = crmGuests();
    await withSharedState(async () => "ok")();
    expect(crmGuests()).toBe(before); // never replaced, never restored-over
  });

  it("still propagates a thrown error from the handler", async () => {
    const { withSharedState } = await import("@/lib/shared-state");
    const wrapped = withSharedState(async () => {
      throw new Error("boom");
    });
    await expect(wrapped()).rejects.toThrow("boom");
  });

  it("multiple wrapped calls still run sequentially without deadlocking", async () => {
    const { withSharedState } = await import("@/lib/shared-state");
    const wrapped = withSharedState(async (n: number) => n);
    const results = await Promise.all([wrapped(1), wrapped(2), wrapped(3)]);
    expect(results).toEqual([1, 2, 3]);
  });
});

describe("readAuditEntries — no Redis configured", () => {
  it("falls back to the in-process audit log", async () => {
    const { readAuditEntries } = await import("@/lib/shared-state");
    const { auditLog } = await import("@/lib/auditlog");

    auditLog.record("testOp", {}, true, "agent");
    const entries = await readAuditEntries();

    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].operation).toBe("testOp");
  });
});
