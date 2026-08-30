import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BookingStore } from "@/lib/store";

// setup.ts deletes globalThis.__bookingStore + calls vi.resetModules() before each test,
// so each dynamic import gets a freshly seeded BookingStore.

// ── helpers ─────────────────────────────────────────────────────────────────

async function freshStore() {
  const mod = await import("@/lib/store");
  return mod.store as BookingStore;
}

// ── getSlots / getSlot ───────────────────────────────────────────────────────

describe("getSlots", () => {
  it("returns an array", async () => {
    const store = await freshStore();
    expect(Array.isArray(store.getSlots())).toBe(true);
  });

  it("array is non-empty (seed data exists)", async () => {
    const store = await freshStore();
    expect(store.getSlots().length).toBeGreaterThan(0);
  });

  it("each slot has id, date, time, capacity, available fields", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    expect(slot).toHaveProperty("id");
    expect(slot).toHaveProperty("date");
    expect(slot).toHaveProperty("time");
    expect(slot).toHaveProperty("capacity");
    expect(slot).toHaveProperty("available");
  });

  it("slot.date is an ISO date string (YYYY-MM-DD)", async () => {
    const store = await freshStore();
    const { date } = store.getSlots()[0];
    expect(/^\d{4}-\d{2}-\d{2}$/.test(date)).toBe(true);
  });

  it("slot.time is HH:MM format", async () => {
    const store = await freshStore();
    const { time } = store.getSlots()[0];
    expect(/^\d{2}:\d{2}$/.test(time)).toBe(true);
  });

  it("slot.capacity is a positive integer", async () => {
    const store = await freshStore();
    const { capacity } = store.getSlots()[0];
    expect(typeof capacity).toBe("number");
    expect(capacity).toBeGreaterThan(0);
  });

  it("slot.available is a boolean", async () => {
    const store = await freshStore();
    const { available } = store.getSlots()[0];
    expect(typeof available).toBe("boolean");
  });
});

describe("getSlot", () => {
  it("returns undefined for a nonexistent id", async () => {
    const store = await freshStore();
    expect(store.getSlot("nonexistent")).toBeUndefined();
  });

  it("returns the matching slot for a valid id", async () => {
    const store = await freshStore();
    const first = store.getSlots()[0];
    const found = store.getSlot(first.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(first.id);
  });

  it("returns undefined for an empty string id", async () => {
    const store = await freshStore();
    expect(store.getSlot("")).toBeUndefined();
  });
});

// ── searchAvailability ───────────────────────────────────────────────────────

describe("searchAvailability", () => {
  it("returns only slots matching the given date", async () => {
    const store = await freshStore();
    const date = store.getSlots()[0].date;
    const results = store.searchAvailability(date, 1);
    for (const slot of results) {
      expect(slot.date).toBe(date);
    }
  });

  it("returns only slots where available === true", async () => {
    const store = await freshStore();
    const date = store.getSlots()[0].date;
    const results = store.searchAvailability(date, 1);
    for (const slot of results) {
      expect(slot.available).toBe(true);
    }
  });

  it("returns only slots where capacity >= partySize", async () => {
    const store = await freshStore();
    const date = store.getSlots()[0].date;
    const partySize = 3;
    const results = store.searchAvailability(date, partySize);
    for (const slot of results) {
      expect(slot.capacity).toBeGreaterThanOrEqual(partySize);
    }
  });

  it("lazily seeds a far-future date on first touch instead of returning empty", async () => {
    // The old fixed 7-day window meant any date outside it returned []
    // forever — which is exactly the bug that broke booking across serverless
    // instances (instance A's window and instance B's window disagreed).
    // searchAvailability now seeds whatever date it's asked about, on demand.
    const store = await freshStore();
    const results = store.searchAvailability("2099-12-31", 1);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((s) => s.date === "2099-12-31")).toBe(true);
  });

  it("returns empty array when partySize exceeds all slot capacities", async () => {
    const store = await freshStore();
    const date = store.getSlots()[0].date;
    expect(store.searchAvailability(date, 99999)).toEqual([]);
  });

  it("after createReservation the slot is no longer returned for that date", async () => {
    const store = await freshStore();
    const date = store.getSlots()[0].date;
    const slots = store.searchAvailability(date, 1);
    expect(slots.length).toBeGreaterThan(0);
    const slot = slots[0];
    store.createReservation(slot.id, "Test User", 1, "u_alice");
    const afterSlots = store.searchAvailability(date, 1);
    expect(afterSlots.find((s) => s.id === slot.id)).toBeUndefined();
  });
});

// ── createReservation ────────────────────────────────────────────────────────

