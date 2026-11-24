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

// Client-safe: imported by the browser bundle (lib/agentbridge.ts) as well as the server.

/** One failed input field. `path` is dot-joined ("" for the root object). */
export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * The protocol error object (NavWebMcp ≥ 2.0.0). `code` and `message` are as before;
 * the rest tells an agent what to do next without having to interpret prose.
 */
export interface ProtocolError {
  /** Machine-readable code. Protocol-level codes are listed in PROTOCOL_ERROR_CODES;
   *  operations may add domain codes (NO_AVAILABILITY, ALREADY_REFUNDED, …). */
  code: string;
  message: string;
  /** True when re-sending the identical call may succeed. For INSUFFICIENT_CREDITS,
   *  wait `credits.retryAfterMs` first. */
  retryable: boolean;
  /** Field-level validation failures (INVALID_INPUT). */
  details?: ErrorDetail[];
  /** One-line next step for the agent. */
  hint?: string;
  /** Candidate values, e.g. did-you-mean operation names for UNKNOWN_TOOL. */
  suggestions?: string[];
  /** The top-level request this call belonged to (audit and telemetry key). */
  requestId?: string;
  /** The specific operation call that failed (audit `callId`). */
  callId?: string;
}

export type Success<T> = { success: true; data: T; credits?: CreditInfo };
export type Failure = { success: false; error: ProtocolError; credits?: CreditInfo };
export type Result<T> = Success<T> | Failure;

/** Protocol-level codes, their retryability, and the default hint. Domain codes not
 *  listed here default to `retryable: false` with no hint. */
export const PROTOCOL_ERROR_CODES = {
  UNAUTHENTICATED:       { retryable: false, hint: "Credentials are missing or expired. Re-authenticate, then retry." },
  FORBIDDEN:             { retryable: false, hint: "The caller's role cannot do this. Do not retry." },
  INVALID_INPUT:         { retryable: false, hint: "Fix the fields listed in details (describe_tool shows the exact schema), then retry once." },
  UNKNOWN_TOOL:          { retryable: false, hint: "No operation has this name. Try suggestions, else use search(); don't guess." },
  NOT_FOUND:             { retryable: false, hint: "The referenced entity does not exist. Use a list or search operation to find a valid id." },
  CONFIRMATION_REQUIRED: { retryable: false, hint: "Ask the user to approve this action, then re-call with confirm: true." },
  CONFIRMATION_DENIED:   { retryable: false, hint: "The user refused. Stop; do not retry." },
  CANCELLED:             { retryable: false, hint: "You cancelled the call; nothing was done." },
  VALIDATION_FAILED:     { retryable: false, hint: "The write could not be confirmed afterwards. Read the current state before retrying, so you don't repeat a write that did land." },
  INSUFFICIENT_CREDITS:  { retryable: true,  hint: "Out of credits. Wait credits.retryAfterMs, then retry; batch calls with invoke({ calls }) to spend less." },
  FANOUT_LIMIT:          { retryable: false, hint: "The request nests or fans out too far. Flatten it into one invoke batch, or split it into several requests." },
  HANDLER_TIMEOUT:       { retryable: false, hint: "The call ran out of time and may still have taken effect. Check the state before retrying." },
  HANDLER_ERROR:         { retryable: true,  hint: "Unexpected server failure. Retry at most once." },
} as const satisfies Record<string, { retryable: boolean; hint: string }>;

export type ProtocolErrorCode = keyof typeof PROTOCOL_ERROR_CODES;

export function ok<T>(data: T): Success<T> {
  return { success: true, data };
}

export function fail(
  code: string,
  message: string,
  extra: Partial<Omit<ProtocolError, "code" | "message">> = {}
): Failure {
  const known = (PROTOCOL_ERROR_CODES as Record<string, { retryable: boolean; hint: string } | undefined>)[code];
  const error: ProtocolError = {
    code,
    message,
    retryable: extra.retryable ?? known?.retryable ?? false,
  };
  if (extra.details?.length) error.details = extra.details;
  const hint = extra.hint ?? known?.hint;
  if (hint) error.hint = hint;
  if (extra.suggestions?.length) error.suggestions = extra.suggestions;
  if (extra.requestId) error.requestId = extra.requestId;
  if (extra.callId) error.callId = extra.callId;
  return { success: false, error };
}

/** INVALID_INPUT from Zod issues: one `details` entry per issue, and a message that
 *  names the fields (so agents reading only `message` still see where it failed). */
export function invalidInput(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>
): Failure {
  const details = issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  const message = details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join("; ");
  return fail("INVALID_INPUT", message || "Invalid input.", { details });
}
