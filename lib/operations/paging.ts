// Optional pagination and field selection for list operations (NavWebMcp 2.7.0).
// Client-safe: execute() is bundled into the browser.
//
// Everything here is opt-in. A call without `limit` (and without `cursor`) gets
// the full list, exactly as before 2.7.0; a call without `fields` gets every
// item property. An operation opts in by declaring `list` (see Operation.list);
// defineOperation then publishes the three input fields and `nextCursor`, and
// execute() pages the handler's full result after the output check.
import { z } from "zod";
import { fail, type Result } from "@/lib/result";
import { confirmationPort } from "@/lib/confirmation/port";
import { canonicalArgs, sha256Hex } from "@/lib/idempotency/port";

export const LIMIT_FIELD = "limit";
export const CURSOR_FIELD = "cursor";
export const FIELDS_FIELD = "fields";
export const NEXT_CURSOR_FIELD = "nextCursor";
export const PAGE_MAX = 200;

export interface ListSpec {
  /** The output key holding the array (e.g. "reservations"). */
  key: string;
  /** The item property that identifies an item; always kept by `fields`. */
  id: string;
  /** Page size when the caller passes no limit. Omit for "the full list"
   *  (every list but getCreditLedgers, which has always returned 50). */
  defaultLimit?: number;
}

/** What execute() needs about a paged operation, filled by defineOperation. */
export interface ListInfo extends ListSpec {
  /** The output shape as the handler declared it (items complete), for the
   *  output check; the published shape makes item properties optional. */
  strictOutput: z.ZodRawShape;
  /** The item properties `fields` may name. */
  itemKeys: readonly string[];
}

/** Publish the paging fields on a list op (mutates the shapes, like
 *  defineOperation's other injected fields). */
export function installList(
  name: string,
  spec: ListSpec,
  inputSchema: z.ZodRawShape,
  outputSchema: z.ZodRawShape,
): ListInfo {
  const out = outputSchema as Record<string, z.ZodTypeAny>;
  const arr = out[spec.key];
  if (!(arr instanceof z.ZodArray) || !(arr.element instanceof z.ZodObject)) {
    throw new Error(`[paging] '${name}': outputSchema.${spec.key} must be an array of objects`);
  }
  const item = arr.element as z.AnyZodObject;
  const itemKeys = Object.keys(item.shape);
  if (!itemKeys.includes(spec.id)) throw new Error(`[paging] '${name}': items have no '${spec.id}'`);
  const strictOutput = { ...outputSchema };

  const partial = item.partial().required({ [spec.id]: true } as never);
  const desc = arr.description;
  out[spec.key] = desc ? z.array(partial).describe(desc) : z.array(partial);
  out[NEXT_CURSOR_FIELD] = z.string().optional().describe("More: pass as cursor");

  const input = inputSchema as Record<string, z.ZodTypeAny>;
  input[LIMIT_FIELD] = z.number().int().min(1).max(PAGE_MAX).optional().describe(
    spec.defaultLimit ? `Page size (default ${spec.defaultLimit})` : "Page size; omit for all",
  );
  input[CURSOR_FIELD] = z.string().min(1).max(1024).optional().describe("A previous nextCursor");
  // Names, not an enum: the item properties are already in the outputSchema,
  // and listing them again would grow every list tool's describe_tool by a
  // few hundred bytes. execute() checks them before the handler runs.
  input[FIELDS_FIELD] = z.array(z.string().min(1).max(64)).min(1).max(50).optional()
    .describe(`Item properties to keep (${spec.id} always)`);

  return { ...spec, strictOutput, itemKeys };
}

export interface PageRequest {
  limit?: number;
  cursor?: string;
  fields?: string[];
}

/** Take the paging fields off the arguments; the rest go to the handler. */
export function takePageRequest(data: Record<string, unknown>): { args: Record<string, unknown>; page: PageRequest } {
  const args = { ...data };
  const page: PageRequest = {
    limit: args[LIMIT_FIELD] as number | undefined,
    cursor: args[CURSOR_FIELD] as string | undefined,
    fields: args[FIELDS_FIELD] as string[] | undefined,
  };
  delete args[LIMIT_FIELD];
  delete args[CURSOR_FIELD];
  delete args[FIELDS_FIELD];
  return { args, page };
}

export interface CursorBinding {
  userId: string;
  clientId: string;
  operation: string;
  /** The other arguments (filters, sort): a cursor only continues the same query. */
  args: Record<string, unknown>;
}

const VERSION = "p1";

interface CursorBody {
  o: string;
  u: string;
  c: string;
  h: string;
  /** The id of the last item returned. */
  a: string;
  /** How many items came before the next page, for when that item is gone. */
  i: number;
  /** The page size, so the next call may omit limit. */
  l: number;
}

