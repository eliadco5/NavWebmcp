/**
 * Generates docs/talk-add.pptx — a PowerPoint mirror of docs/talk-add.html.
 * Same 19-slide content and dark palette, rebuilt with native PPTX shapes
 * (not an HTML screenshot export) so it's editable in PowerPoint/Keynote/Slides.
 *
 * Usage: node scripts/build-pptx.mjs
 */

import PptxGenJS from "pptxgenjs";

// ── palette (mirrors docs/talk-add.html :root) ──────────────────────────────
const SURFACE = "1A1A19";
const PAGE = "0D0D0D";
const TEXT_PRIMARY = "FFFFFF";
const TEXT_SECONDARY = "C3C2B7";
const TEXT_MUTED = "898781";
const SERIES_FN = "3987E5"; // blue — the point
const SERIES_PW = "D95926"; // orange — the outlier
const GRID = "2C2C2A";

const pptx = new PptxGenJS();
pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
pptx.layout = "WIDE";
pptx.theme = { headFontFace: "Arial", bodyFontFace: "Arial" };

const W = 13.333;
const H = 7.5;
const MARGIN_X = 0.7;
const CONTENT_W = W - MARGIN_X * 2;

function newSlide() {
  const s = pptx.addSlide();
  s.background = { color: PAGE };
  return s;
}

function kicker(s, text) {
  s.addText(text.toUpperCase(), {
    x: MARGIN_X, y: 0.45, w: CONTENT_W, h: 0.4,
    fontSize: 13, bold: true, color: SERIES_FN, fontFace: "Arial",
    charSpacing: 2,
  });
}

function heading(s, text, opts = {}) {
  s.addText(text, {
    x: MARGIN_X, y: opts.y ?? 0.85, w: opts.w ?? CONTENT_W, h: opts.h ?? 1.0,
    fontSize: opts.fontSize ?? 32, bold: true, color: TEXT_PRIMARY,
    fontFace: "Arial", align: opts.align ?? "left", valign: "top",
  });
}

function subtitle(s, text, y, opts = {}) {
  s.addText(text, {
    x: MARGIN_X, y, w: CONTENT_W, h: opts.h ?? 0.5,
    fontSize: opts.fontSize ?? 16, color: opts.color ?? TEXT_SECONDARY,
    fontFace: "Arial", align: opts.align ?? "left", italic: opts.italic ?? false,
    bold: opts.bold ?? false,
  });
}

function bullets(s, items, y, opts = {}) {
  // items: [{ text, bold }] where `text` is the full line; bold prefix handled via rich text
  const richItems = items.map((it) => ({
    text: it.text,
    options: {
      bullet: { code: "2013" }, // en dash bullet, matches the deck's "–"
      color: TEXT_SECONDARY,
      fontSize: opts.fontSize ?? 15,
      breakLine: true,
      paraSpaceAfter: opts.gap ?? 12,
    },
  }));
  s.addText(richItems, {
    x: MARGIN_X, y, w: opts.w ?? CONTENT_W, h: opts.h ?? 3,
    fontFace: "Arial", valign: "top",
  });
}

function quoteBox(s, text, y, opts = {}) {
  const h = opts.h ?? 1.1;
  s.addShape(pptx.ShapeType.rect, {
    x: MARGIN_X, y, w: opts.w ?? CONTENT_W, h,
    fill: { color: PAGE },
    line: { color: SERIES_FN, width: 3 },
  });
  s.addText(text, {
    x: MARGIN_X + 0.25, y: y + 0.1, w: (opts.w ?? CONTENT_W) - 0.5, h: h - 0.2,
    fontSize: opts.fontSize ?? 15, italic: true, color: TEXT_SECONDARY,
    fontFace: "Arial", valign: "middle",
  });
}

function pageNum(s, n, total) {
  s.addText(`${String(n).padStart(2, "0")} / ${total}`, {
    x: W - 1.6, y: 0.3, w: 1.2, h: 0.3,
    fontSize: 10, color: TEXT_MUTED, align: "right", fontFace: "Arial",
  });
}

// Horizontal bar row: label, track (colored fill), value text
function barRow(s, x, y, w, opts) {
  const trackH = 0.4;
  const labelW = opts.labelW ?? 1.8;
  const valueW = opts.valueW ?? 1.4;
  const trackX = x + labelW + 0.15;
  const trackW = w - labelW - valueW - 0.3;

  s.addText(opts.label, {
    x, y, w: labelW, h: trackH,
    fontSize: 12, bold: true, color: TEXT_SECONDARY, align: "right",
    valign: "middle", fontFace: "Arial",
  });
  s.addShape(pptx.ShapeType.roundRect, {
    x: trackX, y, w: trackW, h: trackH, rectRadius: 0.05,
    fill: { color: GRID }, line: { type: "none" },
  });
  const fillW = Math.max(0.04, trackW * (opts.pct / 100));
  s.addShape(pptx.ShapeType.roundRect, {
    x: trackX, y, w: fillW, h: trackH, rectRadius: 0.05,
    fill: { color: opts.color }, line: { type: "none" },
  });
  s.addText(opts.value, {
    x: trackX + trackW + 0.15, y, w: valueW, h: trackH,
    fontSize: 13, bold: true, color: TEXT_PRIMARY, valign: "middle", fontFace: "Arial",
  });
}

