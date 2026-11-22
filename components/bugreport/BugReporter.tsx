"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useBridge } from "@/app/providers";
import { InspectorOverlay } from "./InspectorOverlay";
import { BugReportDialog } from "./BugReportDialog";
import { RecordingPill } from "./RecordingPill";
import { describeElement } from "@/lib/bugreport/describeElement";
import { getConsoleLog, getNetworkLog } from "@/lib/bugreport/capture";
import { captureViewport } from "@/lib/bugreport/screenshot";
import { startScenario, stopScenario } from "@/lib/bugreport/scenario";
import { startReplay, stopReplay } from "@/lib/bugreport/replay";
import { startVideo, stopVideo, videoSupported } from "@/lib/bugreport/video";
import { imageFile, type CapturedBase, type CapturedFile } from "@/lib/bugreport/clientTypes";
import type { Scenario } from "@/lib/bugreport/types";

type Phase =
  | { kind: "idle" }
  | { kind: "menu" }
  | { kind: "starting" }
  | { kind: "recording" }
  | { kind: "stopping" }
  | { kind: "inspecting" }
  | { kind: "capturing" }
  | { kind: "dialog"; base: CapturedBase };

/** What a finished recording hands to the element picker and dialog. */
interface PendingScenario { scenario: Scenario; files: CapturedFile[] }

