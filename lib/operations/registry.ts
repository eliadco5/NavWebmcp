// Separate file so navigation ops can import the registry without a circular dep.
// index.ts populates this array in place after importing all ops.
import type { Operation } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const registry: Operation<any, any>[] = [];