const TOTAL = 19;

// ── Slide 1 — Title ──────────────────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 1, TOTAL);
  kicker(s, "AI Dev TLV · 2026");
  s.addText("ADD", {
    x: MARGIN_X, y: 2.5, w: CONTENT_W, h: 1.1,
    fontSize: 54, bold: true, color: TEXT_PRIMARY, fontFace: "Arial",
  });
  s.addText("AI-Driven Development", {
    x: MARGIN_X, y: 3.55, w: CONTENT_W, h: 0.8,
    fontSize: 40, bold: true, color: TEXT_PRIMARY, fontFace: "Arial",
  });
  subtitle(s, "Your platform wasn't built for AI. Here's what fixes that.", 4.55, { fontSize: 20 });
  subtitle(s, "R&D Director, Priority Hospitality · builder of NavWebMcp", 6.6, { fontSize: 13, color: TEXT_MUTED });
}

// ── Slide 2 — Cold open stat row ─────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 2, TOTAL);
  const tiles = [
    { value: "−80%", label: "tokens, composite vs. raw multi-call" },
    { value: "−73%", label: "latency, composite vs. raw multi-call" },
    { value: "437×", label: "faster to test than through a browser" },
  ];
  const tileW = 3.6, gap = 0.5;
  const totalW = tiles.length * tileW + (tiles.length - 1) * gap;
  let x = (W - totalW) / 2;
  const y = 2.6;
  for (const t of tiles) {
    s.addShape(pptx.ShapeType.roundRect, {
      x, y, w: tileW, h: 2.0, rectRadius: 0.08,
      fill: { color: SURFACE }, line: { color: GRID, width: 1 },
    });
    s.addText(t.value, {
      x, y: y + 0.25, w: tileW, h: 0.9,
      fontSize: 40, bold: true, color: SERIES_FN, align: "center", fontFace: "Arial",
    });
    s.addText(t.label, {
      x: x + 0.2, y: y + 1.15, w: tileW - 0.4, h: 0.7,
      fontSize: 13, color: TEXT_SECONDARY, align: "center", valign: "top", fontFace: "Arial",
    });
    x += tileW + gap;
  }
  subtitle(s, "real MCP transport · real headless browser · n=5 · production build", 5.1, {
    fontSize: 13, color: TEXT_MUTED, align: "center",
  });
}

// ── Slide 3 — Agenda ─────────────────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 3, TOTAL);
  kicker(s, "Agenda");
  heading(s, "Where those numbers come from", { fontSize: 28 });
  const items = [
    "The problem — why current development isn't built for AI",
    'Why "just add an MCP server" doesn\'t fix it',
    "ADD, defined — one rule for where logic lives",
    "Payoff 1 — testing in milliseconds, not seconds",
    "Payoff 2 — what it does to your CI bill",
    "Payoff 3 — the AI-agent development loop",
    "The protocol — NavWebMcp, on top of MCP",
    "Case study — the full numbers, end to end",
  ];
  let y = 1.9;
  items.forEach((label, i) => {
    s.addShape(pptx.ShapeType.roundRect, {
      x: MARGIN_X, y, w: CONTENT_W, h: 0.5, rectRadius: 0.05,
      fill: { color: SURFACE }, line: { color: GRID, width: 1 },
    });
    s.addText(String(i + 1).padStart(2, "0"), {
      x: MARGIN_X + 0.2, y, w: 0.6, h: 0.5,
      fontSize: 12, bold: true, color: SERIES_FN, valign: "middle", fontFace: "Arial",
    });
    s.addText(label, {
      x: MARGIN_X + 0.9, y, w: CONTENT_W - 1.1, h: 0.5,
      fontSize: 14, color: TEXT_PRIMARY, valign: "middle", fontFace: "Arial",
    });
    y += 0.58;
  });
}

// ── Slide 4 — The Problem ────────────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 4, TOTAL);
  kicker(s, "The Problem");
  heading(s, "Current development isn't built for AI", { fontSize: 28 });
  subtitle(s, "Every team bolting an agent onto their product hits the same wall.", 1.75, { fontSize: 15 });
  bullets(s, [
    { text: "Hallucinated calls — guesses at a sequence nothing tells it" },
    { text: "Non-deterministic — same request, different path each time" },
    { text: "Endless back-and-forth — a dozen turns to gather one form's worth of input" },
    { text: "Doesn't connect at all — weeks of bespoke glue just to start" },
  ], 2.4, { fontSize: 15, gap: 14, h: 2.6 });
  quoteBox(s, "That's not an agent problem. It's an architecture problem: most software was never designed to be consumed — only to be clicked.", 5.6, { h: 1.1 });
}

