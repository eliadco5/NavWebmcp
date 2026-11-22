// DOM replay of a scenario via rrweb: records DOM mutations + input + mouse,
// not pixels, so a minute is typically 50–300 KB and needs no permission.
// rrweb is imported lazily so it stays out of the main bundle until a user
// actually starts recording.

export const MAX_REPLAY_BYTES = 3_400_000; // compressed; under ATTACHMENT_RULES.replay

let events: unknown[] = [];
let approxBytes = 0;
let stopFn: (() => void) | null = null;
let overflowed = false;

export async function startReplay(onOverflow?: () => void): Promise<boolean> {
  if (stopFn) return true;
  events = [];
  approxBytes = 0;
  overflowed = false;
  try {
    const { record } = await import("rrweb");
    const stop = record({
      emit(e) {
        if (overflowed) return;
        events.push(e);
        // Uncompressed JSON size / ~8 is a conservative gzip estimate for DOM events.
        approxBytes += JSON.stringify(e).length / 8;
        if (approxBytes > MAX_REPLAY_BYTES) { overflowed = true; onOverflow?.(); }
      },
      maskAllInputs: false,
      maskInputOptions: { password: true },
      blockSelector: "[data-bug-reporter-ui]",
      sampling: { mousemove: 50, scroll: 150, input: "last" },
      // Re-snapshot periodically so a long recording still seeks quickly.
      checkoutEveryNms: 60_000,
    });
    stopFn = stop ?? null;
    return Boolean(stop);
  } catch (err) {
    console.warn("Bug report DOM replay unavailable:", err);
    return false;
  }
}

export async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob().then((b) => new Blob([b], { type: "application/gzip" }));
}

export async function gunzipJson<T>(blob: Blob): Promise<T> {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as T;
}

/** Stops recording; returns the gzip'd events, or null if nothing usable. */
export async function stopReplay(): Promise<{ blob: Blob; events: number; truncated: boolean } | null> {
  stopFn?.();
  stopFn = null;
  const captured = events;
  events = [];
  if (captured.length < 2) return null; // needs at least meta + full snapshot
  const blob = await gzip(JSON.stringify(captured));
  return { blob, events: captured.length, truncated: overflowed };
}
