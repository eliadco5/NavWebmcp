// Data minimisation for the audit trail. The trail must show WHAT was done to
// WHICH record by WHOM — not become a second copy of guests' personal data or
// anyone's credentials. Applied to every event's input and output before it is
// hashed and stored, so nothing sensitive is ever written.

export const REDACTED = "[REDACTED]";

/** Never stored, not even masked: credentials and secrets. */
const SECRET_KEY = /^(password|passwd|pass|secret|token|accessToken|refreshToken|agentToken|authorization|cookie|apiKey|uploadToken)$/i;

/** Personal data: the key is kept (so you can see it was supplied), the value isn't. */
const PII_KEY = /(email|phone|cardNumber|card_number|cvv|cvc|ssn|dateOfBirth|dob|address|passport|iban)/i;

/** Per-value and per-event caps, so one large payload can't bloat the log. */
const MAX_STRING = 500;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;
export const MAX_FIELD_BYTES = 8 * 1024;

export interface RedactOptions {
  /** Extra keys (exact names) to mask for this operation. */
  keys?: string[];
}

function walk(value: unknown, extra: Set<string>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value;
  if (typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => walk(v, extra, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`…[+${value.length - MAX_ARRAY} more]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) continue;
    if (PII_KEY.test(k) || extra.has(k)) {
      out[k] = v === undefined || v === null || v === "" ? v : REDACTED;
      continue;
    }
    out[k] = walk(v, extra, depth + 1);
  }
  return out;
}

export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const redacted = walk(value, new Set(options.keys ?? []), 0);
  if (redacted === undefined) return undefined;
  const json = JSON.stringify(redacted);
  if (json && json.length > MAX_FIELD_BYTES) {
    return { truncated: true, bytes: json.length };
  }
  return redacted;
}
