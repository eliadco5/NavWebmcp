// Server side of the UI relay (docs/ui-components.md#relay). An external MCP
// client has no browser tab of its own, so its ui_* calls are relayed to the
// caller's own open tab(s):
//
//   page  ──POST /api/ui/snapshot──▶ snapshots   (what is mounted, current state)
//   agent ──ui_set_state──▶ enqueueCommand ──▶ queue
//   page  ──POST /api/ui/relay────▶ claimCommands, applies them, posts results
//   agent ◀── awaitResult ◀── results
//
// Everything is keyed by userId: a token can only see and drive tabs signed in
// as the same user. In-process memory by default; Redis when REDIS_URL is set,
// so a command enqueued on one serverless instance reaches a page polling
// another. A Redis failure falls back to memory (same policy as
// lib/feature-intros/seen-store.ts).
import { getRedis } from "@/lib/shared-state/redis";
import type { Result } from "@/lib/result";
import type { UiCommand, UiPageSnapshot } from "@/lib/ui-components/contract";
import { installUiRelay, type StoredSnapshot } from "./port";

export type { StoredSnapshot };

export const SNAPSHOT_TTL_MS = 30_000;
export const COMMAND_TIMEOUT_MS = 8_000;
const RESULT_TTL_S = 60;

/** Mutable so tests can shorten the wait. */
export const relayTuning = { timeoutMs: COMMAND_TIMEOUT_MS, pollMs: 150 };

const NAMESPACE = process.env.VERCEL_ENV ?? "dev";
const key = (...parts: string[]) => `webmcp:ui:${NAMESPACE}:${parts.join(":")}`;

interface Memory {
  pages: Map<string, Map<string, StoredSnapshot>>; // userId → tabId → snapshot
  queues: Map<string, UiCommand[]>;                // userId:tabId → pending commands
  results: Map<string, Result<unknown>>;           // userId:cmdId → result
}

declare global {
  // eslint-disable-next-line no-var
  var __uiRelay: Memory | undefined;
}

function memory(): Memory {
  return (globalThis.__uiRelay ??= { pages: new Map(), queues: new Map(), results: new Map() });
}

async function redis() {
  return getRedis().catch(() => null);
}

function warn(what: string, err: unknown) {
  console.warn(`[ui-relay] ${what} failed, using in-process state:`, err);
}

// ── Snapshots ────────────────────────────────────────────────────────────────

export async function putSnapshot(userId: string, snap: UiPageSnapshot, now = Date.now()): Promise<void> {
  const stored: StoredSnapshot = { ...snap, updatedAt: now };
  const mem = memory();
  if (!mem.pages.has(userId)) mem.pages.set(userId, new Map());
  mem.pages.get(userId)!.set(snap.tabId, stored);

  const r = await redis();
  if (!r) return;
  try {
    await r.multi()
      .hSet(key("pages", userId), snap.tabId, JSON.stringify(stored))
      .expire(key("pages", userId), Math.ceil((SNAPSHOT_TTL_MS * 2) / 1000))
      .exec();
  } catch (err) { warn("snapshot write", err); }
}

export async function removeSnapshot(userId: string, tabId: string): Promise<void> {
  memory().pages.get(userId)?.delete(tabId);
  memory().queues.delete(`${userId}:${tabId}`);
  const r = await redis();
  if (!r) return;
  try {
    await r.hDel(key("pages", userId), tabId);
    await r.del(key("queue", userId, tabId));
  } catch (err) { warn("snapshot delete", err); }
}

/** Tabs that published within SNAPSHOT_TTL_MS. */
export async function livePages(userId: string, now = Date.now()): Promise<StoredSnapshot[]> {
  let all: StoredSnapshot[] | null = null;
  const r = await redis();
  if (r) {
    try {
      const raw = await r.hGetAll(key("pages", userId));
      all = Object.values(raw).map((v) => JSON.parse(v) as StoredSnapshot);
    } catch (err) { warn("snapshot read", err); }
  }
  all ??= [...(memory().pages.get(userId)?.values() ?? [])];
  return all.filter((s) => now - s.updatedAt < SNAPSHOT_TTL_MS);
}

/** The explicit tab, else the visible tab the user focused last, else the last focused. */
export async function pickPage(userId: string, tabId?: string, now = Date.now()): Promise<StoredSnapshot | null> {
  const pages = await livePages(userId, now);
  if (tabId) return pages.find((p) => p.tabId === tabId) ?? null;
  const ranked = [...pages].sort((a, b) =>
    a.visible !== b.visible ? (a.visible ? -1 : 1) : b.focusedAt - a.focusedAt
  );
  return ranked[0] ?? null;
}

// ── Commands ─────────────────────────────────────────────────────────────────

export async function enqueueCommand(userId: string, tabId: string, cmd: UiCommand): Promise<void> {
  const r = await redis();
  if (r) {
    try {
      await r.multi()
        .rPush(key("queue", userId, tabId), JSON.stringify(cmd))
        .expire(key("queue", userId, tabId), RESULT_TTL_S)
        .exec();
      return;
    } catch (err) { warn("enqueue", err); }
  }
  const q = `${userId}:${tabId}`;
  const mem = memory();
  mem.queues.set(q, [...(mem.queues.get(q) ?? []), cmd]);
}

/** Take every pending command for this tab (each is delivered once). */
export async function claimCommands(userId: string, tabId: string): Promise<UiCommand[]> {
  const mem = memory();
  const q = `${userId}:${tabId}`;
  const fromMemory = mem.queues.get(q) ?? [];
  mem.queues.delete(q);

  const r = await redis();
  if (!r) return fromMemory;
  try {
    const [raw] = (await r.multi()
      .lRange(key("queue", userId, tabId), 0, -1)
      .del(key("queue", userId, tabId))
      .exec()) as unknown as [string[], number];
    return [...fromMemory, ...raw.map((v) => JSON.parse(v) as UiCommand)];
  } catch (err) {
    warn("claim", err);
    return fromMemory;
  }
}

export async function putResult(userId: string, cmdId: string, result: Result<unknown>): Promise<void> {
  const r = await redis();
  if (r) {
    try {
      await r.set(key("result", userId, cmdId), JSON.stringify(result), { EX: RESULT_TTL_S });
      return;
    } catch (err) { warn("result write", err); }
  }
  memory().results.set(`${userId}:${cmdId}`, result);
}

async function takeResult(userId: string, cmdId: string): Promise<Result<unknown> | undefined> {
  const mem = memory();
  const local = mem.results.get(`${userId}:${cmdId}`);
  if (local) {
    mem.results.delete(`${userId}:${cmdId}`);
    return local;
  }
  const r = await redis();
  if (!r) return undefined;
  try {
    const raw = await r.getDel(key("result", userId, cmdId));
    return raw ? (JSON.parse(raw) as Result<unknown>) : undefined;
  } catch (err) {
    warn("result read", err);
    return undefined;
  }
}

/** Poll for the page's result; undefined on timeout. */
export async function awaitResult(
  userId: string,
  cmdId: string,
  { timeoutMs = relayTuning.timeoutMs, pollMs = relayTuning.pollMs }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<Result<unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await takeResult(userId, cmdId);
    if (result) return result;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

installUiRelay({
  pickPage: (userId, tabId) => pickPage(userId, tabId),
  livePages: (userId) => livePages(userId),
  enqueueCommand,
  awaitResult: (userId, cmdId) => awaitResult(userId, cmdId),
});
