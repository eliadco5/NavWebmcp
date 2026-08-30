import { describe, it, expect } from "vitest";

describe("withStateLock", () => {
  it("runs a single call and returns its result", async () => {
    const { withStateLock } = await import("@/lib/shared-state/mutex");
    const result = await withStateLock(async () => 42);
    expect(result).toBe(42);
  });

  it("serializes overlapping calls: no two bodies run concurrently", async () => {
    const { withStateLock } = await import("@/lib/shared-state/mutex");
    let active = 0;
    let maxActive = 0;

    async function task() {
      return withStateLock(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    }

    await Promise.all([task(), task(), task()]);
    expect(maxActive).toBe(1);
  });

  it("preserves call order (FIFO)", async () => {
    const { withStateLock } = await import("@/lib/shared-state/mutex");
    const order: number[] = [];
    async function task(n: number) {
      return withStateLock(async () => {
        order.push(n);
      });
    }
    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("a rejection does not block subsequent calls", async () => {
    const { withStateLock } = await import("@/lib/shared-state/mutex");

    await expect(
      withStateLock(async () => {
        throw new Error("first fails");
      })
    ).rejects.toThrow("first fails");

    const result = await withStateLock(async () => "still works");
    expect(result).toBe("still works");
  });

  it("a nested call runs immediately instead of deadlocking against its own queue", async () => {
    const { withStateLock } = await import("@/lib/shared-state/mutex");
    const result = await withStateLock(async () => {
      return withStateLock(async () => "inner");
    });
    expect(result).toBe("inner");
  });
});
