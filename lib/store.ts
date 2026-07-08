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
}

export type StoreEvent =
  | { type: "reservation.created"; reservation: Reservation }
  | { type: "reservation.cancelled"; reservationId: string }
  | { type: "availability.changed"; slotId: string; available: boolean };

type Listener = (event: StoreEvent) => void;

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function seedSlots(): Slot[] {
  const slots: Slot[] = [];
  const times = ["10:00", "12:00", "14:00", "18:00", "20:00"];
  const today = new Date();
  for (let d = 0; d < 7; d++) {
    const date = new Date(today);
    date.setDate(today.getDate() + d);
    const dateStr = date.toISOString().split("T")[0];
    for (const time of times) {
      slots.push({
        id: generateId(),
        date: dateStr,
        time,
        capacity: 4 + Math.floor(Math.random() * 5),
        available: true,
      });
    }
  }
  return slots;
}

class BookingStore {
  private slots: Slot[] = seedSlots();
  private reservations: Reservation[] = [];
  private listeners: Listener[] = [];

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
    return this.slots;
  }

  getSlot(id: string): Slot | undefined {
    return this.slots.find((s) => s.id === id);
  }

  searchAvailability(date: string, partySize: number): Slot[] {
    return this.slots.filter(
      (s) => s.date === date && s.available && s.capacity >= partySize
    );
  }

  getReservations(): Reservation[] {
    return this.reservations;
  }

  getReservation(id: string): Reservation | undefined {
    return this.reservations.find((r) => r.id === id);
  }

  createReservation(
    slotId: string,
    name: string,
    partySize: number
  ): Reservation | null {
    const slot = this.slots.find((s) => s.id === slotId);
    if (!slot || !slot.available || slot.capacity < partySize) return null;

    const reservation: Reservation = {
      id: generateId(),
      slotId,
      name,
      partySize,
      date: slot.date,
      time: slot.time,
      createdAt: new Date().toISOString(),
    };

    slot.available = false;
    this.reservations.push(reservation);

    this.emit({ type: "reservation.created", reservation });
    this.emit({ type: "availability.changed", slotId, available: false });

    return reservation;
  }

  cancelReservation(id: string): boolean {
    const idx = this.reservations.findIndex((r) => r.id === id);
    if (idx === -1) return false;

    const reservation = this.reservations[idx];
    this.reservations.splice(idx, 1);

    const slot = this.slots.find((s) => s.id === reservation.slotId);
    if (slot) slot.available = true;

    this.emit({ type: "reservation.cancelled", reservationId: id });
    if (slot) {
      this.emit({ type: "availability.changed", slotId: slot.id, available: true });
    }

    return true;
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