function b64url(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const argsHash = (args: Record<string, unknown>) => sha256Hex(canonicalArgs(args));

async function mintCursor(b: CursorBinding, after: string, offset: number, limit: number): Promise<string> {
  const body: CursorBody = { o: b.operation, u: b.userId, c: b.clientId, h: await argsHash(b.args), a: after, i: offset, l: limit };
  const encoded = b64url(JSON.stringify(body));
  // The same signing key as confirmation tokens; the "p1." prefix is signed
  // too, so neither can be passed off as the other.
  const mac = await confirmationPort().sign(`${VERSION}.${encoded}`);
  return `${VERSION}.${encoded}.${mac}`;
}

function badCursor(message: string): Result<never> {
  return fail("INVALID_INPUT", message, {
    details: [{ path: CURSOR_FIELD, message }],
    hint: "Drop cursor to start from the first page.",
  }) as Result<never>;
}

function equalStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Unknown `fields` names, as INVALID_INPUT; null when they're all item properties. */
export function checkFields(list: ListInfo, fields: readonly string[] | undefined): Result<never> | null {
  if (!fields) return null;
  const known = new Set(list.itemKeys);
  const bad = fields.map((f, i) => ({ f, i })).filter(({ f }) => !known.has(f));
  if (bad.length === 0) return null;
  return fail("INVALID_INPUT", `Unknown item properties: ${bad.map((b) => b.f).join(", ")}.`, {
    details: bad.map(({ f, i }) => ({ path: `${FIELDS_FIELD}.${i}`, message: `'${f}' is not an item property` })),
    hint: `Use property names of the items in outputSchema: ${list.itemKeys.join(", ")}.`,
  }) as Result<never>;
}

export type OpenedCursor = CursorBody;

/** Verify a cursor against the call it came with, before anything runs. */
export async function openCursor(cursor: string, b: CursorBinding): Promise<OpenedCursor | Result<never>> {
  const parts = cursor.split(".");
  let body: CursorBody | undefined;
  if (parts.length === 3 && parts[0] === VERSION) {
    try {
      body = JSON.parse(fromB64url(parts[1])) as CursorBody;
    } catch {
      body = undefined;
    }
  }
  const sig = body && (await confirmationPort().sign(`${parts[0]}.${parts[1]}`));
  if (!body || !sig || !equalStrings(sig, parts[2]) || typeof body.a !== "string" || !Number.isInteger(body.i) || !Number.isInteger(body.l)) {
    return badCursor("Not a cursor this server issued.");
  }
  if (body.o !== b.operation || body.u !== b.userId || body.c !== b.clientId) {
    return badCursor(`This cursor was issued for another caller or operation, not '${b.operation}'.`);
  }
  if (body.h !== (await argsHash(b.args))) {
    return badCursor("This cursor belongs to a query with other filters; send the same filters as the first page.");
  }
  return body;
}

function project(item: Record<string, unknown>, keep: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(item)) if (keep.has(k)) out[k] = item[k];
  return out;
}

/** Page and project the handler's full result. Nothing asked → unchanged. */
export async function applyPage(
  list: ListInfo,
  data: Record<string, unknown>,
  page: PageRequest,
  b: CursorBinding,
  opened?: OpenedCursor,
): Promise<Result<Record<string, unknown>>> {
  const items = data[list.key];
  if (!Array.isArray(items)) return { success: true, data };

  let start = 0;
  let limit = page.limit ?? list.defaultLimit;
  if (page.cursor !== undefined) {
    const read = opened ?? (await openCursor(page.cursor, b));
    if ("success" in read) return read;
    // Resume after the last item returned, wherever it is now, so an item
    // added or removed earlier in the list doesn't repeat or skip one. If that
    // item is gone, it was one of the `i` before the page: resume one earlier.
    const at = items.findIndex((it) => (it as Record<string, unknown>)?.[list.id] === read.a);
    start = at >= 0 ? at + 1 : Math.min(Math.max(0, read.i - 1), items.length);
    limit = page.limit ?? read.l;
  }

  let slice = items as Record<string, unknown>[];
  let nextCursor: string | undefined;
  if (limit !== undefined) {
    slice = slice.slice(start, start + limit);
    const end = start + slice.length;
    if (end < items.length && slice.length > 0) {
      nextCursor = await mintCursor(b, String(slice[slice.length - 1][list.id]), end, limit);
    }
  }
  if (page.fields) {
    const keep = new Set([...page.fields, list.id]);
    slice = slice.map((it) => project(it, keep));
  }
  if (slice === items && !nextCursor) return { success: true, data };
  return { success: true, data: { ...data, [list.key]: slice, ...(nextCursor && { [NEXT_CURSOR_FIELD]: nextCursor }) } };
}
