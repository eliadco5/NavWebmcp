// @vitest-environment node
//
// In-process timing of the Operation architecture (lib/operations/dispatch.ts's
// runOne) with ZERO transport: no HTTP, no MCP client, no browser. This is the
// "function call" side of the speedbase comparison — scripts/speedbase.mjs spawns
// this file as a child process, reads the JSON line it prints, and pairs it with a
// Playwright measurement of the same scenario for the "UI automation" side.
//
// Vitest's default `include` glob requires a {test,spec} filename — an explicit CLI
// path is a FILTER on top of that glob, not an override, so a .bench.ts name can't be
// run directly. Named .test.ts instead; npm test's script was scoped to tests/unit and
// tests/integration (see package.json) so this file never runs as part of that suite.
// Run it explicitly:
//   npx vitest run tests/bench/operation-speed.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { adminCtx, customerCtx } from "@/tests/helpers";
import type { OperationContext } from "@/lib/operations/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runOne: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bookingStore: any;

// tests/setup.ts's global beforeEach deletes every store singleton and calls
// vi.resetModules() before EACH it() below. A static top-of-file `import { runOne }`
// would stay bound to modules resolved before that reset, silently operating on a
// store instance this file can no longer reach via globalThis — same requirement as
// tests/unit/operations/*.test.ts: re-import fresh, inside beforeEach, every time.
beforeEach(async () => {
  await import("@/lib/operations/index");
  const dispatch = await import("@/lib/operations/dispatch");
  runOne = dispatch.runOne;
  const storeMod = await import("@/lib/store");
  bookingStore = storeMod.store;
});

const N = Number(process.env.SPEEDBASE_N ?? 5);

// Resets are only needed BETWEEN iterations within a single it() — the beforeEach
// above already gives each it() a fresh module graph and thus a freshly-seeded store.
// Within one it(), the store binding is stable across iterations, so resetting the
// front-desk portion of it in place (same approach as app/api/bench/reset/route.ts)
// is what actually resets it, without touching any other (customer-booked) reservation.
function resetFrontOffice() {
  bookingStore?.resetFrontDeskSeed();
}

function futureDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

const BOOKING_TIMES = ["10:00", "12:00", "14:00", "18:00", "20:00"];

async function timeIterations(
  n: number,
  runOnce: (i: number) => Promise<unknown>
): Promise<{ msPerRun: number[]; avgMs: number; successCount: number }> {
  const msPerRun: number[] = [];
  let successCount = 0;
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    const result = (await runOnce(i)) as { success?: boolean };
    msPerRun.push(performance.now() - start);
    if (result?.success) successCount++;
  }
  const avgMs = msPerRun.reduce((a, b) => a + b, 0) / msPerRun.length;
  return { msPerRun, avgMs, successCount };
}

// Module-scoped so the final it() below (which runs after resetModules() has already
// wiped everything else) can still read what earlier it()s recorded.
const results: Record<string, { avgMs: number; successRate: string; n: number }> = {};

describe("operation-speed (in-process runOne, no transport)", () => {
  it("book — searchAvailability + createReservation + validate, one runOne('book') call", async () => {
    // No reset needed: seedSlots() seeds 35 (date,time) slots and each iteration below
    // uses a distinct one (futureDate(i) x BOOKING_TIMES[i]), so up to 5 iterations
    // never collide with each other.
    const { avgMs, successCount } = await timeIterations(N, async (i) => {
      const ctx: OperationContext = { userId: customerCtx.userId, role: customerCtx.role, token: customerCtx.token };
      return runOne(
        "book",
        { date: futureDate(i), time: BOOKING_TIMES[i % BOOKING_TIMES.length], partySize: 2, name: `Speedbase Guest ${i + 1}` },
        ctx
      );
    });
    results.book = { avgMs, successRate: `${successCount}/${N}`, n: N };
    expect(successCount).toBe(N);
  });

  it("seatGuest — getOccupancy + checkInGuest + validate, one runOne('seatGuest') call", async () => {
    const { avgMs, successCount } = await timeIterations(N, async (i) => {
      if (i > 0) resetFrontOffice(); // res_003 is the only seeded reservation that fits an available table
      const ctx: OperationContext = { userId: adminCtx.userId, role: adminCtx.role, token: adminCtx.token };
      return runOne("seatGuest", { reservationId: "res_003" }, ctx);
    });
    results.seatGuest = { avgMs, successRate: `${successCount}/${N}`, n: N };
    expect(successCount).toBe(N);
  });

  it("hostVipGuest — 7-op CRM+frontoffice chain, one runOne('hostVipGuest') call (function-only, no UI exists)", async () => {
    const { avgMs, successCount } = await timeIterations(N, async (i) => {
      if (i > 0) resetFrontOffice();
      const ctx: OperationContext = { userId: adminCtx.userId, role: adminCtx.role, token: adminCtx.token };
      return runOne(
        "hostVipGuest",
        { reservationId: "res_003", guestId: "g_003", pointsToAward: 100, visitNote: `Speedbase visit ${i + 1}` },
        ctx
      );
    });
    results.hostVipGuest = { avgMs, successRate: `${successCount}/${N}`, n: N };
    expect(successCount).toBe(N);
  });

  it("prints results as a single JSON line for scripts/speedbase.mjs to parse", () => {
    // A stable, greppable marker line — speedbase.mjs finds this exact prefix in the
    // child process's stdout rather than parsing vitest's own reporter output.
    console.log(`SPEEDBASE_RESULT ${JSON.stringify(results)}`);
    expect(Object.keys(results)).toEqual(["book", "seatGuest", "hostVipGuest"]);
  });
});