// ── Slide 5 — The False Fix ──────────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 5, TOTAL);
  kicker(s, "The False Fix");
  heading(s, "Stop Bending Your Platform to Fit an Agent", { fontSize: 28 });
  subtitle(s, 'Why "just add an MCP server" doesn\'t fix it?', 1.7, { fontSize: 15 });
  subtitle(s, "Most integrations wrap a human-shaped API in tool definitions — one tool per endpoint. The agent still has to:", 2.15, { fontSize: 14 });
  bullets(s, [
    { text: "Orchestrate multiple calls — the wrapper gave it a schema, not less work" },
    { text: "Re-read growing context — every call's result reprocessed on the next" },
    { text: "Learn your domain from the prompt — sequencing, preconditions, dependencies" },
  ], 2.85, { fontSize: 15, gap: 14, h: 2.2 });
  quoteBox(s, "Wrapping the API is not the same as re-architecting it. MCP is a transport. It was never the fix.", 5.6, { h: 0.9 });
}

// ── Slide 6 — ADD, Defined ───────────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 6, TOTAL);
  kicker(s, "ADD, Defined");
  heading(s, "You already wrote the business logic.", { fontSize: 28, h: 0.6 });
  heading(s, "You just wrote it in the wrong place.", { y: 1.5, fontSize: 28, h: 0.6 });
  subtitle(s, "Validation, orchestration, business rules — scattered across every onClick, every useEffect, every route handler that happens to need them.", 2.35, { fontSize: 15, h: 1.0 });
  quoteBox(s, "ADD's one rule: business logic gets its own layer, separate from the UI that triggers it.", 3.7, { h: 0.9 });
  subtitle(s, "One function. One place. The UI becomes what it should've been all along — a thin caller.", 4.9, { fontSize: 15 });
}

// ── Slide 7 — Architecture diagram (✕ / ✓ panels) ────────────────────────────
{
  const s = newSlide();
  pageNum(s, 7, TOTAL);
  kicker(s, "Architecture");
  heading(s, "Same logic. One place, not forty.", { fontSize: 28 });

  const panelY = 1.9, panelH = 4.6, panelW = (CONTENT_W - 0.5) / 2;
  const leftX = MARGIN_X, rightX = MARGIN_X + panelW + 0.5;

  // Bad panel
  s.addShape(pptx.ShapeType.roundRect, {
    x: leftX, y: panelY, w: panelW, h: panelH, rectRadius: 0.08,
    fill: { color: "2A1F1B" }, line: { color: SERIES_PW, width: 1.5 },
  });
  s.addText([
    { text: "✕  ", options: { color: SERIES_PW, bold: true } },
    { text: "Logic lives in the click handler", options: { color: SERIES_PW, bold: true } },
  ], { x: leftX + 0.3, y: panelY + 0.25, w: panelW - 0.6, h: 0.4, fontSize: 15, fontFace: "Arial" });
  s.addText(
    `<Button onClick={async () => {\n  if (!date) return;\n  const ok = await fetch('/api/check');\n  if (!ok) return showError();\n  await fetch('/api/reserve');\n  // ...and again, next screen\n}}>`,
    {
      x: leftX + 0.3, y: panelY + 0.8, w: panelW - 0.6, h: 2.0,
      fontSize: 11, color: TEXT_SECONDARY, fontFace: "Consolas", valign: "top",
      fill: { color: PAGE },
    }
  );
  s.addText("Repeated in every screen that needs it — each copy one edit away from drifting apart.", {
    x: leftX + 0.3, y: panelY + 3.0, w: panelW - 0.6, h: 1.2,
    fontSize: 12, color: TEXT_SECONDARY, fontFace: "Arial", valign: "top",
  });

  // Good panel
  s.addShape(pptx.ShapeType.roundRect, {
    x: rightX, y: panelY, w: panelW, h: panelH, rectRadius: 0.08,
    fill: { color: "1B2530" }, line: { color: SERIES_FN, width: 1.5 },
  });
  s.addText([
    { text: "✓  ", options: { color: SERIES_FN, bold: true } },
    { text: "Logic lives in its own layer", options: { color: SERIES_FN, bold: true } },
  ], { x: rightX + 0.3, y: panelY + 0.25, w: panelW - 0.6, h: 0.4, fontSize: 15, fontFace: "Arial" });
  s.addText(
    `// lib/operations/book.ts\nexport async function book(input) {\n  if (!input.date) throw ValidationError;\n  const ok = await checkAvailability(input);\n  if (!ok) throw UnavailableError;\n  return reserve(input);\n}`,
    {
      x: rightX + 0.3, y: panelY + 0.8, w: panelW - 0.6, h: 1.8,
      fontSize: 11, color: TEXT_SECONDARY, fontFace: "Consolas", valign: "top",
      fill: { color: PAGE },
    }
  );
  // UI / Test / Agent pills
  const pillY = panelY + 2.75;
  const pillLabels = ["UI", "Test", "Agent"];
  const pillW = 0.9, pillGap = (panelW - 0.6 - pillW * 3) / 2;
  let px = rightX + 0.3;
  for (const label of pillLabels) {
    s.addShape(pptx.ShapeType.roundRect, {
      x: px, y: pillY, w: pillW, h: 0.4, rectRadius: 0.2,
      fill: { color: PAGE }, line: { color: GRID, width: 1 },
    });
    s.addText(label, {
      x: px, y: pillY, w: pillW, h: 0.4,
      fontSize: 11, bold: true, color: TEXT_PRIMARY, align: "center", valign: "middle", fontFace: "Arial",
    });
    px += pillW + pillGap;
  }
  s.addText("One function, one set of rules. The UI is just the first caller — not the logic's home.", {
    x: rightX + 0.3, y: panelY + 3.4, w: panelW - 0.6, h: 1.0,
    fontSize: 12, color: TEXT_SECONDARY, fontFace: "Arial", valign: "top",
  });
}

