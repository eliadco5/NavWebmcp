export interface Slot {
  id: string;
  date: string;       // ISO date "YYYY-MM-DD"
  time: string;       // "HH:MM"
  capacity: number;
  available: boolean;
}

export interface Reservation {
  id: string;
  slotId: string;
  name: string;
  partySize: number;
  date: string;
  time: string;
  createdAt: string;
  userId: string;
}

export type StoreEvent =
  | { type: "reservation.created"; reservation: Reservation }
  | { type: "reservation.cancelled"; reservationId: string }
  | { type: "availability.changed"; slotId: string; available: boolean };

type Listener = (event: StoreEvent) => void;

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

class BookingStore {
  private slots = new Map<string, Slot>();
  private reservations: Reservation[] = [];
  private listeners: Listener[] = [];

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

  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: StoreEvent) {
    for (const l of this.listeners) l(event);
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
    };

    slot.available = false;
    this.reservations.push(reservation);

    this.emit({ type: "reservation.created", reservation });
    this.emit({ type: "availability.changed", slotId, available: false });

    return reservation;
  }

  cancelReservation(id: string, userId: string): "ok" | "not_found" | "forbidden" {
    const idx = this.reservations.findIndex((r) => r.id === id);
    if (idx === -1) return "not_found";
    if (this.reservations[idx].userId !== userId) return "forbidden";

    const reservation = this.reservations[idx];
    this.reservations.splice(idx, 1);

    const slot = this.getSlot(reservation.slotId);
    if (slot) slot.available = true;

    this.emit({ type: "reservation.cancelled", reservationId: id });
    if (slot) {
      this.emit({ type: "availability.changed", slotId: slot.id, available: true });
    }

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

    const slot = this.getSlot(reservation.slotId);
    if (slot) slot.available = true;

    this.emit({ type: "reservation.cancelled", reservationId: id });
    if (slot) this.emit({ type: "availability.changed", slotId: slot.id, available: true });

    return "ok";
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