describe("createReservation", () => {
  it("returns a Reservation with expected fields for a valid request", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const result = store.createReservation(slot.id, "Alice", 1, "u_alice");
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      slotId: slot.id,
      name: "Alice",
      partySize: 1,
      date: slot.date,
      time: slot.time,
      userId: "u_alice",
    });
  });

  it("returns a Reservation with id (string) and createdAt (ISO string)", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const result = store.createReservation(slot.id, "Alice", 1, "u_alice");
    expect(typeof result!.id).toBe("string");
    expect(result!.id.length).toBeGreaterThan(0);
    expect(() => new Date(result!.createdAt).toISOString()).not.toThrow();
  });

  it("succeeds when partySize equals slot capacity", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const result = store.createReservation(slot.id, "Alice", slot.capacity, "u_alice");
    expect(result).not.toBeNull();
  });

  it("returns null when partySize exceeds capacity", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const result = store.createReservation(slot.id, "Alice", slot.capacity + 1, "u_alice");
    expect(result).toBeNull();
  });

  it("returns null for a nonexistent slotId", async () => {
    const store = await freshStore();
    expect(store.createReservation("no-such-id", "Alice", 1, "u_alice")).toBeNull();
  });

  it("returns null when the slot is already reserved (unavailable)", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    store.createReservation(slot.id, "Alice", 1, "u_alice");
    const second = store.createReservation(slot.id, "Bob", 1, "u_bob");
    expect(second).toBeNull();
  });

  it("after success: slot.available becomes false", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    store.createReservation(slot.id, "Alice", 1, "u_alice");
    expect(store.getSlot(slot.id)!.available).toBe(false);
  });

  it("after success: getReservations(userId) includes the new reservation", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice");
    const list = store.getReservations("u_alice");
    expect(list.find((r) => r.id === res!.id)).toBeDefined();
  });
});

// ── getReservations ──────────────────────────────────────────────────────────

describe("getReservations", () => {
  it("returns only reservations belonging to the given userId", async () => {
    const store = await freshStore();
    const slots = store.getSlots();
    store.createReservation(slots[0].id, "Alice", 1, "u_alice");
    const list = store.getReservations("u_alice");
    for (const r of list) {
      expect(r.userId).toBe("u_alice");
    }
  });

  it("returns empty array for a userId with no reservations", async () => {
    const store = await freshStore();
    const slots = store.getSlots();
    store.createReservation(slots[0].id, "Alice", 1, "u_alice");
    expect(store.getReservations("u_bob")).toEqual([]);
  });

  it("reservations for different users are isolated", async () => {
    const store = await freshStore();
    const slots = store.getSlots();
    store.createReservation(slots[0].id, "Alice", 1, "u_alice");
    store.createReservation(slots[1].id, "Bob", 1, "u_bob");
    expect(store.getReservations("u_alice").length).toBe(1);
    expect(store.getReservations("u_bob").length).toBe(1);
  });
});

// ── getReservation ───────────────────────────────────────────────────────────

describe("getReservation", () => {
  it("returns the reservation when id and userId both match", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    const found = store.getReservation(res.id, "u_alice");
    expect(found).toBeDefined();
    expect(found!.id).toBe(res.id);
  });

  it("returns undefined when userId does not match (ownership check)", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    expect(store.getReservation(res.id, "u_bob")).toBeUndefined();
  });

  it("returns undefined for a nonexistent reservation id", async () => {
    const store = await freshStore();
    expect(store.getReservation("nonexistent", "u_alice")).toBeUndefined();
  });
});

// ── cancelReservation ────────────────────────────────────────────────────────

describe("cancelReservation", () => {
  it("returns 'ok' for the owner's own reservation", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    expect(store.cancelReservation(res.id, "u_alice")).toBe("ok");
  });

  it("slot becomes available again after cancellation", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    expect(store.getSlot(slot.id)!.available).toBe(false);
    store.cancelReservation(res.id, "u_alice");
    expect(store.getSlot(slot.id)!.available).toBe(true);
  });

  it("returns 'not_found' for a nonexistent reservation id", async () => {
    const store = await freshStore();
    expect(store.cancelReservation("nonexistent", "u_alice")).toBe("not_found");
  });

  it("returns 'forbidden' when userId does not own the reservation", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    expect(store.cancelReservation(res.id, "u_bob")).toBe("forbidden");
  });

  it("after cancel: reservation no longer appears in getReservations(userId)", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    store.cancelReservation(res.id, "u_alice");
    const list = store.getReservations("u_alice");
    expect(list.find((r) => r.id === res.id)).toBeUndefined();
  });

  it("slot.available is true after a successful cancel", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    store.cancelReservation(res.id, "u_alice");
    expect(store.getSlot(slot.id)!.available).toBe(true);
  });
});

// ── cancelReservationAsAdmin ─────────────────────────────────────────────────

