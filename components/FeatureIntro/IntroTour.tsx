"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FeatureIntro } from "@/lib/feature-intros/registry";
import { positionPopover, type Box } from "@/lib/feature-intros/position";

// How long a step waits for its data-intro target to mount (a panel still
// fetching, a tab that was just switched to) before falling back to a centred step.
const TARGET_WAIT_MS = 1500;
const SPOT_PAD = 8;
const MAX_WIDTH = 340;

function findTarget(id: string): Element | null {
  return document.querySelector(`[data-intro="${CSS.escape(id)}"]`);
}

function toBox(r: DOMRect): Box {
  return { top: r.top - SPOT_PAD, left: r.left - SPOT_PAD, width: r.width + SPOT_PAD * 2, height: r.height + SPOT_PAD * 2 };
}

export function IntroTour({ intro, onClose }: { intro: FeatureIntro; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [ready, setReady] = useState(false);
  const [popSize, setPopSize] = useState({ width: MAX_WIDTH, height: 180 });
  const [viewport, setViewport] = useState({ width: 1024, height: 768 });
  const popRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  const step = intro.steps[index];
  const isLast = index === intro.steps.length - 1;
  const next = () => (isLast ? onClose() : setIndex((i) => i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));

  // Find, scroll to and track this step's target. Re-measures on scroll (the
  // smooth scrollIntoView itself fires these) and resize.
  useEffect(() => {
    setReady(false);
    setBox(null);
    let el: Element | null = null;
    let raf = 0;
    const measure = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      if (el) setBox(toBox(el.getBoundingClientRect()));
    };
    const deadline = performance.now() + TARGET_WAIT_MS;
    const find = () => {
      el = step.target ? findTarget(step.target) : null;
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (step.target && performance.now() < deadline) {
        raf = requestAnimationFrame(find);
        return;
      }
      measure();
      setReady(true);
    };
    find();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step]);

  // Measure the popover so positioning uses its real height.
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (Math.abs(height - popSize.height) > 1 || Math.abs(width - popSize.width) > 1) {
      setPopSize({ width, height });
    }
  });

  // Keyboard: Esc skips, arrows step. Focus goes into the dialog and comes back
  // to wherever it was when the tour closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    if (ready) primaryRef.current?.focus({ preventScroll: true });
  }, [ready, index]);

  const width = Math.min(MAX_WIDTH, viewport.width - 24);
  const pos = positionPopover(box, step.placement, viewport, { width, height: popSize.height });

  return (
    <>
      {/* Blocks clicks on the page underneath while the tour is open. */}
      <div
        className="intro-overlay"
        style={{ background: box ? "transparent" : "rgba(17,24,39,.55)" }}
        onClick={(e) => e.stopPropagation()}
      />
      {box && <div className="intro-spotlight" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} />}
      <div
        ref={popRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="intro-title"
        aria-describedby="intro-body"
        className="card intro-popover"
        style={{ top: pos.top, left: pos.left, width, visibility: ready ? "visible" : "hidden" }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "#4f46e5", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
          New · {intro.title}
        </div>
        <h3 id="intro-title" style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{step.title}</h3>
        <p id="intro-body" style={{ fontSize: 13, color: "#4b5563", lineHeight: 1.5, marginBottom: 16 }}>{step.body}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "#9ca3af" }} aria-label={`Step ${index + 1} of ${intro.steps.length}`}>
            {index + 1} / {intro.steps.length}
          </span>
          <button type="button" onClick={onClose} style={{ marginLeft: "auto", fontSize: 12, padding: "6px 10px", background: "transparent", color: "#6b7280" }}>
            Skip tour
          </button>
          {index > 0 && (
            <button type="button" onClick={back} style={{ fontSize: 12, padding: "6px 12px", background: "#f3f4f6", color: "#374151" }}>
              Back
            </button>
          )}
          <button ref={primaryRef} type="button" onClick={next} style={{ fontSize: 12, padding: "6px 14px", background: "#4f46e5", color: "#fff" }}>
            {isLast ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </>
  );
}