// ── Slide 8 — Payoff 1: Testing speed ────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 8, TOTAL);
  kicker(s, "Payoff 1 · Testing");
  heading(s, "Test the logic, not the DOM", { fontSize: 28 });
  subtitle(s, "Same scenario, same validation, same RBAC — one path goes through a real browser, the other calls the operation directly.", 1.7, { fontSize: 14 });

  // legend
  s.addShape(pptx.ShapeType.rect, { x: MARGIN_X, y: 2.35, w: 0.18, h: 0.18, fill: { color: SERIES_PW }, line: { type: "none" } });
  s.addText("Playwright (browser)", { x: MARGIN_X + 0.25, y: 2.3, w: 2.5, h: 0.3, fontSize: 12, color: TEXT_SECONDARY, fontFace: "Arial" });
  s.addShape(pptx.ShapeType.rect, { x: MARGIN_X + 3.0, y: 2.35, w: 0.18, h: 0.18, fill: { color: SERIES_FN }, line: { type: "none" } });
  s.addText("Function call (direct)", { x: MARGIN_X + 3.25, y: 2.3, w: 2.8, h: 0.3, fontSize: 12, color: TEXT_SECONDARY, fontFace: "Arial" });

  let y = 2.9;
  const groups = [
    { title: "book()", pw: "388 ms", fn: "0.89 ms", pwPct: 100, fnPct: 0.6, tag: "437× faster" },
    { title: "seatGuest()", pw: "459 ms", fn: "0.35 ms", pwPct: 100, fnPct: 0.2, tag: "1,314× faster" },
  ];
  for (const g of groups) {
    s.addText(g.title.toUpperCase(), { x: MARGIN_X, y, w: 3, h: 0.3, fontSize: 11, bold: true, color: TEXT_MUTED, fontFace: "Arial" });
    y += 0.35;
    barRow(s, MARGIN_X, y, CONTENT_W, { label: "Playwright", value: g.pw, pct: g.pwPct, color: SERIES_PW });
    y += 0.48;
    barRow(s, MARGIN_X, y, CONTENT_W, { label: "Function", value: g.fn, pct: g.fnPct, color: SERIES_FN });
    y += 0.4;
    s.addText(g.tag, {
      x: MARGIN_X + 2.0, y, w: 2, h: 0.35,
      fontSize: 11, bold: true, color: SERIES_FN, fontFace: "Arial",
      fill: { color: "1B2530" },
    });
    y += 0.55;
  }
  s.addText("HOSTVIPGUEST()", { x: MARGIN_X, y, w: 3, h: 0.3, fontSize: 11, bold: true, color: TEXT_MUTED, fontFace: "Arial" });
  y += 0.35;
  s.addText("Playwright: no UI exists", { x: MARGIN_X, y, w: 4, h: 0.3, fontSize: 12, color: TEXT_MUTED, fontFace: "Arial" });
  y += 0.35;
  barRow(s, MARGIN_X, y, CONTENT_W, { label: "Function", value: "0.18 ms", pct: 0.1, color: SERIES_FN });
  y += 0.55;

  subtitle(s, "Every one of those milliseconds is a runner-minute your DevOps team isn't paying for — this is where the FinOps story starts.", y + 0.1, { fontSize: 12, color: TEXT_MUTED });
}