// Two frames so the overlay/menu is gone from the painted DOM before a
// screenshot. rAF never fires in a hidden tab, so don't wait on it forever.
const nextFrames = () => Promise.race([
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  new Promise((r) => setTimeout(r, 150)),
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Floating "Report a bug" button → menu:
 *  - Report an element: picker → dialog
 *  - Record a scenario: before-shot → record steps (+ DOM replay, + optional
 *    video) → Stop → after-shot → picker → dialog */
export function BugReporter() {
  const { user, storeVersion, auditEntries } = useBridge();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [withVideo, setWithVideo] = useState(false);
  const pending = useRef<PendingScenario | null>(null);
  const beforeShot = useRef<string | undefined>(undefined);
  const videoNote = useRef<string | undefined>(undefined);

  const capture = useCallback(async (el: Element | null) => {
    // Describe first: provenance must read the element before anything re-renders.
    const element = el ? describeElement(el) : undefined;
    const highlight = el?.getBoundingClientRect();
    const scenario = pending.current;
    pending.current = null;
    setPhase({ kind: "capturing" });
    await nextFrames(); // overlay gone from the painted DOM
    const screenshot = await captureViewport(highlight);
    const base: CapturedBase = {
      page: {
        url: window.location.href,
        tab: window.location.hash.replace("#", "") || undefined,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        userAgent: navigator.userAgent.slice(0, 500),
        storeVersion,
      },
      element,
      console: getConsoleLog(),
      network: getNetworkLog(),
      recentAudit: auditEntries.slice(0, 30).map((a) => ({
        timestamp: a.timestamp, operation: a.operation, success: a.success, source: a.source, input: a.input,
      })),
      ...(scenario ? { scenario: scenario.scenario } : {}),
      // In a scenario the picked-element screenshot is redundant with "after" unless an element was picked.
      files: [...(scenario && !el ? [] : imageFile("screenshot", screenshot)), ...(scenario?.files ?? [])],
    };
    setPhase({ kind: "dialog", base });
  }, [storeVersion, auditEntries]);

  const stopRecording = useCallback(async () => {
    setPhase({ kind: "stopping" });
    await sleep(400); // let in-flight /api/call responses land in the network log
    const scenario = stopScenario();
    const [replay, video] = await Promise.all([stopReplay(), stopVideo()]);
    await nextFrames();
    const after = await captureViewport();
    if (!scenario) { setPhase({ kind: "idle" }); return; }
    const files: CapturedFile[] = [
      ...imageFile("before", beforeShot.current),
      ...imageFile("after", after),
      ...(replay ? [{ kind: "replay" as const, blob: replay.blob }] : []),
      ...(video ? [{ kind: "video" as const, blob: video }] : []),
    ];
    const notes = [videoNote.current, replay?.truncated ? "DOM replay hit its size limit and was cut short." : undefined].filter(Boolean);
    pending.current = {
      scenario: { ...scenario, ...(notes.length ? { videoNote: notes.join(" ").slice(0, 300) } : {}) },
      files,
    };
    beforeShot.current = undefined;
    videoNote.current = undefined;
    setPhase({ kind: "inspecting" });
  }, []);

  const startRecording = useCallback(async () => {
    setPhase({ kind: "starting" });
    await nextFrames();
    beforeShot.current = await captureViewport();
    videoNote.current = withVideo ? (await startVideo()) ?? undefined : undefined;
    await startReplay();
    startScenario({ onAutoStop: () => void stopRecording() });
    setPhase({ kind: "recording" });
  }, [withVideo, stopRecording]);

  // A recording must not outlive the signed-in user.
  useEffect(() => {
    if (!user && phase.kind === "recording") void stopRecording();
  }, [user, phase.kind, stopRecording]);

  if (!user) return null;

  const fab: React.CSSProperties = {
    position: "fixed", right: 18, bottom: 18, zIndex: 900,
    background: "#111827", color: "#fff", borderRadius: 99, padding: "10px 16px",
    fontSize: 13, fontWeight: 600, boxShadow: "0 4px 14px rgba(0,0,0,.25)",
  };
  const menuItem: React.CSSProperties = { display: "block", width: "100%", textAlign: "left", background: "none", color: "#111827", padding: "8px 10px", fontSize: 13 };

  return (
    <>
      {(phase.kind === "idle" || phase.kind === "menu") && (
        <button
          type="button"
          data-bug-reporter-ui=""
          aria-expanded={phase.kind === "menu"}
          onClick={() => setPhase(phase.kind === "menu" ? { kind: "idle" } : { kind: "menu" })}
          title="Report a bug"
          style={fab}
        >
          🐞 Report a bug
        </button>
      )}
      {phase.kind === "menu" && (
        <div data-bug-reporter-ui="" role="menu" className="card"
          style={{ position: "fixed", right: 18, bottom: 64, zIndex: 901, padding: 6, width: 270, boxShadow: "0 6px 20px rgba(0,0,0,.18)" }}>
          <button type="button" role="menuitem" style={menuItem} onClick={() => setPhase({ kind: "inspecting" })}>
            <strong>Report an element</strong>
            <div style={{ fontSize: 11, color: "#6b7280" }}>Pick what looks wrong on the screen</div>
          </button>
          <button type="button" role="menuitem" style={menuItem} onClick={() => void startRecording()}>
            <strong>● Record a scenario</strong>
            <div style={{ fontSize: 11, color: "#6b7280" }}>Repeat the steps that lead to the bug, then Stop</div>
          </button>
          {videoSupported() && (
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "#374151", padding: "4px 10px 6px" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={withVideo} onChange={(e) => setWithVideo(e.target.checked)} />
              Also record screen video (asks permission)
            </label>
          )}
        </div>
      )}
      {(phase.kind === "recording" || phase.kind === "stopping") && (
        <RecordingPill stopping={phase.kind === "stopping"} onStop={() => void stopRecording()} />
      )}
      {phase.kind === "inspecting" && (
        <InspectorOverlay
          title={pending.current ? "Recording stopped — click where it went wrong" : undefined}
          onPick={(el) => void capture(el)}
          onNoElement={() => void capture(null)}
          onCancel={() => { pending.current = null; setPhase({ kind: "idle" }); }}
        />
      )}
      {phase.kind === "dialog" && <BugReportDialog base={phase.base} onClose={() => setPhase({ kind: "idle" })} />}
    </>
  );
}
