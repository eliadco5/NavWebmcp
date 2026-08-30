// One descriptor per globalThis singleton in tests/setup.ts's SINGLETON_KEYS
// (minus __authStore, which is stale — auth is stateless HMAC, see lib/auth-tokens.ts).
//
// Every restore() mutates the existing object IN PLACE rather than replacing it.
// ~43 operation files bind a store's object reference at module load (e.g.
// `const store = frontofficeStore()` in lib/operations/getOccupancy.ts) — see
// lib/seed/store.ts's resetMap/resetArray for the same contract. Calling the
// seed accessor (e.g. crmGuests()) also forces the singleton into existence on a
// cold instance where it doesn't exist yet, which restore() relies on.
import {
  crmGuests, crmPreferences, crmLoyalty, crmCommunications,
  tasksStore, frontofficeStore,
  financePayments, financeAdjustments,
  housekeepingTableStatus, housekeepingScheduleItems, housekeepingInspections,
} from "@/lib/seed";
import { store as bookingStore } from "@/lib/store";
import { auditLog } from "@/lib/auditlog";
import { snapshotLoaded, restoreLoaded } from "@/lib/loadedTools";

export interface StoreDescriptor {
  /** Redis key suffix — see lib/shared-state/index.ts for the full key. */
  key: string;
  /** JSON-safe snapshot of the current in-memory contents. Forces the
   *  singleton into existence (seeding it) as a side effect. */
  snapshot(): unknown;
  /** Overwrite the in-memory singleton in place from a snapshot previously
   *  produced by snapshot(). */
  restore(data: unknown): void;
}

function mapDescriptor<V>(key: string, accessor: () => Map<string, V>): StoreDescriptor {
  return {
    key,
    snapshot: () => [...accessor()],
    restore: (data) => {
      const map = accessor();
      map.clear();
      for (const [k, v] of data as [string, V][]) map.set(k, v);
    },
  };
}

function arrayDescriptor<T>(key: string, accessor: () => T[]): StoreDescriptor {
  return {
    key,
    snapshot: () => [...accessor()],
    restore: (data) => {
      const arr = accessor();
      arr.length = 0;
      arr.push(...(data as T[]));
    },
  };
}

interface FrontofficeSnapshot {
  tables: [string, unknown][];
  reservations: [string, unknown][];
  bills: [string, unknown][];
  shiftNotes: unknown[];
}

const frontofficeDescriptor: StoreDescriptor = {
  key: "frontoffice",
  snapshot: (): FrontofficeSnapshot => {
    const s = frontofficeStore();
    return {
      tables: [...s.tables],
      reservations: [...s.reservations],
      bills: [...s.bills],
      shiftNotes: [...s.shiftNotes],
    };
  },
  restore: (data) => {
    const s = frontofficeStore();
    const d = data as FrontofficeSnapshot;
    s.tables.clear();
    for (const [k, v] of d.tables) s.tables.set(k, v as never);
    s.reservations.clear();
    for (const [k, v] of d.reservations) s.reservations.set(k, v as never);
    s.bills.clear();
    for (const [k, v] of d.bills) s.bills.set(k, v as never);
    s.shiftNotes.length = 0;
    s.shiftNotes.push(...(d.shiftNotes as never[]));
  },
};

const bookingDescriptor: StoreDescriptor = {
  key: "booking",
  snapshot: () => bookingStore.snapshot(),
  restore: (data) => bookingStore.restore(data as ReturnType<typeof bookingStore.snapshot>),
};

const auditDescriptor: StoreDescriptor = {
  key: "audit",
  snapshot: () => auditLog.snapshot(),
  restore: (data) => auditLog.restore(data as ReturnType<typeof auditLog.snapshot>),
};

const loadedToolsDescriptor: StoreDescriptor = {
  key: "loaded",
  snapshot: () => snapshotLoaded(),
  restore: (data) => restoreLoaded(data as ReturnType<typeof snapshotLoaded>),
};

// __tasksSeq is a bare counter (lib/operations/createTask.ts), not seed data —
// fold it into the tasks key so the counter and the collection round-trip together
// and can never diverge from each other.
interface TasksSnapshot {
  tasks: [string, unknown][];
  seq: number | null;
}

const tasksDescriptor: StoreDescriptor = {
  key: "tasks",
  snapshot: (): TasksSnapshot => ({
    tasks: [...tasksStore()],
    seq: (globalThis as { __tasksSeq?: number }).__tasksSeq ?? null,
  }),
  restore: (data) => {
    const d = data as TasksSnapshot;
    const tasks = tasksStore();
    tasks.clear();
    for (const [k, v] of d.tasks) tasks.set(k, v as never);
    const g = globalThis as { __tasksSeq?: number };
    if (typeof d.seq === "number") g.__tasksSeq = d.seq;
    else delete g.__tasksSeq;
  },
};

export const SEED_DESCRIPTORS: StoreDescriptor[] = [
  mapDescriptor("crmGuests", crmGuests),
  mapDescriptor("crmPreferences", crmPreferences),
  mapDescriptor("crmLoyalty", crmLoyalty),
  arrayDescriptor("crmCommunications", crmCommunications),
  tasksDescriptor,
  mapDescriptor("housekeepingTableStatus", housekeepingTableStatus),
  arrayDescriptor("housekeepingScheduleItems", housekeepingScheduleItems),
  arrayDescriptor("housekeepingInspections", housekeepingInspections),
  mapDescriptor("financePayments", financePayments),
  mapDescriptor("financeAdjustments", financeAdjustments),
  frontofficeDescriptor,
];

export const ALL_DESCRIPTORS: StoreDescriptor[] = [
  bookingDescriptor,
  auditDescriptor,
  loadedToolsDescriptor,
  ...SEED_DESCRIPTORS,
];
