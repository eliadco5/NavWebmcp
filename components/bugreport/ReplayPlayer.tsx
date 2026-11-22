"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import "rrweb-player/dist/style.css";
import { gunzipJson } from "@/lib/bugreport/replay";

export interface ReplayHandle {
  /** Seek to an absolute timestamp (ms since epoch) — a step's `ts`. */
  seekTo(epochMs: number): void;
}

/** rrweb DOM replay of a scenario, fetched and decompressed on mount. The
 *  player (Svelte, ~100 KB) is imported only when an admin opens a report. */
export const ReplayPlayer = forwardRef<ReplayHandle, { src: string; width?: number }>(function ReplayPlayer({ src, width = 640 }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<{ goto(t: number, play?: boolean): void; $destroy(): void } | null>(null);
  const firstTs = useRef(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useImperativeHandle(ref, () => ({
    seekTo(epochMs: number) {
      player.current?.goto(Math.max(0, epochMs - firstTs.current), false);
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const events = await gunzipJson<{ timestamp: number }[]>(blob);
        const { default: Player } = await import("rrweb-player");
        if (cancelled || !host.current) return;
        firstTs.current = events[0]?.timestamp ?? 0;
        host.current.innerHTML = "";
        player.current = new Player({
          target: host.current,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          props: { events: events as any, width, height: Math.round(width * 0.56), autoPlay: false, showController: true, skipInactive: true },
        }) as unknown as typeof player.current;
        setStatus("ready");
      } catch (err) {
        console.warn("Replay failed to load:", err);
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      player.current?.$destroy();
      player.current = null;
    };
  }, [src, width]);

  return (
    <div>
      {status === "loading" && <p style={{ fontSize: 12, color: "#6b7280" }}>Loading replay…</p>}
      {status === "error" && <p style={{ fontSize: 12, color: "#991b1b" }}>Couldn&apos;t load the DOM replay.</p>}
      <div ref={host} />
    </div>
  );
});
