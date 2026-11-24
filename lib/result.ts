/**
 * Credit state the server piggybacks on a top-level Result (NavWebMcp 1.4,
 * docs/credits.md). Present only when the caller should change what it's
 * doing — a steady-state call carries none, so it costs no tokens. `hint` is
 * one plain-language sentence any agent can act on without knowing the
 * protocol.
 */
export interface CreditInfo {
  /** Credits available now (can be negative after an expensive call). */
  balance: number;
  /** Most credits this caller may hold at once. */
  window: number;
  /** What this call cost in total (request + response size, op weight, run time). */
  charged: number;
  /** Credits handed back with this response. */
  granted: number;
  /** When the call was refused: how long to wait before retrying. */
  retryAfterMs?: number;
  /** The server held the call this long before running it (backpressure). */
  heldMs?: number;
  hint?: string;
}

export type Success<T> = { success: true; data: T; credits?: CreditInfo };
export type Failure = { success: false; error: { code: string; message: string }; credits?: CreditInfo };
export type Result<T> = Success<T> | Failure;

export function ok<T>(data: T): Success<T> {
  return { success: true, data };
}

export function fail(code: string, message: string): Failure {
  return { success: false, error: { code, message } };
}
