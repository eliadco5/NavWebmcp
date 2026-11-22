// Where to put the intro popover next to its spotlighted element. Pure so it
// can be unit-tested without a DOM.
export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}
export type Placement = "top" | "bottom" | "left" | "right";

const GAP = 14;
const MARGIN = 12;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(v, Math.max(min, max)));
}

/**
 * Tries the preferred side first, then the others, and takes the first one that
 * fits in the viewport. With no target, or when nothing fits (a phone, a huge
 * element), the popover is centred horizontally and pinned near the bottom.
 */
export function positionPopover(
  target: Box | null,
  preferred: Placement | undefined,
  viewport: { width: number; height: number },
  size: { width: number; height: number },
): { top: number; left: number; placement: Placement | "center" } {
  const { width: vw, height: vh } = viewport;
  const { width: w, height: h } = size;
  const centerLeft = clamp((vw - w) / 2, MARGIN, vw - w - MARGIN);

  if (!target) {
    return { top: clamp((vh - h) / 2, MARGIN, vh - h - MARGIN), left: centerLeft, placement: "center" };
  }

  const order: Placement[] = [preferred ?? "bottom", "bottom", "top", "right", "left"];
  const crossTop = clamp(target.top + target.height / 2 - h / 2, MARGIN, vh - h - MARGIN);
  const crossLeft = clamp(target.left + target.width / 2 - w / 2, MARGIN, vw - w - MARGIN);

  for (const p of order) {
    if (p === "bottom" && target.top + target.height + GAP + h <= vh - MARGIN) {
      return { top: target.top + target.height + GAP, left: crossLeft, placement: p };
    }
    if (p === "top" && target.top - GAP - h >= MARGIN) {
      return { top: target.top - GAP - h, left: crossLeft, placement: p };
    }
    if (p === "right" && target.left + target.width + GAP + w <= vw - MARGIN) {
      return { top: crossTop, left: target.left + target.width + GAP, placement: p };
    }
    if (p === "left" && target.left - GAP - w >= MARGIN) {
      return { top: crossTop, left: target.left - GAP - w, placement: p };
    }
  }
  return { top: Math.max(MARGIN, vh - h - MARGIN), left: centerLeft, placement: "center" };
}
