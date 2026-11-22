"use client";

import { useCallback, useState } from "react";
import { useBridge } from "@/app/providers";
import { InspectorOverlay } from "./InspectorOverlay";
import { BugReportDialog } from "./BugReportDialog";
import { describeElement } from "@/lib/bugreport/describeElement";
import { getConsoleLog, getNetworkLog } from "@/lib/bugreport/capture";
import { captureViewport } from "@/lib/bugreport/screenshot";
import type { BugReportInput } from "@/lib/bugreport/types";

type Base = Omit<BugReportInput, "category" | "description" | "expected" | "actual">;
type Phase = { kind: "idle" } | { kind: "inspecting" } | { kind: "capturing" } | { kind: "dialog"; base: Base };

/** Floating "Report a bug" button → element picker → report dialog. */
export function BugReporter() {
  const { user, storeVersion, auditEntries } = useBridge();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const capture = useCallback(async (el: Element | null) => {
    // Describe first: provenance must read the element before anything re-renders.
    const element = el ? describeElement(el) : undefined;
    const highlight = el?.getBoundingClientRect();
    setPhase({ kind: "capturing" });
    // Two frames so the overlay is actually gone from the painted DOM.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const screenshot = await captureViewport(highlight);
    const base: Base = {
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
      screenshot,
    };
    setPhase({ kind: "dialog", base });
  }, [storeVersion, auditEntries]);

  if (!user) return null;

  return (
    <>
      {phase.kind === "idle" && (
        <button
          type="button"
          data-bug-reporter-ui=""
          onClick={() => setPhase({ kind: "inspecting" })}
          title="Report a bug: pick the element that looks wrong"
          style={{
            position: "fixed", right: 18, bottom: 18, zIndex: 900,
            background: "#111827", color: "#fff", borderRadius: 99, padding: "10px 16px",
            fontSize: 13, fontWeight: 600, boxShadow: "0 4px 14px rgba(0,0,0,.25)",
          }}
        >
          🐞 Report a bug
        </button>
      )}
      {phase.kind === "inspecting" && (
        <InspectorOverlay
          onPick={(el) => void capture(el)}
          onNoElement={() => void capture(null)}
          onCancel={() => setPhase({ kind: "idle" })}
        />
      )}
      {phase.kind === "dialog" && <BugReportDialog base={phase.base} onClose={() => setPhase({ kind: "idle" })} />}
    </>
  );
}