describe("cancelReservationAsAdmin", () => {
  it("returns 'ok' without checking userId", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    expect(store.cancelReservationAsAdmin(res.id)).toBe("ok");
  });

  it("returns 'not_found' for a nonexistent id", async () => {
    const store = await freshStore();
    expect(store.cancelReservationAsAdmin("nonexistent")).toBe("not_found");
  });

  it("slot becomes available again after admin cancel", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    store.cancelReservationAsAdmin(res.id);
    expect(store.getSlot(slot.id)!.available).toBe(true);
  });
});

// ── getAllReservations ───────────────────────────────────────────────────────

describe("getAllReservations", () => {
  it("returns all reservations across users", async () => {
    const store = await freshStore();
    const slots = store.getSlots();
    const r1 = store.createReservation(slots[0].id, "Alice", 1, "u_alice")!;
    const r2 = store.createReservation(slots[1].id, "Bob", 1, "u_bob")!;
    const all = store.getAllReservations();
    const ids = all.map((r) => r.id);
    expect(ids).toContain(r1.id);
    expect(ids).toContain(r2.id);
  });

  it("returns empty array when no reservations exist", async () => {
    const store = await freshStore();
    expect(store.getAllReservations()).toEqual([]);
  });

  it("returns a copy: mutating result does not affect internal state", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    store.createReservation(slot.id, "Alice", 1, "u_alice");
    const all = store.getAllReservations();
    const originalLen = all.length;
    all.push({} as never);
    expect(store.getAllReservations().length).toBe(originalLen);
  });
});

// ── event emission ───────────────────────────────────────────────────────────

describe("event emission", () => {
  it("createReservation emits 'reservation.created' event", async () => {
    const store = await freshStore();
    const listener = vi.fn();
    store.on(listener);
    const slot = store.getSlots()[0];
    store.createReservation(slot.id, "Alice", 1, "u_alice");
    const types = listener.mock.calls.map((c) => c[0].type);
    expect(types).toContain("reservation.created");
  });

  it("createReservation emits 'availability.changed' event", async () => {
    const store = await freshStore();
    const listener = vi.fn();
    store.on(listener);
    const slot = store.getSlots()[0];
    store.createReservation(slot.id, "Alice", 1, "u_alice");
    const types = listener.mock.calls.map((c) => c[0].type);
    expect(types).toContain("availability.changed");
  });

  it("createReservation fires the listener exactly twice (one per event type)", async () => {
    const store = await freshStore();
    const listener = vi.fn();
    store.on(listener);
    const slot = store.getSlots()[0];
    store.createReservation(slot.id, "Alice", 1, "u_alice");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("cancelReservation emits 'reservation.cancelled' event", async () => {
    const store = await freshStore();
    const listener = vi.fn();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    store.on(listener);
    store.cancelReservation(res.id, "u_alice");
    const types = listener.mock.calls.map((c) => c[0].type);
    expect(types).toContain("reservation.cancelled");
  });

  it("cancelReservation emits 'availability.changed' event", async () => {
    const store = await freshStore();
    const listener = vi.fn();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    store.on(listener);
    store.cancelReservation(res.id, "u_alice");
    const types = listener.mock.calls.map((c) => c[0].type);
    expect(types).toContain("availability.changed");
  });

  it("unsubscribe stops listener from receiving further events", async () => {
    const store = await freshStore();
    const listener = vi.fn();
    const unsub = store.on(listener);
    const slots = store.getSlots();
    store.createReservation(slots[0].id, "Alice", 1, "u_alice");
    unsub();
    store.createReservation(slots[1].id, "Bob", 1, "u_bob");
    // Only the first createReservation (2 events) should have reached the listener
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("multiple listeners all receive the same events", async () => {
    const store = await freshStore();
    const l1 = vi.fn();
    const l2 = vi.fn();
    store.on(l1);
    store.on(l2);
    const slot = store.getSlots()[0];
    store.createReservation(slot.id, "Alice", 1, "u_alice");
    expect(l1).toHaveBeenCalledTimes(2);
    expect(l2).toHaveBeenCalledTimes(2);
  });

  it("'reservation.created' event payload contains the new reservation", async () => {
    const store = await freshStore();
    const listener = vi.fn();
    store.on(listener);
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    const createdCall = listener.mock.calls.find(
      (c) => c[0].type === "reservation.created"
    );
    expect(createdCall![0].reservation.id).toBe(res.id);
  });

  it("'availability.changed' event from cancelReservation has available: true", async () => {
    const store = await freshStore();
    const slot = store.getSlots()[0];
    const res = store.createReservation(slot.id, "Alice", 1, "u_alice")!;
    const listener = vi.fn();
    store.on(listener);
    store.cancelReservation(res.id, "u_alice");
    const availCall = listener.mock.calls.find(
      (c) => c[0].type === "availability.changed"
    );
    expect(availCall![0].available).toBe(true);
  });
});
