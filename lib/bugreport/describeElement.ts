import type { ElementInfo, Provenance } from "./types";
import { valueAtPath } from "./annotate";
import { findLastCall, lastDataFor, clip } from "./capture";

const STYLE_PROPS = [
  "display", "position", "width", "height", "margin", "padding",
  "color", "background-color", "font-family", "font-size", "font-weight", "line-height",
  "text-align", "visibility", "opacity", "overflow", "white-space", "text-overflow", "z-index",
];

export function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/** Short, stable-enough selector: stops at the first id; otherwise tag +
 *  nth-of-type up to <body>. */
export function selectorFor(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1 && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
    if (cur.id) {
      parts.unshift(`#${cssEscape(cur.id)}`);
      break;
    }
    let part = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(" > ") || el.tagName.toLowerCase();
}

/** React component names from the element up to the root, innermost first.
 *  Reads React's internal fiber key — best effort, empty if React changes it. */
export function reactComponentStack(el: Element): string[] {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return [];
  const names: string[] = [];
  type Fiber = { type?: unknown; return?: Fiber | null };
  let fiber = (el as unknown as Record<string, Fiber>)[key] as Fiber | null;
  while (fiber && names.length < 30) {
    const t = fiber.type as { displayName?: string; name?: string } | string | undefined;
    if (t && typeof t !== "string") {
      const name = t.displayName || t.name;
      if (name && names[names.length - 1] !== name && !/^(Anonymous|_c\d*)$/.test(name)) names.push(name);
    }
    fiber = fiber.return ?? null;
  }
  return names;
}

function labelFor(el: Element): string | undefined {
  if (!(el instanceof HTMLElement)) return undefined;
  const id = el.id;
  if (id) {
    const lab = el.ownerDocument.querySelector(`label[for="${cssEscape(id)}"]`);
    if (lab?.textContent) return lab.textContent.trim();
  }
  const wrapping = el.closest("label");
  if (wrapping?.textContent) return wrapping.textContent.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) return labelledBy.split(/\s+/).map((i) => el.ownerDocument.getElementById(i)?.textContent?.trim()).filter(Boolean).join(" ");
  return undefined;
}

function visibleText(el: Element): string {
  const t = (el as HTMLElement).innerText ?? el.textContent ?? "";
  return t.replace(/\s+/g, " ").trim();
}

/** Nearest provenance annotation at or above `el`, resolved against the last
 *  response of that op. */
export function resolveProvenance(el: Element): Provenance | undefined {
  const host = el.closest("[data-bug-source]");
  if (!host) return undefined;
  const op = host.getAttribute("data-bug-source")!;
  const field = host.getAttribute("data-bug-field") ?? undefined;
  const entity = host.getAttribute("data-bug-entity") ?? undefined;
  const last = findLastCall(op);
  const data = lastDataFor(op);
  let apiValue: unknown;
  let apiValueFound = false;
  if (data.found) {
    if (field) {
      const r = valueAtPath(data.data, field, entity);
      apiValueFound = r.found;
      apiValue = r.value;
    } else {
      apiValueFound = true;
      apiValue = data.data;
    }
  }
  // Whole collections can be big — a summary is enough for the report.
  if (apiValueFound) {
    const s = JSON.stringify(apiValue) ?? "";
    if (s.length > 4_000) apiValue = { truncated: true, preview: s.slice(0, 4_000) };
  }
  return {
    op,
    ...(field ? { field } : {}),
    ...(entity ? { entity } : {}),
    ...(last?.op ? { params: last.op.params } : {}),
    ...(apiValueFound ? { apiValue } : {}),
    apiValueFound,
    uiText: clip(visibleText(host), 1_900),
  };
}

export function describeElement(el: Element): ElementInfo {
  const rect = el.getBoundingClientRect();
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
  const styles: Record<string, string> = {};
  if (cs) for (const p of STYLE_PROPS) {
    const v = cs.getPropertyValue(p);
    if (v) styles[p] = v.slice(0, 400);
  }
  const isPassword = el instanceof HTMLInputElement && el.type === "password";
  const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    ? (isPassword ? "[redacted]" : el.value) : undefined;
  const componentStack = reactComponentStack(el);
  const component = el.closest("[data-bug-component]")?.getAttribute("data-bug-component") ?? componentStack[0];
  const provenance = resolveProvenance(el);

  let outerHTML = el.outerHTML;
  if (isPassword) outerHTML = outerHTML.replace(/value="[^"]*"/, 'value="[redacted]"');

  return {
    selector: clip(selectorFor(el), 1_900),
    tag: el.tagName.toLowerCase(),
    ...(el.id ? { id: el.id.slice(0, 200) } : {}),
    classes: Array.from(el.classList).slice(0, 50).map((c) => c.slice(0, 200)),
    text: clip(visibleText(el), 1_900),
    outerHTML: clip(outerHTML, 3_900),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    styles,
    a11y: {
      ...(el.getAttribute("role") ? { role: el.getAttribute("role")!.slice(0, 100) } : {}),
      ...(el.getAttribute("aria-label") ? { ariaLabel: el.getAttribute("aria-label")!.slice(0, 500) } : {}),
      ...(labelFor(el) ? { label: labelFor(el)!.slice(0, 500) } : {}),
      ...(value !== undefined ? { value: value.slice(0, 1_900) } : {}),
      ...(el.getAttribute("placeholder") ? { placeholder: el.getAttribute("placeholder")!.slice(0, 500) } : {}),
    },
    componentStack,
    ...(component ? { component: component.slice(0, 200) } : {}),
    ...(provenance ? { provenance } : {}),
  };
}

/** One-line hover label, DevTools style. */
export function shortLabel(el: Element): string {
  const r = el.getBoundingClientRect();
  const cls = Array.from(el.classList).slice(0, 2).map((c) => `.${c}`).join("");
  const comp = reactComponentStack(el)[0];
  const src = el.closest("[data-bug-source]");
  const prov = src ? ` · ${src.getAttribute("data-bug-source")}${src.getAttribute("data-bug-field") ? ` → ${src.getAttribute("data-bug-field")}` : ""}` : "";
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}  ${Math.round(r.width)}×${Math.round(r.height)}${comp ? ` · <${comp}>` : ""}${prov}`;
}
