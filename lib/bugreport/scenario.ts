import type { NetworkEntry, Scenario, ScenarioStep, StepCall } from "./types";
import { selectorFor, reactComponentStack, resolveProvenance, cssEscape } from "./describeElement";
import { networkCursor, networkSince, clip } from "./capture";

// Records a user-driven scenario: every click / input / select / submit / tab
// change becomes a step, and each business call (/api/call) made while
// recording is attributed to the step that triggered it — so a report shows
// "clicked Check in → checkInGuest ✓ → getOccupancy says t_02 available".
//
// Module singleton on purpose: recording must survive re-renders and tab
// switches. A full page reload ends it.

export const MAX_STEPS = 100;
export const MAX_DURATION_MS = 3 * 60 * 1000;

type Listener = () => void;

interface RawStep extends Omit<ScenarioStep, "calls"> { startMs: number }

interface Recording {
  startedAt: string;
  startMs: number;
  startUrl: string;
  cursor: number;
  steps: RawStep[];
  truncated: boolean;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

let current: Recording | null = null;
const listeners = new Set<Listener>();
const notify = () => listeners.forEach((l) => l());

export function isRecording(): boolean {
  return current !== null;
}

export function recordingInfo(): { elapsedMs: number; steps: number } | null {
  return current ? { elapsedMs: Date.now() - current.startMs, steps: current.steps.length } : null;
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function isReporterUi(el: Element | null): boolean {
  return Boolean(el?.closest("[data-bug-reporter-ui]"));
}

function labelOf(el: Element): string | undefined {
  if (!(el instanceof HTMLElement)) return undefined;
  if (el.id) {
    const lab = el.ownerDocument.querySelector(`label[for="${cssEscape(el.id)}"]`);
    if (lab?.textContent?.trim()) return lab.textContent.trim().slice(0, 300);
  }
  const wrap = el.closest("label");
  if (wrap?.textContent?.trim()) return wrap.textContent.trim().slice(0, 300);
  const aria = el.getAttribute("aria-label") ?? el.getAttribute("placeholder");
  return aria ? aria.slice(0, 300) : undefined;
}

/** The element a click "means": the nearest button/link/tab/input, else the element itself. */
function actionable(el: Element): Element {
  return el.closest("button, a, [role=button], [role=tab], input, select, textarea, label, summary") ?? el;
}

const textOf = (el: Element) => (((el as HTMLElement).innerText ?? el.textContent ?? "")).replace(/\s+/g, " ").trim();

/** Index of `el` among elements the repro's locator would also match
 *  (same label, or same role + name) — only when there's more than one, so
 *  the Playwright draft can say .nth(i) instead of hitting strict mode. */
function nthAmong(el: Element, label: string | undefined, text: string, scope: ParentNode): number | undefined {
  let candidates: Element[] = [];
  if ((el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) && label) {
    candidates = Array.from(scope.querySelectorAll("input, select, textarea")).filter((c) => labelOf(c) === label);
  } else if (text) {
    const isTab = el.getAttribute("role") === "tab";
    const sel = isTab ? "[role=tab]" : "button:not([role=tab]), [role=button]";
    if (el.matches(sel)) candidates = Array.from(scope.querySelectorAll(sel)).filter((c) => textOf(c) === text);
  }
  candidates = candidates.filter((c) => !isReporterUi(c));
  return candidates.length > 1 ? Math.max(0, candidates.indexOf(el)) : undefined;
}

function targetOf(el: Element): NonNullable<ScenarioStep["target"]> {
  const text = textOf(el);
  const stack = reactComponentStack(el);
  const component = el.closest("[data-bug-component]")?.getAttribute("data-bug-component") ?? stack[0];
  const prov = resolveProvenance(el);
  const label = labelOf(el);
  const scope = (prov?.entity && el.closest(`[data-bug-entity="${cssEscape(prov.entity)}"]`)) || el.ownerDocument;
  const nth = nthAmong(el, label, text, scope);
  return {
    selector: clip(selectorFor(el), 1_900),
    tag: el.tagName.toLowerCase(),
    text: text.slice(0, 300),
    ...(label ? { label } : {}),
    ...(el.getAttribute("role") ? { role: el.getAttribute("role")!.slice(0, 50) } : {}),
    ...(el instanceof HTMLInputElement ? { inputType: el.type } : {}),
    ...(component ? { component: component.slice(0, 200) } : {}),
    ...(prov ? { provenance: prov } : {}),
    ...(nth !== undefined ? { nth } : {}),
  };
}

function addStep(kind: ScenarioStep["kind"], el: Element | null, value?: string) {
  const rec = current;
  if (!rec) return;
  if (rec.steps.length >= MAX_STEPS) { rec.truncated = true; return; }
  const now = Date.now();
  rec.steps.push({
    index: rec.steps.length,
    ts: new Date(now).toISOString(),
    tOffsetMs: now - rec.startMs,
    startMs: now,
    kind,
    ...(el ? { target: targetOf(el) } : {}),
    ...(value !== undefined ? { value: value.slice(0, 1_000) } : {}),
  });
  notify();
}

function valueOf(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === "password") return "[redacted]";
    if (el.type === "checkbox" || el.type === "radio") return String(el.checked);
    return el.value;
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
  return undefined;
}

export interface StartOptions {
  /** Called when a cap (duration) ends the recording on its own. */
  onAutoStop?: () => void;
}

export function startScenario(opts: StartOptions = {}): void {
  if (current || typeof window === "undefined") return;

  const onClick = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (!t || isReporterUi(t)) return;
    const el = actionable(t);
    // Typing into a field is recorded on change; the focusing click is noise.
    if (el instanceof HTMLInputElement && !["checkbox", "radio", "submit", "button"].includes(el.type)) return;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
    addStep("click", el);
  };
  const onChange = (e: Event) => {
    const t = e.target as Element | null;
    if (!t || isReporterUi(t)) return;
    if (t instanceof HTMLInputElement && (t.type === "checkbox" || t.type === "radio")) return; // already a click
    addStep(t instanceof HTMLSelectElement ? "select" : "input", t, valueOf(t));
  };
  const onSubmit = (e: Event) => {
    const t = e.target as Element | null;
    if (!t || isReporterUi(t)) return;
    // A submit fired by clicking a submit button is already that click.
    const last = current?.steps[current.steps.length - 1];
    if (last && last.kind === "click" && Date.now() - last.startMs < 50) return;
    addStep("submit", t);
  };
  const onHash = () => addStep("navigate", null, window.location.hash);

  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("submit", onSubmit, true);
  window.addEventListener("hashchange", onHash);