// ── Slide 9 — Cost chain ─────────────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 9, TOTAL);
  kicker(s, "DevOps & FinOps · The Cost Chain");
  heading(s, "A single test's cost is invisible. Multiply it.", { fontSize: 28 });
  subtitle(s, "One 388ms test doesn't move a budget. Run on every commit, every PR, every branch — it does.", 1.75, { fontSize: 15 });

  const chainItems = ["test duration", "number of tests", "runner cost / minute", "your CI bill"];
  const chainW = 2.5, chainGap = 0.5;
  let cx = MARGIN_X;
  const cy = 2.6;
  chainItems.forEach((label, i) => {
    const isLast = i === chainItems.length - 1;
    s.addShape(pptx.ShapeType.roundRect, {
      x: cx, y: cy, w: chainW, h: 0.55, rectRadius: 0.08,
      fill: { color: PAGE }, line: { color: isLast ? SERIES_FN : GRID, width: isLast ? 1.5 : 1 },
    });
    s.addText(label, {
      x: cx, y: cy, w: chainW, h: 0.55,
      fontSize: 13, bold: true, color: isLast ? SERIES_FN : TEXT_PRIMARY,
      align: "center", valign: "middle", fontFace: "Arial",
    });
    cx += chainW;
    if (!isLast) {
      s.addText(i === chainItems.length - 2 ? "=" : "×", {
        x: cx, y: cy, w: chainGap, h: 0.55,
        fontSize: 16, color: TEXT_MUTED, align: "center", valign: "middle", fontFace: "Arial",
      });
      cx += chainGap;
    }
  });

  bullets(s, [
    { text: "A real suite is thousands of tests, not one — and that number only grows" },
    { text: "Fewer tests trades away coverage. Cheaper tests doesn't." },
  ], 3.7, { fontSize: 15, gap: 14, h: 1.4 });

  quoteBox(s, "Fast tests don't just save a developer a few seconds. They change what your organization can afford to run, and how often.", 5.4, { h: 1.0 });
}

// ── Slide 10 — CI cost worked example ────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 10, TOTAL);
  kicker(s, "Payoff 2 · CI & Cloud Cost");
  heading(s, "What isn't obvious until you do the math", { fontSize: 28 });
  subtitle(s, "Every Playwright test needs a real browser: spun up, rendered, torn down. A function call needs none of it.", 1.75, { fontSize: 14 });

  s.addText("1,000 BOOK() TESTS — CI RUNNER TIME NEEDED", {
    x: MARGIN_X, y: 2.5, w: CONTENT_W, h: 0.3, fontSize: 11, bold: true, color: TEXT_MUTED, fontFace: "Arial",
  });
  let y = 2.9;
  barRow(s, MARGIN_X, y, CONTENT_W, { label: "Playwright", value: "≈ 6.5 minutes", pct: 100, color: SERIES_PW, valueW: 1.8 });
  y += 0.55;
  barRow(s, MARGIN_X, y, CONTENT_W, { label: "Function call", value: "≈ 1 second", pct: 0.3, color: SERIES_FN, valueW: 1.8 });
  y += 0.7;

  subtitle(s, "Runner time only — derived by multiplying Payoff 1's measured per-test duration (388ms vs. 0.89ms) by 1,000 tests. No separate cost benchmark, no $/minute figures claimed.", y, { fontSize: 12, color: TEXT_MUTED, h: 0.6 });

  quoteBox(s, "A suite that needs an hour of browser time can run as direct calls in seconds. You're no longer choosing between thorough and affordable.", y + 0.9, { h: 1.0 });
}

