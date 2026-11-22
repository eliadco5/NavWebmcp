"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { shortLabel } from "@/lib/bugreport/describeElement";

interface Props {
  onPick: (el: Element) => void;
  onNoElement: () => void;
  onCancel: () => void;
}

interface Boxes {
  margin: DOMRect;
  border: DOMRect;
  padding: DOMRect;
  content: DOMRect;
  label: string;
}

function px(v: string) {
  return parseFloat(v) || 0;
}

function boxesFor(el: Element): Boxes {
  const b = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const m = { t: px(cs.marginTop), r: px(cs.marginRight), b: px(cs.marginBottom), l: px(cs.marginLeft) };
  const bw = { t: px(cs.borderTopWidth), r: px(cs.borderRightWidth), b: px(cs.borderBottomWidth), l: px(cs.borderLeftWidth) };
  const p = { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) };
  const margin = new DOMRect(b.x - m.l, b.y - m.t, b.width + m.l + m.r, b.height + m.t + m.b);
  const padding = new DOMRect(b.x + bw.l, b.y + bw.t, b.width - bw.l - bw.r, b.height - bw.t - bw.b);
  const content = new DOMRect(padding.x + p.l, padding.y + p.t, padding.width - p.l - p.r, padding.height - p.t - p.b);
  return { margin, border: b, padding, content, label: shortLabel(el) };
}

const rectStyle = (r: DOMRect, bg: string): React.CSSProperties => ({
  position: "fixed", left: r.x, top: r.y, width: Math.max(0, r.width), height: Math.max(0, r.height),
  background: bg, pointerEvents: "none",
});

/**
 * DevTools-style element picker. Covers the page with a transparent layer
 * that swallows clicks, resolves the element underneath with
 * elementsFromPoint, and draws margin/border/padding/content boxes on it.
 * ↑ walks to the parent (for "the whole table is wrong"), ↓ walks back down,
 * Enter or click picks, Esc cancels.
 */
export function InspectorOverlay({ onPick, onNoElement, onCancel }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<Element | null>(null);
  const [boxes, setBoxes] = useState<Boxes | null>(null);
  // Elements we walked up from with ↑, so ↓ can retrace exactly.
  const trail = useRef<Element[]>([]);

  const select = useCallback((el: Element | null) => {
    setTarget(el);
    setBoxes(el ? boxesFor(el) : null);
  }, []);

  const elementAt = useCallback((x: number, y: number): Element | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      if (rootRef.current?.contains(el)) continue;
      if ((el as HTMLElement).closest?.("[data-bug-reporter-ui]")) continue;
      if (el === document.documentElement || el === document.body) continue;
      return el;
    }
    return null;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
      if (!target) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const parent = target.parentElement;
        if (parent && parent !== document.body) { trail.current.push(target); select(parent); }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const child = trail.current.pop() ?? target.firstElementChild;
        if (child) select(child);
      } else if (e.key === "Enter") {
        e.preventDefault();
        onPick(target);
      }
    };
    const onScroll = () => { if (target) setBoxes(boxesFor(target)); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [target, select, onPick, onCancel]);

  const tooltipTop = boxes ? (boxes.border.y > 34 ? boxes.border.y - 30 : boxes.border.bottom + 6) : 0;

  return (
    <div
      ref={rootRef}
      data-bug-reporter-ui=""
      onPointerMove={(e) => {
        const el = elementAt(e.clientX, e.clientY);
        if (el !== target) { trail.current = []; select(el); }
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = target ?? elementAt(e.clientX, e.clientY);
        if (el) onPick(el);
      }}
      onWheel={(e) => window.scrollBy(0, e.deltaY)}
      style={{ position: "fixed", inset: 0, zIndex: 2147483000, cursor: "crosshair" }}
    >
      {boxes && (
        <>
          <div style={rectStyle(boxes.margin, "rgba(246, 178, 107, .35)")} />
          <div style={rectStyle(boxes.border, "rgba(255, 229, 153, .45)")} />
          <div style={rectStyle(boxes.padding, "rgba(147, 196, 125, .45)")} />
          <div style={{ ...rectStyle(boxes.content, "rgba(111, 168, 220, .5)"), outline: "1px solid #3b82f6" }} />
          <div
            style={{
              position: "fixed", left: Math.max(4, Math.min(boxes.border.x, document.documentElement.clientWidth - 428)), top: tooltipTop,
              maxWidth: 420, background: "#111827", color: "#f9fafb", fontSize: 12, fontFamily: "ui-monospace, monospace",
              padding: "4px 8px", borderRadius: 4, pointerEvents: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}
          >
            {boxes.label}
          </div>
        </>
      )}

      <div
        onClick={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        style={{
          position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)",
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "center",
          background: "#1f2937", color: "#f9fafb", fontSize: 13, padding: "8px 12px", borderRadius: 10,
          boxShadow: "0 4px 16px rgba(0,0,0,.25)", cursor: "default", maxWidth: "calc(100vw - 24px)",
        }}
      >
        <span>🐞 Click the element with the problem</span>
        <span style={{ color: "#9ca3af", fontSize: 12 }}>↑ parent · ↓ child · Enter pick · Esc cancel</span>
        <button type="button" onClick={onNoElement} style={{ fontSize: 12, padding: "4px 10px", background: "#374151", color: "#f9fafb" }}>
          Not a specific element
        </button>
        <button type="button" onClick={onCancel} style={{ fontSize: 12, padding: "4px 10px", background: "#4b5563", color: "#f9fafb" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
