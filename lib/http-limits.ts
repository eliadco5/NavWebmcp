// Request-size limits for the JSON routes. Without them a caller could post a
// body of any size and the server would buffer and parse all of it before any
// check ran. Bug-report attachments have their own, larger limits
// (lib/bugreport/attachments.ts) and don't go through here.

/** Default cap for a JSON request body: 64 KB (MAX_BODY_BYTES overrides). */
export function maxBodyBytes(): number {
  const n = Number(process.env.MAX_BODY_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 64 * 1024;
}

function tooLarge(limit: number): Response {
  return Response.json(
    { success: false, error: { code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds ${limit} bytes.` } },
    { status: 413 }
  );
}

function invalid(): Response {
  return Response.json(
    { success: false, error: { code: "INVALID_INPUT", message: "Request body must be valid JSON." } },
    { status: 400 }
  );
}

/** Read at most `limit` bytes of the body, stopping as soon as it goes over. */
export async function readTextCapped(req: Request, limit = maxBodyBytes()): Promise<string | Response> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return tooLarge(limit);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return tooLarge(limit);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Parsed JSON body (undefined when empty), or the 413/400 Response to send. */
export async function readJsonCapped(req: Request, limit = maxBodyBytes()): Promise<unknown | Response> {
  const text = await readTextCapped(req, limit);
  if (text instanceof Response) return text;
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return invalid();
  }
}

/** Cheap pre-check for routes that must hand the untouched request on (MCP). */
export function declaredTooLarge(req: Request, limit = maxBodyBytes()): Response | null {
  const declared = Number(req.headers.get("content-length"));
  return Number.isFinite(declared) && declared > limit ? tooLarge(limit) : null;
}
