// @vitest-environment node
import { describe, it, expect } from "vitest";
import { adminCtx } from "@/tests/helpers";

type T = { taskId: string; priority: "low" | "medium" | "high"; status: string; title: string; createdAt: string };

async function search(args: Record<string, unknown>): Promise<T[]> {
  await import("@/lib/operations/index");
  const { runOne } = await import("@/lib/operations/dispatch");
  const r = await runOne("searchTasks", args, adminCtx);
  if (!r.success) throw new Error(r.error.message);
  return (r.data as { tasks: T[] }).tasks;
}

const RANK = { low: 0, medium: 1, high: 2 };

describe("searchTasks sorting", () => {
  it("without sortBy keeps store order", async () => {
    const a = await search({});
    const b = await search({ sortDir: "desc" }); // sortDir alone is ignored
    expect(b.map((t) => t.taskId)).toEqual(a.map((t) => t.taskId));
  });

  it("sorts priority by rank, both directions", async () => {
    const asc = await search({ sortBy: "priority" });
    const desc = await search({ sortBy: "priority", sortDir: "desc" });
    const ranks = (ts: T[]) => ts.map((t) => RANK[t.priority]);
    expect(ranks(asc)).toEqual([...ranks(asc)].sort((x, y) => x - y));
    expect(ranks(desc)).toEqual([...ranks(desc)].sort((x, y) => y - x));
    expect(new Set(ranks(asc)).size).toBeGreaterThan(1); // the seed actually exercises it
  });

  it("sorts strings and combines with filters", async () => {
    const titles = (await search({ sortBy: "title", sortDir: "asc" })).map((t) => t.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    const open = await search({ status: "open", sortBy: "createdAt", sortDir: "desc" });
    expect(open.every((t) => t.status === "open")).toBe(true);
    const created = open.map((t) => t.createdAt);
    expect(created).toEqual([...created].sort().reverse());
  });

  it("rejects an unknown sort column", async () => {
    await import("@/lib/operations/index");
    const { runOne } = await import("@/lib/operations/dispatch");
    const r = await runOne("searchTasks", { sortBy: "assigneeId" }, adminCtx);
    expect(!r.success && r.error.code).toBe("INVALID_ARGS");
  });
});
