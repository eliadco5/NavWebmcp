export interface Slot {
  id: string;
  date: string;       // ISO date "YYYY-MM-DD"
  time: string;       // "HH:MM"
  capacity: number;
  available: boolean;
}

export interface Reservation {
  id: string;
  /** Display name — the same field whether the reservation came from a
   *  customer's own booking or was seeded/created at the front desk. */
  name: string;
  partySize: number;
  createdAt: string;
  status: "pending" | "checked-in" | "checked-out" | "cancelled";
  /** Set only for reservations created via createReservation (tied to a
   *  bookable time slot). Front-desk-originated reservations have none. */
  slotId?: string;
  date?: string;
  time?: string;
  /** Set when a signed-in customer owns this reservation (the booking flow). */
  userId?: string;
  /** Set when linked to a CRM guest profile (front-desk / VIP-hosting flow). */
  guestId?: string;
  /** Set once checked in. */
  tableId?: string;
}

export interface Table {
  id: string;
  status: "available" | "occupied" | "reserved";
  capacity: number;
  reservationId?: string;
  seatedAt?: string;
  guestId?: string;
}

export interface Bill {
  reservationId: string;
  tableId: string;
  items: { name: string; qty: number; price: number }[];
  total: number;
  generatedAt: string;
}

export interface BookingStoreSnapshot {
  reservations: Reservation[];
  /** Ids of slots currently unavailable. Everything else is available by
   *  construction — see snapshot()/restore() below for why the slot window
   *  itself is never persisted. */
  taken: string[];
  tables: [string, Table][];
  bills: [string, Bill][];
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const TIMES = ["10:00", "12:00", "14:00", "18:00", "20:00"] as const;
const CAPACITY_BY_TIME: Record<string, number> = {
  "10:00": 4, "12:00": 6, "14:00": 4, "18:00": 8, "20:00": 6,
};

/** Deterministic, self-describing slot id — e.g. "slot_2026-08-30_1800".
 *
 * The original id was `Math.random()` generated at module init, which meant two
 * things on Vercel: (1) every serverless instance seeded a DIFFERENT random id
 * for "today at 18:00", so a searchAvailability on instance A returned an id
 * createReservation on instance B didn't recognise — the booking flow failed
 * silently across instances; (2) the whole 7-day window was seeded once at cold
 * start, so a long-lived instance would keep offering yesterday's dates forever
 * and never grow into day 8.
 *
 * Encoding date+time directly in the id fixes both: any instance can derive
 * which date a slot belongs to from the id alone and lazily seed that date on
 * first touch (see ensureDate below), so there's nothing to disagree about. */
function slotId(date: string, time: string): string {
  return `slot_${date}_${time.replace(":", "")}`;
}

// Seed for the front desk's 5 physical tables and 3 pre-existing reservations —
// moved here verbatim from lib/seed/frontoffice.ts when the customer-booking
// store and the front-desk store were merged into one (a booking made via
// createReservation used to be invisible to checkInGuest and vice versa,
// because they read from two entirely separate, unconnected datasets). Other
// seed data (lib/seed/finance.ts's payments) references these reservation ids
// by value, so they're preserved exactly rather than renumbered.
function seedTables(): [string, Table][] {
  return [
    ["t_01", { id: "t_01", status: "available", capacity: 2 }],
    ["t_02", { id: "t_02", status: "occupied", capacity: 4, reservationId: "res_001", seatedAt: new Date(Date.now() - 45 * 60000).toISOString(), guestId: "g_001" }],
    ["t_03", { id: "t_03", status: "available", capacity: 4 }],
    ["t_04", { id: "t_04", status: "reserved", capacity: 6, reservationId: "res_002" }],
    ["t_05", { id: "t_05", status: "available", capacity: 2 }],
  ];
}

function seedFrontDeskReservations(): Reservation[] {
  return [
    { id: "res_001", guestId: "g_001", name: "Alice Martin", partySize: 2, tableId: "t_02", status: "checked-in", createdAt: new Date(Date.now() - 45 * 60000).toISOString() },
    { id: "res_002", guestId: "g_002", name: "Bob Chen", partySize: 5, status: "pending", createdAt: new Date().toISOString() },
    { id: "res_003", guestId: "g_003", name: "Carol Diaz", partySize: 3, status: "pending", createdAt: new Date().toISOString() },
  ];
}

class BookingStore {
  private slots = new Map<string, Slot>();
  private reservations: Reservation[] = seedFrontDeskReservations();
  private tableMap = new Map<string, Table>(seedTables());
  private billMap = new Map<string, Bill>();

