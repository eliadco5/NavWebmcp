import { searchAvailability } from "./searchAvailability";
import { createReservation } from "./createReservation";
import { cancelReservation } from "./cancelReservation";
import { listReservations } from "./listReservations";
import { getReservation } from "./getReservation";
import { getContext } from "./getContext";
import type { Operation } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const registry: Operation<any, any>[] = [
  searchAvailability,
  createReservation,
  cancelReservation,
  listReservations,
  getReservation,
  getContext,
];

export { searchAvailability, createReservation, cancelReservation, listReservations, getReservation, getContext };
export type { Operation } from "./types";
