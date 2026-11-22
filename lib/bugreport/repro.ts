import type { Repro, Scenario, ScenarioStep } from "./types";

// Turns a recorded scenario into two reproductions: the ordered business calls
// (what an agent replays through invoke()) and a draft Playwright test (what a
// developer runs against the UI). Pure — runs on the server at submit time so
// MCP readers and the admin UI see the same output.

/** Read-only ops that only re-fetch what's on screen are kept: they're how the
 *  "after" state is observed, and invoke() replays them harmlessly. Shape
 *  matches invoke's batch form: invoke({ calls: toInvokeScript(steps) }). */
export function toInvokeScript(steps: ScenarioStep[]): Repro["invoke"] {
  const out: Repro["invoke"] = [];
  for (const c of steps.flatMap((s) => s.calls)) {
    const args = c.params && typeof c.params === "object" && !Array.isArray(c.params) ? c.params as Record<string, unknown> : {};
    const call = { name: c.name, args };
    // React strict mode / re-renders fire identical refetches back to back — one is enough.
    const prev = out[out.length - 1];
    if (prev && prev.name === call.name && JSON.stringify(prev.args) === JSON.stringify(call.args)) continue;
    out.push(call);
  }
  return out;
}

const q = (s: string) => JSON.stringify(s); // safe JS string literal
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function locator(step: ScenarioStep): string {
  const t = step.target!;
  // Inside an annotated row (e.g. one reservation), scope to that entity so
  // "Cancel" means this row's Cancel, not the first one on the page.
  const scope = t.provenance?.entity ? `page.locator(${q(`[data-bug-entity="${t.provenance.entity}"]`)}).first()` : "page";
  const nth = t.nth !== undefined ? `.nth(${t.nth})` : "";
  if ((step.kind === "input" || step.kind === "select") && t.label) return `${scope}.getByLabel(${q(t.label)}, { exact: true })${nth}`;
  if (t.tag === "button" || t.role === "button" || t.role === "tab") {
    const role = t.role === "tab" ? "tab" : "button";
    const name = t.text.trim();
    if (name && name.length <= 60) return `${scope}.getByRole(${q(role)}, { name: ${q(name)}, exact: true })${nth}`;
  }
  if (t.tag === "a" && t.text.trim() && t.text.length <= 60) return `${scope}.getByRole("link", { name: ${q(t.text.trim())} })`;
  return `page.locator(${q(t.selector)})`;
}

/** A hash change right after a click was caused by that click (a tab button). */
const CAUSED_MS = 1_500;

function comment(text: string): string {
  return `  // ${text.replace(/\s+/g, " ").replace(/\*\//g, "* /")}`;
}

export function toPlaywright(
  scenario: Scenario,
  opts: { expected?: string; actual?: string; description?: string } = {},
): string {
  const url = (() => {
    try { const u = new URL(scenario.startUrl); return u.pathname + u.search + u.hash; } catch { return "/"; }
  })();
  const lines: string[] = [
    `import { test, expect } from "@playwright/test";`,
    ``,
    `// Draft generated from a bug report scenario — review selectors before relying on it.`,
    ...(opts.description ? [`// Report: ${opts.description.replace(/\s+/g, " ").slice(0, 200)}`] : []),
    `test(${q(`bug scenario (${scenario.steps.length} steps)`)}, async ({ page }) => {`,
    `  await page.goto(${q(url)});`,
  ];
  scenario.steps.forEach((step, i) => {
    const prev = scenario.steps[i - 1];
    const ops = step.calls.map((c) => `${c.name}${c.success === false ? ` ✗${c.errorCode ? ` ${c.errorCode}` : ""}` : ""}`);
    lines.push(comment(`step ${step.index + 1}: ${step.kind}${step.target?.text ? ` "${step.target.text.slice(0, 60)}"` : ""}${ops.length ? ` → ${ops.join(", ")}` : ""}`));
    if (step.kind === "navigate") {
      const target = step.value?.startsWith("#") ? url.split("#")[0] + step.value : url;
      if (prev?.kind === "click" && step.tOffsetMs - prev.tOffsetMs <= CAUSED_MS) {
        lines.push(`  await expect(page).toHaveURL(new RegExp(${q(escapeRegExp(step.value ?? ""))} + "$"));`);
      } else {
        lines.push(`  await page.goto(${q(target)});`);
      }
      return;
    }
    if (!step.target) return;
    const loc = locator(step);
    // Start waiting for the step's first business call BEFORE acting, or a fast response is missed.
    const watched = step.calls.find((c) => c.success !== null)?.name;
    if (watched) lines.push(`  const res${step.index + 1} = page.waitForResponse((r) => r.url().includes("/api/call") && r.request().postData()?.includes(${q(`"name":"${watched}"`)}) === true);`);
    if (step.kind === "click") lines.push(`  await ${loc}.click();`);
    else if (step.kind === "input") lines.push(`  await ${loc}.fill(${q(step.value === "[redacted]" ? "<password>" : step.value ?? "")});`);
    else if (step.kind === "select") lines.push(`  await ${loc}.selectOption(${q(step.value ?? "")});`);
    else if (step.kind === "submit") lines.push(`  await ${loc}.evaluate((f) => (f as HTMLFormElement).requestSubmit());`);
    if (watched) lines.push(`  await res${step.index + 1};`);
  });
  if (opts.expected || opts.actual) {
    lines.push(comment(`expected: ${opts.expected ?? "?"} — actual: ${opts.actual ?? "?"}`));
    if (opts.expected) lines.push(`  // await expect(page.getByText(${q(opts.expected)})).toBeVisible();`);
  }
  lines.push(`});`, ``);
  return lines.join("\n");
}

export function buildRepro(scenario: Scenario, opts: Parameters<typeof toPlaywright>[1] = {}): Repro {
  return { invoke: toInvokeScript(scenario.steps), playwright: toPlaywright(scenario, opts) };
}