  /** Physical seating tables (t_01..t_05) — used by the front-desk operations
   *  (checkInGuest, getOccupancy, getWaitTime, ...) via the same Map.get/set
   *  calls they always used; only their import of `store` changed. */
  get tables(): Map<string, Table> {
    return this.tableMap;
  }

  get bills(): Map<string, Bill> {
    return this.billMap;
  }

  /** Seed the 5 daily time slots for `date` if they don't exist yet. Idempotent
   *  and cheap — safe to call on every read. */
  private ensureDate(date: string): void {
    for (const time of TIMES) {
      const id = slotId(date, time);
      if (!this.slots.has(id)) {
        this.slots.set(id, { id, date, time, capacity: CAPACITY_BY_TIME[time], available: true });
      }
    }
  }

  /** Seed today + the next 6 days — the rolling 7-day window the UI's date
   *  picker expects, computed from the current request time rather than once
   *  at module init. */
  private ensureWindow(): void {
    const start = new Date();
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + d);
      this.ensureDate(date.toISOString().slice(0, 10));
    }
  }

  getSlots(): Slot[] {
    this.ensureWindow();
    return Array.from(this.slots.values());
  }

  getSlot(id: string): Slot | undefined {
    // Self-heal: an id encodes its own date, so a cold instance that has never
    // seeded that date yet can still resolve it correctly on first lookup.
    const m = /^slot_(\d{4}-\d{2}-\d{2})_\d{4}$/.exec(id);
    if (m) this.ensureDate(m[1]);
    return this.slots.get(id);
  }

  searchAvailability(date: string, partySize: number): Slot[] {
    this.ensureDate(date);
    return Array.from(this.slots.values()).filter(
      (s) => s.date === date && s.available && s.capacity >= partySize
    );
  }

  getReservations(userId: string): Reservation[] {
    return this.reservations.filter((r) => r.userId === userId);
  }

  getReservation(id: string, userId: string): Reservation | undefined {
    return this.reservations.find((r) => r.id === id && r.userId === userId);
  }

  /** Unscoped lookup by id, for the front-desk operations — a host isn't the
   *  reservation's owner the way a customer is, so there's no userId to scope by. */
  getReservationById(id: string): Reservation | undefined {
    return this.reservations.find((r) => r.id === id);
  }

  /** Merge a partial patch into the reservation in place — used by
   *  checkInGuest/checkOutGuest instead of reaching into the array directly. */
  updateReservation(id: string, patch: Partial<Reservation>): Reservation | undefined {
    const idx = this.reservations.findIndex((r) => r.id === id);
    if (idx === -1) return undefined;
    this.reservations[idx] = { ...this.reservations[idx], ...patch };
    return this.reservations[idx];
  }

  createReservation(
    slotId: string,
    name: string,
    partySize: number,
    userId: string
  ): Reservation | null {
    const slot = this.getSlot(slotId);
    if (!slot || !slot.available || slot.capacity < partySize) return null;

    const reservation: Reservation = {
      id: generateId(),
      slotId,
      name,
      partySize,
      date: slot.date,
      time: slot.time,
      createdAt: new Date().toISOString(),
      userId,
      status: "pending",
    };

    slot.available = false;
    this.reservations.push(reservation);

    return reservation;
  }

  cancelReservation(id: string, userId: string): "ok" | "not_found" | "forbidden" {
    const idx = this.reservations.findIndex((r) => r.id === id);
    if (idx === -1) return "not_found";
    if (this.reservations[idx].userId !== userId) return "forbidden";

    const reservation = this.reservations[idx];
    this.reservations.splice(idx, 1);

    const slot = reservation.slotId ? this.getSlot(reservation.slotId) : undefined;
    if (slot) slot.available = true;

    return "ok";
  }

  getAllReservations(): Reservation[] {
    return [...this.reservations];
  }

  cancelReservationAsAdmin(id: string): "ok" | "not_found" {
    const idx = this.reservations.findIndex((r) => r.id === id);
    if (idx === -1) return "not_found";

    const reservation = this.reservations[idx];
    this.reservations.splice(idx, 1);

    const slot = reservation.slotId ? this.getSlot(reservation.slotId) : undefined;
    if (slot) slot.available = true;

    return "ok";
  }

  /** Restore the 5 front-desk tables, clear bills, and reset the 3 seeded
   *  front-desk reservations to their seeded values IN PLACE — everything else
   *  in `reservations` (anything a customer actually booked) is untouched. Used
   *  by "Reset Demo Data" (lib/seed/index.ts's resetAllSeedStores), the
   *  recovery button for a judge who's checked every seeded guest out. */
  resetFrontDeskSeed(): void {
    this.tableMap.clear();
    for (const [id, table] of seedTables()) this.tableMap.set(id, table);
    this.billMap.clear();

    const seeded = new Map(seedFrontDeskReservations().map((r) => [r.id, r]));
    for (let i = 0; i < this.reservations.length; i++) {
      const seed = seeded.get(this.reservations[i].id);
      if (seed) {
        this.reservations[i] = seed;
        seeded.delete(this.reservations[i].id);
      }
    }
    // Any seeded id not found above (e.g. never touched this instance yet, or
    // somehow removed) gets re-inserted.
    for (const remaining of seeded.values()) this.reservations.push(remaining);
  }

  /** For lib/shared-state. Deliberately does NOT snapshot `slots` — it's a
   *  rolling 7-day window regenerated deterministically from today's date (see
   *  ensureWindow/ensureDate above), so persisting it would resurrect a stale
   *  window on a cold instance days later. Tables and bills DO need to travel —
   *  unlike slots they aren't date-derived/self-healing, so a fresh instance
   *  would otherwise show default occupancy instead of what's actually seated. */
  snapshot(): BookingStoreSnapshot {
    const taken = Array.from(this.slots.values())
      .filter((s) => !s.available)
      .map((s) => s.id);
    return {
      reservations: [...this.reservations],
      taken,
      tables: [...this.tableMap],
      bills: [...this.billMap],
    };
  }

  /** Restore IN PLACE — every module that imported `store` at load time holds this
   *  same object reference, so replacing it here would leave them stale.
   *
   *  Reads every field defensively before mutating anything: a snapshot shaped
   *  for an older version of this store (missing `tables`/`bills`, say) must be
   *  rejected as a no-op for those fields, not partially applied — the shared
   *  state layer bumps its schema version specifically so old data is never
   *  read back in, but restore() shouldn't rely on that being the only thing
   *  standing between a malformed snapshot and a half-wiped store. */
  restore(data: BookingStoreSnapshot): void {
    const reservations = Array.isArray(data.reservations) ? data.reservations : [];
    const taken = Array.isArray(data.taken) ? data.taken : [];
    const tables = Array.isArray(data.tables) ? data.tables : [];
    const bills = Array.isArray(data.bills) ? data.bills : [];

    this.reservations.length = 0;
    this.reservations.push(...reservations);
    for (const slot of this.slots.values()) slot.available = true;
    for (const id of taken) {
      const slot = this.getSlot(id); // getSlot() self-heals via ensureDate
      if (slot) slot.available = false;
    }
    this.tableMap.clear();
    for (const [id, table] of tables) this.tableMap.set(id, table);
    this.billMap.clear();
    for (const [id, bill] of bills) this.billMap.set(id, bill);
  }
}

// Singleton — shared across server-side and client-side code (in-memory only)
// Next.js dev mode hot-reloads can reset this; that's acceptable for MVP.
declare global {
  // eslint-disable-next-line no-var
  var __bookingStore: BookingStore | undefined;
}

export const store: BookingStore =
  globalThis.__bookingStore ?? (globalThis.__bookingStore = new BookingStore());
