import { getRedis } from "@/lib/shared-state/redis";
import { keyFor } from "@/lib/shared-state";
import type { AttachmentKind } from "./types";

// Binary attachments of bug reports (screenshots, rrweb replay, screen video).
// Deliberately NOT part of the shared-state snapshot: that is read and
// written on every request, and these are megabytes. With REDIS_URL they get
// their own keys, read only when someone opens a report; without it, an
// in-process Map with a total-size cap.

export const ATTACHMENT_RULES: Record<AttachmentKind, { maxBytes: number; mimes: RegExp }> = {
  screenshot: { maxBytes: 1_000_000, mimes: /^image\/(jpeg|png)$/ },
  before: { maxBytes: 1_000_000, mimes: /^image\/(jpeg|png)$/ },
  after: { maxBytes: 1_000_000, mimes: /^image\/(jpeg|png)$/ },
  /** gzip-compressed JSON array of rrweb events */
  replay: { maxBytes: 3_500_000, mimes: /^application\/(gzip|json)$/ },
  /** Under Vercel's 4.5 MB request body limit. */
  video: { maxBytes: 4_000_000, mimes: /^video\/webm$/ },
};

export const MEMORY_CAP_BYTES = 50_000_000;
const TTL_SECONDS = 7 * 24 * 60 * 60;

export interface Attachment { mime: string; data: Buffer }

interface MemStore { map: Map<string, Attachment>; bytes: number }
function mem(): MemStore {
  const g = globalThis as unknown as { __bugAttachments?: MemStore };
  return (g.__bugAttachments ??= { map: new Map(), bytes: 0 });
}

const memKey = (reportId: string, kind: AttachmentKind) => `${reportId}:${kind}`;
const redisKey = (reportId: string, kind: AttachmentKind) => keyFor(`bugatt:${reportId}:${kind}`);

export function checkAttachment(kind: AttachmentKind, mime: string, bytes: number): string | null {
  const rule = ATTACHMENT_RULES[kind];
  if (!rule.mimes.test(mime)) return `Unsupported type ${mime || "(none)"} for ${kind}.`;
  if (bytes === 0) return "Empty attachment.";
  if (bytes > rule.maxBytes) return `${kind} is ${bytes} bytes; the limit is ${rule.maxBytes}.`;
  return null;
}

export async function putAttachment(reportId: string, kind: AttachmentKind, att: Attachment): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    // mime + base64 in one value keeps put/get atomic per attachment.
    await redis.set(redisKey(reportId, kind), JSON.stringify({ mime: att.mime, b64: att.data.toString("base64") }), { EX: TTL_SECONDS });
    return;
  }
  const s = mem();
  const k = memKey(reportId, kind);
  const prev = s.map.get(k);
  if (prev) { s.bytes -= prev.data.length; s.map.delete(k); }
  s.map.set(k, att);
  s.bytes += att.data.length;
  // Map iterates in insertion order — evict oldest first.
  for (const [key, v] of s.map) {
    if (s.bytes <= MEMORY_CAP_BYTES) break;
    s.map.delete(key);
    s.bytes -= v.data.length;
  }
}

export async function getAttachment(reportId: string, kind: AttachmentKind): Promise<Attachment | null> {
  const redis = await getRedis();
  if (redis) {
    const raw = await redis.get(redisKey(reportId, kind));
    if (!raw) return null;
    const { mime, b64 } = JSON.parse(raw) as { mime: string; b64: string };
    return { mime, data: Buffer.from(b64, "base64") };
  }
  return mem().map.get(memKey(reportId, kind)) ?? null;
}

export async function deleteAttachments(reportId: string, kinds: readonly AttachmentKind[]): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    await redis.del(kinds.map((k) => redisKey(reportId, k)));
    return;
  }
  const s = mem();
  for (const kind of kinds) {
    const k = memKey(reportId, kind);
    const v = s.map.get(k);
    if (v) { s.bytes -= v.data.length; s.map.delete(k); }
  }
}
