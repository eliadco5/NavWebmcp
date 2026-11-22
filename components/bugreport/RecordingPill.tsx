"use client";

import { useEffect, useState } from "react";
import { recordingInfo, subscribe } from "@/lib/bugreport/scenario";
import { isVideoRecording } from "@/lib/bugreport/video";

/** Floating "● Recording 0:23 · 4 steps · Stop" control. Excluded from
 *  screenshots, replay and step capture via data-bug-reporter-ui. */
export function RecordingPill({ onStop, stopping }: { onStop: () => void; stopping: boolean }) {
  const [info, setInfo] = useState(recordingInfo());
  useEffect(() => {
    const tick = () => setInfo(recordingInfo());
    const unsub = subscribe(tick);
    const id = setInterval(tick, 500);
    return () => { unsub(); clearInterval(id); };
  }, []);

  const secs = Math.floor((info?.elapsedMs ?? 0) / 1000);
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

  return (
    <div
      data-bug-reporter-ui=""
      role="status"
      style={{
        position: "fixed", right: 18, bottom: 18, zIndex: 2147482000,
        display: "flex", alignItems: "center", gap: 10,
        background: "#111827", color: "#fff", borderRadius: 99, padding: "6px 6px 6px 14px",
        fontSize: 13, boxShadow: "0 4px 14px rgba(0,0,0,.3)",
      }}
    >
      <span style={{ color: "#ef4444", animation: "bugrec-blink 1s steps(2, start) infinite" }}>●</span>
      <span>Recording {time} · {info?.steps ?? 0} steps{isVideoRecording() ? " · video" : ""}</span>
      <button type="button" onClick={onStop} disabled={stopping}
        style={{ background: "#ef4444", color: "#fff", borderRadius: 99, padding: "5px 12px", fontSize: 12, fontWeight: 600 }}>
        {stopping ? "Stopping…" : "■ Stop"}
      </button>
      <style>{"@keyframes bugrec-blink { to { visibility: hidden; } }"}</style>
    </div>
  );
}
