// Per-token selection store for Path A (load_tools / unload_tools).
// Keyed by bearer token; value is the set of loaded operation names.
interface LoadedToolsEntry {
  names: Set<string>;
  touchedAt: number;
}
interface LoadedToolsStore {
  entries: Map<string, LoadedToolsEntry>;
}
declare global {
  // eslint-disable-next-line no-var
  var __loadedToolsStore: LoadedToolsStore | undefined;
}
const store: LoadedToolsStore =
  globalThis.__loadedToolsStore ??
  (globalThis.__loadedToolsStore = { entries: new Map() });

const GC_TTL_MS = 24 * 60 * 60 * 1000;
function gc() {
  const now = Date.now();
  for (const [token, entry] of store.entries) {
    if (now - entry.touchedAt > GC_TTL_MS) store.entries.delete(token);
  }
}
function touch(token: string): LoadedToolsEntry {
  let entry = store.entries.get(token);
  if (!entry) {
    entry = { names: new Set(), touchedAt: Date.now() };
    store.entries.set(token, entry);
  } else {
    entry.touchedAt = Date.now();
  }
  return entry;
}
export function getLoaded(token: string): Set<string> {
  return store.entries.get(token)?.names ?? new Set();
}
export function addLoaded(token: string, names: string[]): void {
  gc();
  const entry = touch(token);
  for (const n of names) entry.names.add(n);
}
export function removeLoaded(token: string, names: string[]): void {
  const entry = store.entries.get(token);
  if (!entry) return;
  for (const n of names) entry.names.delete(n);
  entry.touchedAt = Date.now();
}
export function clearLoaded(token: string): void {
  store.entries.delete(token);
}