  const startMs = Date.now();
  current = {
    startedAt: new Date(startMs).toISOString(),
    startMs,
    startUrl: window.location.href,
    cursor: networkCursor(),
    steps: [],
    truncated: false,
    timer: setTimeout(() => { if (current) { current.truncated = true; opts.onAutoStop?.(); } }, MAX_DURATION_MS),
    cleanup: () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("change", onChange, true);
      document.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("hashchange", onHash);
    },
  };
  notify();
}

function toCall(n: NetworkEntry): StepCall {
  let preview: string | undefined;
  if (n.responseBody) {
    try {
      const body = JSON.parse(n.responseBody) as { data?: unknown; error?: unknown };
      preview = JSON.stringify(body.data ?? body.error ?? body);
    } catch {
      preview = n.responseBody; // clipped upstream — keep the readable prefix
    }
  }
  return {
    name: n.op!.name,
    params: n.op!.params,
    success: n.op!.success,
    ...(n.op!.errorCode ? { errorCode: n.op!.errorCode } : {}),
    ...(preview ? { resultPreview: clip(preview, 2_400) } : {}),
  };
}

/** Assigns each business call to the last step that started at or before the
 *  request started. Calls before the first step (e.g. a poll) go to no step. */
export function attributeCalls(steps: RawStep[], network: NetworkEntry[]): ScenarioStep[] {
  const out: ScenarioStep[] = steps.map(({ startMs: _s, ...rest }) => ({ ...rest, calls: [] }));
  for (const n of network) {
    if (!n.op) continue;
    const t = Date.parse(n.ts);
    let idx = -1;
    for (let i = 0; i < steps.length; i++) if (steps[i].startMs <= t + 5) idx = i; // 5ms: same-tick fetches
    if (idx >= 0 && out[idx].calls.length < 30) out[idx].calls.push(toCall(n));
  }
  return out;
}

export function stopScenario(): Scenario | null {
  const rec = current;
  if (!rec) return null;
  clearTimeout(rec.timer);
  rec.cleanup();
  current = null;
  notify();
  return {
    startedAt: rec.startedAt,
    durationMs: Date.now() - rec.startMs,
    startUrl: rec.startUrl,
    steps: attributeCalls(rec.steps, networkSince(rec.cursor)),
    truncated: rec.truncated,
  };
}
