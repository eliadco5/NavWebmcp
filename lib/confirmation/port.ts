// Confirmation tokens (NavWebMcp 2.6.0). Client-safe, like lib/idempotency/port.ts:
// execute() is bundled into the browser, so this module holds only WebCrypto
// code, the types and an in-memory fallback. lib/confirmation/index.ts installs
// the server key (CONFIRMATION_SECRET, else AUTH_SECRET) and the shared
// one-use store (Redis when configured) from the server entry points.
//
// A token approves exactly one call: it is an HMAC over (user, agent client,
// operation, arguments hash, expiry, nonce). Changing any argument, waiting past
// the expiry, or using it twice makes it stale.
import { z } from "zod";

/** The input field that carries a token (published on requiresConfirmation ops). */
export const CONFIRMATION_TOKEN_FIELD = "confirmationToken";
/** The input field that asks for a preview instead of the write (published on server writes). */
export const DRY_RUN_FIELD = "dryRun";

export const ConfirmationTokenSchema = () =>
  z.string().min(1).max(1024).describe("From CONFIRMATION_REQUIRED or a dryRun: approves this exact call once");

export const DryRunSchema = () =>
  // Short on purpose, like idempotencyKey's: it is published in every write's
  // input schema, and describe_tool(book) sits just under one 4 KB credit size unit.
  z.boolean().describe("Preview only; writes nothing.");

/** How an approved destructive call was approved, as the audit trail records it. */
export type ApprovedBy =
  /** A person in the UI (actor type human) passed confirm: true. */
  | "human"
  /** An agent (or a script) passed confirm: true; nothing proves a person saw it. */
  | "asserted"
  /** A confirmationToken from the preview, for these exact arguments. */
  | "confirmation-token"
  /** The user answered an MCP elicitation showing the preview. */
  | "user-elicitation";

export interface ConfirmationBinding {
  userId: string;
  /** The agent client, when an agent acts ("" otherwise). */
  clientId: string;
  operation: string;
  argsHash: string;
}

export type TokenCheck = "ok" | "invalid" | "mismatch" | "expired" | "used";

export interface ConfirmationPort {
  /** HMAC-SHA256 of `payload`, base64url. */
  sign(payload: string): Promise<string>;
  /** True the first time a nonce is seen within `ttlMs`; false after. */
  consumeOnce(nonce: string, ttlMs: number): Promise<boolean>;
}

declare global {
  // eslint-disable-next-line no-var
  var __confirmationPort: ConfirmationPort | undefined;
  // eslint-disable-next-line no-var
  var __confirmationMemKey: Promise<CryptoKey> | undefined;
  // eslint-disable-next-line no-var
  var __confirmationUsed: Map<string, number> | undefined;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

/** An HMAC signer over a fixed key; the server installs one with its secret. */
export function hmacSigner(key: Promise<CryptoKey>): (payload: string) => Promise<string> {
  return async (payload) => {
    const mac = await globalThis.crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(payload));
    return b64url(new Uint8Array(mac));
  };
}

export function importHmacKey(secret: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(secret);
  return globalThis.crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** Per process: a random key and a local used-nonce map. Enough for one
 *  instance and for tests; the server installs a shared key and Redis. */
export const memoryConfirmationPort: ConfirmationPort = {
  sign: (payload) => {
    // The promise is cached, so concurrent first calls share one key.
    globalThis.__confirmationMemKey ??= globalThis.crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    ) as Promise<CryptoKey>;
    return hmacSigner(globalThis.__confirmationMemKey)(payload);
  },
  async consumeOnce(nonce, ttlMs) {
    const used = (globalThis.__confirmationUsed ??= new Map());
    const now = Date.now();
    if (used.size > 1000) for (const [k, exp] of used) if (exp <= now) used.delete(k);
    const exp = used.get(nonce);
    if (exp !== undefined && exp > now) return false;
    used.set(nonce, now + ttlMs);
    return true;
  },
};

export function installConfirmation(port: ConfirmationPort): void {
  globalThis.__confirmationPort = port;
}

export function confirmationPort(): ConfirmationPort {
  return globalThis.__confirmationPort ?? memoryConfirmationPort;
}

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

/** How long a token stays valid (CONFIRMATION_TTL_SECONDS, default 5 min). */
export function confirmationTtlMs(): number {
  const n = Number(env("CONFIRMATION_TTL_SECONDS"));
  return (Number.isFinite(n) && n > 0 ? n : 300) * 1000;
}

/** REQUIRE_CONFIRMATION_TOKEN=true: an agent's bare confirm: true is refused. */
export function confirmationTokenRequired(): boolean {
  return env("REQUIRE_CONFIRMATION_TOKEN") === "true";
}

const VERSION = "c1";

interface TokenBody {
  u: string;
  c: string;
  o: string;
  h: string;
  exp: number;
  n: string;
}

/** Mint a token for one call. */
export async function mintConfirmationToken(b: ConfirmationBinding): Promise<{ token: string; expiresAt: string }> {
  const exp = Date.now() + confirmationTtlMs();
  const body: TokenBody = { u: b.userId, c: b.clientId, o: b.operation, h: b.argsHash, exp, n: globalThis.crypto.randomUUID() };
  const encoded = b64url(new TextEncoder().encode(JSON.stringify(body)));
  const mac = await confirmationPort().sign(`${VERSION}.${encoded}`);
  return { token: `${VERSION}.${encoded}.${mac}`, expiresAt: new Date(exp).toISOString() };
}

function equalStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function decode(token: string): { signed: string; mac: string; body: TokenBody } | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  try {
    const body = JSON.parse(fromB64url(parts[1])) as TokenBody;
    if (typeof body?.n !== "string" || typeof body.exp !== "number") return null;
    return { signed: `${parts[0]}.${parts[1]}`, mac: parts[2], body };
  } catch {
    return null;
  }
}

/** Check a token against the call it is presented with, without using it up. */
export async function checkConfirmationToken(token: string, b: ConfirmationBinding): Promise<TokenCheck> {
  const d = decode(token);
  if (!d) return "invalid";
  if (!equalStrings(await confirmationPort().sign(d.signed), d.mac)) return "invalid";
  const { body } = d;
  if (body.u !== b.userId || body.c !== b.clientId || body.o !== b.operation) return "invalid";
  if (body.h !== b.argsHash) return "mismatch";
  if (body.exp <= Date.now()) return "expired";
  return "ok";
}

/** Check, then use up: "ok" at most once per token. */
export async function redeemConfirmationToken(token: string, b: ConfirmationBinding): Promise<TokenCheck> {
  const check = await checkConfirmationToken(token, b);
  if (check !== "ok") return check;
  const body = decode(token)!.body;
  return (await confirmationPort().consumeOnce(body.n, Math.max(1, body.exp - Date.now()))) ? "ok" : "used";
}