// ── Slide 11 — Dev/agent loop ─────────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 11, TOTAL);
  kicker(s, "Payoff 3 · The Development Loop");
  heading(s, "Every change has to be verified before it's trusted", { fontSize: 26 });
  subtitle(s, "Write → test → read result → fix → run again. Same loop, human or agent.", 1.65, { fontSize: 15 });

  function lane(y, label, steps, repeat, color) {
    s.addText(label, { x: MARGIN_X, y, w: 1.4, h: 0.45, fontSize: 12, bold: true, color: TEXT_SECONDARY, valign: "middle", fontFace: "Arial" });
    let x = MARGIN_X + 1.5;
    steps.forEach((step, i) => {
      const stepW = 1.5;
      s.addShape(pptx.ShapeType.roundRect, {
        x, y, w: stepW, h: 0.45, rectRadius: 0.06,
        fill: { color: PAGE }, line: { color, width: 1 },
      });
      s.addText(step, { x, y, w: stepW, h: 0.45, fontSize: 11, bold: true, color: TEXT_PRIMARY, align: "center", valign: "middle", fontFace: "Arial" });
      x += stepW + 0.05;
      if (i < steps.length - 1) {
        s.addText("→", { x, y, w: 0.3, h: 0.45, fontSize: 13, color: TEXT_MUTED, align: "center", valign: "middle", fontFace: "Arial" });
        x += 0.35;
      }
    });
    s.addText(repeat, { x: x + 0.1, y, w: 2.5, h: 0.45, fontSize: 11, italic: true, color: TEXT_MUTED, valign: "middle", fontFace: "Arial" });
  }
  lane(2.25, "Browser test", ["write", "boot browser", "click through", "read result"], "1 iteration", SERIES_PW);
  lane(2.85, "Function call", ["write", "call operation", "read result"], "dozens of iterations, same time budget", SERIES_FN);

  subtitle(s, "If the loop itself is an AI agent driving Playwright, it compounds twice — it has to re-read the page after every click too:", 3.6, { fontSize: 13 });

  s.addText("TOKENS READ PER VERIFICATION, BOOKING FLOW", {
    x: MARGIN_X, y: 4.2, w: CONTENT_W, h: 0.3, fontSize: 10, bold: true, color: TEXT_MUTED, fontFace: "Arial",
  });
  barRow(s, MARGIN_X, 4.55, CONTENT_W, { label: "Function call", value: "91 tok", pct: 1.6, color: SERIES_FN });
  barRow(s, MARGIN_X, 5.1, CONTENT_W, { label: "Agent + Playwright", value: "5,721 tok", pct: 100, color: SERIES_PW });

  subtitle(s, "~63× more tokens just to observe the page — a fresh accessibility snapshot after every click.", 5.7, { fontSize: 11, color: TEXT_MUTED });

  quoteBox(s, "Not because the agent got smarter. Because the loop it depends on got 100–1,000× tighter — and stopped paying a re-read tax on every step.", 6.15, { h: 1.05, fontSize: 13 });
}

// ── Slide 12 — Transition ─────────────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 12, TOTAL);
  kicker(s, "So Far · So Next");
  s.addText("Everything up to now made you faster.", {
    x: MARGIN_X, y: 2.6, w: CONTENT_W, h: 0.8, fontSize: 30, bold: true, color: TEXT_PRIMARY, align: "center", fontFace: "Arial",
  });
  subtitle(s, "Testing, CI cost, the dev loop — all payoffs for the team writing the code.", 3.6, { fontSize: 16, align: "center" });
  subtitle(s, "Now the platform has a second user: an AI agent, acting on someone else's behalf.", 4.15, { fontSize: 16, align: "center", bold: true, color: TEXT_PRIMARY });
  subtitle(s, "Same operations layer. A different caller.", 5.4, { fontSize: 13, color: TEXT_MUTED, align: "center" });
}

// ── Slide 13 — The Protocol ───────────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 13, TOTAL);
  kicker(s, "The Protocol");
  heading(s, "NavWebMcp — MCP as transport, not architecture", { fontSize: 26 });
  subtitle(s, "If your business logic already lives in its own layer, exposing it to an agent is the easy part.", 1.7, { fontSize: 14 });
  bullets(s, [
    { text: "Composite operations — one call replaces three or seven" },
    { text: "Progressive disclosure — a handful of tools at connect, the rest on demand" },
    { text: "RBAC & confirmation, enforced once — same checks your UI already respects" },
    { text: 'One registry, two surfaces — nothing re-implemented as "the agent version"' },
  ], 2.35, { fontSize: 15, gap: 14, h: 2.6 });
  quoteBox(s, "If you did the architecture right, this layer is nearly mechanical to add. That's the point.", 5.5, { h: 0.9 });
}

