import { AsyncLocalStorage } from "async_hooks";

// Serializes state-touching requests WITHIN one process. Necessary because
// hydrate()/restore() mutate the same globalThis singletons every op file binds
// a reference to — without this, two requests overlapping in the same Node
// process (Vercel functions serve concurrent requests, not just concurrent
// instances) can interleave: request B's hydrate can stomp the exact objects
// request A is mid-write on, and A's write is lost before A ever flushes. That's
// a same-instance data-loss bug, distinct from (and worse than) the
// cross-instance last-write-wins trade-off this whole feature already accepts.
//
// Only routes that call withSharedState() take this lock — read-only polling
// (GET /api/audit) deliberately bypasses it entirely, see lib/shared-state/index.ts.
let chain: Promise<unknown> = Promise.resolve();
const holding = new AsyncLocalStorage<object>();
/** The token of the run currently holding the lock, if any. */
let current: object | undefined;

/**
 * True only while the caller's own lock run is still the one holding the lock.
 * ALS alone can't tell: its context outlives the run (the MCP transport keeps
 * executing the tool after the route's promise, and so the lock, has been
 * released — see lib/shared-state/index.ts). Anything that would wait (credit
 * backpressure in lib/credits) checks this first, because waiting while
 * holding the lock stalls every other request on this instance.
 */
export function isStateLockHeld(): boolean {
  const mine = holding.getStore();
  return mine !== undefined && mine === current;
}

export function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  // Re-entrant: a nested call (there are none today, but a future one composing
  // withSharedState inside itself must not deadlock against its own queue).
  if (holding.getStore() && isStateLockHeld()) return fn();

  const token = {};
  const run = chain.then(() => {
    current = token;
    return holding.run(token, fn).finally(() => {
      if (current === token) current = undefined;
    });
  });
  // The chain must keep advancing even if `run` rejects, or every request after
  // a single failure would wait on a permanently-rejected promise forever.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
