import { describe, it, expect } from "vitest";

// setup.ts deletes every store singleton + calls vi.resetModules() before each
// test, so each dynamic import gets a fresh, unseeded set of stores — exactly
// the "cold instance" case these descriptors have to handle.

describe("ALL_DESCRIPTORS — generic round-trip", () => {
  it("every descriptor's snapshot() forces its singleton into existence and is JSON-safe", async () => {
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    for (const d of ALL_DESCRIPTORS) {
      const snap = d.snapshot();
      expect(() => JSON.parse(JSON.stringify(snap))).not.toThrow();
    }
  });

  it("restore(snapshot()) is idempotent for every descriptor", async () => {
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    for (const d of ALL_DESCRIPTORS) {
      const before = JSON.stringify(d.snapshot());
      d.restore(JSON.parse(before));
      expect(JSON.stringify(d.snapshot())).toBe(before);
    }
  });
});

describe("Map-backed descriptors — restore mutates in place", () => {
  it("crmGuests: restore() keeps the same Map instance and reflects new data", async () => {
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    const { crmGuests } = await import("@/lib/seed");

    const before = crmGuests();
    const d = ALL_DESCRIPTORS.find((x) => x.key === "crmGuests")!;
    const snap = d.snapshot() as [string, unknown][];
    const injected: [string, unknown][] = [...snap, ["g_099", { guestId: "g_099", name: "Zed", email: "z@x.com", phone: "", createdAt: "" }]];

    d.restore(injected);

    expect(crmGuests()).toBe(before); // same object every op file already bound
    expect(crmGuests().has("g_099")).toBe(true);
  });
});

describe("Array-backed descriptors — restore mutates in place", () => {
  it("housekeepingScheduleItems: restore() keeps the same array instance", async () => {
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    const { housekeepingScheduleItems } = await import("@/lib/seed");

    const before = housekeepingScheduleItems();
    const d = ALL_DESCRIPTORS.find((x) => x.key === "housekeepingScheduleItems")!;
    d.restore([]);

    expect(housekeepingScheduleItems()).toBe(before);
    expect(housekeepingScheduleItems().length).toBe(0);
  });
});

describe("shiftNotes descriptor", () => {
  it("restore() keeps the same array instance", async () => {
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    const { shiftNotes } = await import("@/lib/seed/frontoffice");

    const before = shiftNotes();
    const d = ALL_DESCRIPTORS.find((x) => x.key === "shiftNotes")!;
    d.restore([]);

    expect(shiftNotes()).toBe(before);
    expect(shiftNotes().length).toBe(0);
  });
});

describe("booking descriptor — tables and bills", () => {
  it("round-trips tables/bills alongside reservations", async () => {
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    const { store } = await import("@/lib/store");

    store.tables.set("t_01", { id: "t_01", status: "occupied", capacity: 2 });
    store.bills.set("res_001", { reservationId: "res_001", tableId: "t_02", items: [], total: 0, generatedAt: "2026-01-01T00:00:00Z" });

    const d = ALL_DESCRIPTORS.find((x) => x.key === "booking")!;
    const snap = d.snapshot();

    store.tables.set("t_01", { id: "t_01", status: "available", capacity: 2 });
    store.bills.delete("res_001");

    d.restore(snap);

    expect(store.tables.get("t_01")).toMatchObject({ status: "occupied" });
    expect(store.bills.get("res_001")).toMatchObject({ tableId: "t_02" });
  });
});

describe("booking descriptor", () => {
  it("does not persist the slot window, only reservations/taken/tables/bills", async () => {
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    const d = ALL_DESCRIPTORS.find((x) => x.key === "booking")!;
    const snap = d.snapshot() as { reservations: unknown[]; taken: string[] };
    expect(snap).toHaveProperty("reservations");
    expect(snap).toHaveProperty("taken");
    expect(Object.keys(snap).sort()).toEqual(["bills", "reservations", "tables", "taken"]);
  });

  it("a reservation created before restore() is visible after, on an otherwise fresh store", async () => {
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    const { store } = await import("@/lib/store");

    const slot = store.getSlots()[0];
    const reservation = store.createReservation(slot.id, "Alice", 1, "u_alice")!;

    const d = ALL_DESCRIPTORS.find((x) => x.key === "booking")!;
    const snap = d.snapshot();

    // Simulate "another instance": a fresh, differently-seeded store, then
    // restore the snapshot onto it — mirrors what hydrate() does on cold start.
    store.restore({ reservations: [], taken: [], tables: [], bills: [] }); // reset in place first
    d.restore(snap);

    expect(store.getReservation(reservation.id, "u_alice")).toBeDefined();
    expect(store.getSlot(slot.id)!.available).toBe(false);
  });
});

describe("tasks descriptor", () => {
  it("round-trips the seq counter alongside the collection", async () => {
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    (globalThis as { __tasksSeq?: number }).__tasksSeq = 7;

    const d = ALL_DESCRIPTORS.find((x) => x.key === "tasks")!;
    const snap = d.snapshot() as { seq: number | null };
    expect(snap.seq).toBe(7);

    delete (globalThis as { __tasksSeq?: number }).__tasksSeq;
    d.restore(snap);
    expect((globalThis as { __tasksSeq?: number }).__tasksSeq).toBe(7);
  });

  it("a null seq (never set) restores as absent, not as the literal value null", async () => {
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    const d = ALL_DESCRIPTORS.find((x) => x.key === "tasks")!;
    const snap = d.snapshot() as { seq: number | null };
    expect(snap.seq).toBeNull();

    (globalThis as { __tasksSeq?: number }).__tasksSeq = 99;
    d.restore(snap);
    expect((globalThis as { __tasksSeq?: number }).__tasksSeq).toBeUndefined();
  });
});

describe("loadedTools via the audit/loaded descriptor", () => {
  it("Set round-trips through the array snapshot and restore() keeps identity", async () => {
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    const { addLoaded, getLoaded } = await import("@/lib/loadedTools");

    addLoaded("tok_1", ["createReservation", "cancelReservation"]);
    const d = ALL_DESCRIPTORS.find((x) => x.key === "loaded")!;
    const snap = d.snapshot();

    getLoaded("tok_1"); // sanity: populated before restore
    d.restore(snap);

    const loaded = getLoaded("tok_1");
    expect(loaded).toBeInstanceOf(Set);
    expect(loaded.has("createReservation")).toBe(true);
    expect(loaded.has("cancelReservation")).toBe(true);
  });

  it("restore() drops entries older than the 24h GC window", async () => {
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    const d = ALL_DESCRIPTORS.find((x) => x.key === "loaded")!;
    const stale: [string, { names: string[]; touchedAt: number }][] = [
      ["old-token", { names: ["staleOp"], touchedAt: Date.now() - 25 * 60 * 60 * 1000 }],
    ];
    d.restore(stale);

    const { getLoaded } = await import("@/lib/loadedTools");
    expect(getLoaded("old-token").size).toBe(0);
  });
});