// ── Slide 14 — Protocol under the hood ────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 14, TOTAL);
  kicker(s, "The Protocol · Under the Hood");
  heading(s, "Eight meta-tools. Nothing else to install.", { fontSize: 28 });

  const colW = (CONTENT_W - 0.5) / 2;
  s.addText("DISCOVERY", { x: MARGIN_X, y: 2.1, w: colW, h: 0.3, fontSize: 12, bold: true, color: TEXT_MUTED, fontFace: "Arial" });
  bullets(s, [
    { text: "explore — walk the module tree" },
    { text: "search — glob for operations" },
    { text: "describe_tool — get the schema" },
  ], 2.5, { fontSize: 14, gap: 14, w: colW, h: 1.8 });

  s.addText("EXECUTION & SESSION", { x: MARGIN_X + colW + 0.5, y: 2.1, w: colW, h: 0.3, fontSize: 12, bold: true, color: TEXT_MUTED, fontFace: "Arial" });
  s.addText([
    { text: "invoke — call any op directly", options: { bullet: { code: "2013" }, color: TEXT_SECONDARY, breakLine: true, paraSpaceAfter: 14 } },
    { text: "load_tools / unload_tools", options: { bullet: { code: "2013" }, color: TEXT_SECONDARY, breakLine: true, paraSpaceAfter: 14 } },
    { text: "getContext / getCapabilities — preflight", options: { bullet: { code: "2013" }, color: TEXT_SECONDARY, breakLine: true, paraSpaceAfter: 14 } },
  ], { x: MARGIN_X + colW + 0.5, y: 2.5, w: colW, h: 1.8, fontSize: 14, fontFace: "Arial", valign: "top" });

  s.addText("ONE REGISTRATION, ALL EIGHT TOOLS READ IT", {
    x: MARGIN_X, y: 4.05, w: CONTENT_W, h: 0.3, fontSize: 11, bold: true, color: TEXT_MUTED, fontFace: "Arial",
  });
  s.addText(
    [
      "defineOperation({",
      '  name: "book",',
      '  description: "Book a table in ONE step: find a slot, reserve, validate.",',
      "  inputSchema: { date, time, partySize, name },",
      '  permission: "write",             // read | write',
      '  roles: ["customer", "support", "admin"],  // who can call it',
      '  module: "reservation.booking",  // where it lives in the tree',
      "  handler: (input, ctx) => bookOrchestration(input, ctx)",
      "})",
    ].join("\n"),
    {
      x: MARGIN_X, y: 4.4, w: CONTENT_W, h: 2.05,
      fontSize: 11, color: TEXT_SECONDARY, fontFace: "Consolas", valign: "top",
      fill: { color: SURFACE },
    }
  );

  quoteBox(s, "A completely standard MCP client — Claude Desktop, Claude Code, MCP Inspector. No custom transport. No fork. No special build.", 6.6, { h: 0.75, fontSize: 12 });
}

// ── Slide 15 — Case study: tokens ─────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 15, TOTAL);
  kicker(s, "Case Study · Booking Flow");
  heading(s, "Tokens per booking", { fontSize: 28 });
  subtitle(s, "Same booking, three ways: raw MCP, raw WebMCP, and one NavWebMcp composite call.", 1.7, { fontSize: 14 });

  let y = 2.5;
  barRow(s, MARGIN_X, y, CONTENT_W, { label: "Raw MCP", value: "366 tok", pct: 100, color: TEXT_MUTED });
  y += 0.55;
  barRow(s, MARGIN_X, y, CONTENT_W, { label: "WebMCP", value: "259 tok", pct: 70.8, color: TEXT_MUTED });
  y += 0.55;
  barRow(s, MARGIN_X, y, CONTENT_W, { label: "NavWebMcp", value: "91 tok", pct: 24.9, color: SERIES_FN });
  y += 0.7;

  s.addShape(pptx.ShapeType.rect, { x: MARGIN_X, y, w: 0.18, h: 0.18, fill: { color: TEXT_MUTED }, line: { type: "none" } });
  s.addText("Raw multi-call (3 calls)", { x: MARGIN_X + 0.25, y: y - 0.05, w: 2.8, h: 0.3, fontSize: 12, color: TEXT_SECONDARY, fontFace: "Arial" });
  s.addShape(pptx.ShapeType.rect, { x: MARGIN_X + 3.2, y, w: 0.18, h: 0.18, fill: { color: SERIES_FN }, line: { type: "none" } });
  s.addText("NavWebMcp composite (1 call)", { x: MARGIN_X + 3.45, y: y - 0.05, w: 3.2, h: 0.3, fontSize: 12, color: TEXT_SECONDARY, fontFace: "Arial" });

  quoteBox(s, "−75% tokens vs. raw calls over MCP, −65% vs. the same raw calls made from inside the browser — one composite call beats raw multi-call on every surface.", y + 0.6, { h: 1.0 });
}

// ── Slide 16 — Case study: latency ────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 16, TOTAL);
  kicker(s, "Case Study · Booking Flow");
  heading(s, "Latency per booking", { fontSize: 28 });
  subtitle(s, "Playwright shown separately — a different way of interacting with the app entirely.", 1.7, { fontSize: 14 });

  let y = 2.5;
  barRow(s, MARGIN_X, y, CONTENT_W, { label: "Raw MCP", value: "15 ms", pct: 37.5, color: TEXT_MUTED });
  y += 0.55;
  barRow(s, MARGIN_X, y, CONTENT_W, { label: "WebMCP", value: "40 ms", pct: 100, color: TEXT_MUTED });
  y += 0.55;
  barRow(s, MARGIN_X, y, CONTENT_W, { label: "NavWebMcp", value: "5 ms", pct: 12.5, color: SERIES_FN });
  y += 0.65;
  barRow(s, MARGIN_X, y, CONTENT_W, { label: "Playwright (UI)", value: "342 ms", pct: 100, color: SERIES_PW });
  y += 0.6;

  subtitle(s, "Playwright scaled on its own axis (max = 342ms) — not directly comparable to the rows above.", y, { fontSize: 12, color: TEXT_MUTED });

  quoteBox(s, '−67% latency vs. raw MCP, −88% vs. the same raw calls made from a browser page — the composite call wins even against the surface it\'s supposedly "slower" on.', y + 0.55, { h: 1.0 });
}

