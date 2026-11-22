import { toCanvas } from "html-to-image";

const MAX_WIDTH = 1280;
const MAX_CHARS = 900_000; // stays under BugReportInputSchema's 1 MB data-URL cap

/** Viewport screenshot as a JPEG data URL, with `highlight` (viewport coords)
 *  outlined. Elements marked data-bug-reporter-ui are left out. Returns
 *  undefined instead of throwing — a report without a screenshot is still a report. */
export async function captureViewport(highlight?: DOMRect): Promise<string | undefined> {
  try {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ratio = Math.min(1, MAX_WIDTH / vw);
    const full = await toCanvas(document.body, {
      pixelRatio: ratio,
      backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
      skipFonts: true,
      filter: (node) => !(node instanceof HTMLElement && node.dataset.bugReporterUi !== undefined),
    });

    // Body is captured from its own top-left; crop to what the user was looking at.
    const bodyRect = document.body.getBoundingClientRect();
    const sx = -bodyRect.left * ratio;
    const sy = -bodyRect.top * ratio;
    const out = document.createElement("canvas");
    out.width = Math.round(vw * ratio);
    out.height = Math.round(vh * ratio);
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(full, sx, sy, out.width, out.height, 0, 0, out.width, out.height);

    if (highlight) {
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = Math.max(2, 3 * ratio);
      ctx.strokeRect(highlight.x * ratio - 2, highlight.y * ratio - 2, highlight.width * ratio + 4, highlight.height * ratio + 4);
    }

    for (const q of [0.75, 0.55, 0.35]) {
      const url = out.toDataURL("image/jpeg", q);
      if (url.length <= MAX_CHARS) return url;
    }
    return undefined;
  } catch (err) {
    console.warn("Bug report screenshot failed:", err);
    return undefined;
  }
}
