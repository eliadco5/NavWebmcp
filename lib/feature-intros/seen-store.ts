// Server-side record of which feature intros each user has finished or skipped.
//
// Deliberately NOT a descriptor in lib/shared-state/registry.ts: that snapshot
// machinery has a 24h TTL and gets reseeded as demo data, which would make every
// intro pop up again each day. This is per-user preference data, so it gets its
// own long-lived Redis SET per user, and fails open to in-process memory exactly
// like hydrate() does (a Redis outage means an intro might show again, not a 500).
import { getRedis } from "@/lib/shared-state/redis";

const NAMESPACE = process.env.VERCEL_ENV ?? "dev";
const TTL_SECONDS = 180 * 24 * 60 * 60;

function keyFor(userId: string): string {
  return `webmcp:intros:${NAMESPACE}:${userId}`;
}

declare global {
  // eslint-disable-next-line no-var
  var __featureIntroSeen: Map<string, Set<string>> | undefined;
}

function memory(): Map<string, Set<string>> {
  return (globalThis.__featureIntroSeen ??= new Map());
}

export async function getSeen(userId: string): Promise<string[]> {
  const redis = await getRedis().catch(() => null);
  if (redis) {
    try {
      return await redis.sMembers(keyFor(userId));
    } catch (err) {
      console.warn("[feature-intros] read failed, using in-process state:", err);
    }
  }
  return [...(memory().get(userId) ?? [])];
}

export async function markSeen(userId: string, key: string): Promise<void> {
  const mem = memory();
  if (!mem.has(userId)) mem.set(userId, new Set());
  mem.get(userId)!.add(key);

  const redis = await getRedis().catch(() => null);
  if (!redis) return;
  try {
    await redis.multi().sAdd(keyFor(userId), key).expire(keyFor(userId), TTL_SECONDS).exec();
  } catch (err) {
    console.warn("[feature-intros] write failed, kept in-process only:", err);
  }
}

export async function resetSeen(userId: string): Promise<void> {
  memory().delete(userId);
  const redis = await getRedis().catch(() => null);
  if (!redis) return;
  try {
    await redis.del(keyFor(userId));
  } catch (err) {
    console.warn("[feature-intros] reset failed:", err);
  }
}