// ── Slide 17 — Case study: compounds with scope ───────────────────────────────
{
  const s = newSlide();
  pageNum(s, 17, TOTAL);
  kicker(s, "Case Study · It Compounds");
  heading(s, "The bigger the flow, the bigger the win", { fontSize: 28 });

  const rows = [
    ["Scenario", "Raw calls", "Composite calls", "Token saving", "Latency saving"],
    ["book — 3-op booking", "3", "1", "−75%", "−67%"],
    ["journey — book + seat a guest", "6", "2", "−81%", "−63%"],
    ["vip — 7-op chain, CRM + front desk", "7", "1", "−68%", "−87%"],
  ];
  const colWidths = [4.6, 1.6, 1.9, 1.8, 1.8];
  const tableRows = rows.map((row, ri) =>
    row.map((cell, ci) => ({
      text: cell,
      options: {
        color: ri === 0 ? TEXT_MUTED : ci === 0 ? TEXT_PRIMARY : (ri === 3 ? "0CA30C" : TEXT_SECONDARY),
        bold: ri === 0 || ci === 0 || ri === 3,
        fontSize: ri === 0 ? 11 : 13,
        fill: ri === 3 ? { color: "1B2530" } : { color: PAGE },
        align: ci === 0 ? "left" : "left",
      },
    }))
  );
  s.addTable(tableRows, {
    x: MARGIN_X, y: 2.0, w: CONTENT_W, colW: colWidths,
    border: { type: "solid", color: GRID, pt: 0.5 },
    fontFace: "Arial", valign: "middle", rowH: 0.55,
  });

  subtitle(s, "vip has no Playwright row — no UI exists for that domain. A limit browser automation has that a composite call doesn't.", 4.4, { fontSize: 14 });
}

// ── Slide 18 — Synthesis ───────────────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 18, TOTAL);
  kicker(s, "Putting It Together");
  heading(s, "Five payoffs, one architecture decision", { fontSize: 28 });

  const recap = [
    ["01", "Testing:", "direct calls instead of a browser — up to 1,314× faster per test."],
    ["02", "DevOps & FinOps:", "the same separation lets every commit run every test without your cloud bill or your CI queue noticing."],
    ["03", "Dev loop:", "the same tight loop that helps your tests helps your AI coding agent iterate — 100–1,000× tighter."],
    ["04", "Protocol:", "NavWebMcp, a thin layer on top of MCP, makes agent-exposure mechanical instead of a redesign."],
    ["05", "Case study:", "−68 to −75% tokens, −67 to −87% latency, measured on the exact operations your UI already calls."],
  ];
  let y = 1.85;
  for (const [num, label, text] of recap) {
    s.addText(num, { x: MARGIN_X, y, w: 0.5, h: 0.55, fontSize: 13, bold: true, color: SERIES_FN, fontFace: "Arial" });
    s.addText([
      { text: label + " ", options: { bold: true, color: TEXT_PRIMARY } },
      { text, options: { color: TEXT_SECONDARY } },
    ], { x: MARGIN_X + 0.6, y, w: CONTENT_W - 0.6, h: 0.55, fontSize: 14, fontFace: "Arial", valign: "top" });
    y += 0.62;
  }

  quoteBox(s, 'None of this started with "add an MCP server." It started with a much older, much less glamorous decision: where does your business logic actually live?', y + 0.15, { h: 1.0 });
}

// ── Slide 19 — Closing ─────────────────────────────────────────────────────────
{
  const s = newSlide();
  pageNum(s, 19, TOTAL);
  kicker(s, "Thank You");
  s.addText("You don't bend your platform to fit AI.", {
    x: MARGIN_X, y: 2.7, w: CONTENT_W, h: 0.8, fontSize: 32, bold: true, color: TEXT_PRIMARY, align: "center", fontFace: "Arial",
  });
  subtitle(s, "You just stop making AI the first thing that has to bend.", 3.7, { fontSize: 20, align: "center" });
  s.addText([
    { text: "ADD — AI-Driven Development", options: { color: TEXT_SECONDARY } },
    { text: "    ·    ", options: { color: TEXT_MUTED } },
    { text: "Questions welcome", options: { color: TEXT_SECONDARY } },
  ], { x: MARGIN_X, y: 5.0, w: CONTENT_W, h: 0.5, fontSize: 14, align: "center", fontFace: "Arial" });
}

await pptx.writeFile({ fileName: "docs/talk-add.pptx" });
console.log("Wrote docs/talk-add.pptx");
