// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NetworkEntry, Scenario, ScenarioStep } from "@/lib/bugreport/types";

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__bugCapture;
  document.body.innerHTML = `
    <div id="app">
      <label for="party">Party Size</label><input id="party" type="number">
      <label for="pw">Password</label><input id="pw" type="password">
      <select id="meth" aria-label="Method"><option value="">Any</option><option value="cash">cash</option></select>
      <form id="f"><button type="submit">Search</button></form>
      <button id="plain"><span id="inner">Check in</span></button>
      <div data-bug-reporter-ui=""><button id="stop">Stop</button></div>
    </div>`;
});

afterEach(async () => {
  const { stopScenario } = await import("@/lib/bugreport/scenario");
  stopScenario();
});

function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("scenario recorder", () => {
  it("records clicks, inputs, selects and tab changes; ignores reporter UI; redacts passwords", async () => {
    const sc = await import("@/lib/bugreport/scenario");
    sc.startScenario();
    expect(sc.isRecording()).toBe(true);

    change(document.getElementById("party") as HTMLInputElement, "4");
    change(document.getElementById("pw") as HTMLInputElement, "hunter2");
    change(document.getElementById("meth") as HTMLSelectElement, "cash");
    document.getElementById("inner")!.click(); // resolves to the enclosing button
    document.getElementById("stop")!.click(); // reporter UI — ignored
    window.location.hash = "#frontdesk";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    const out = sc.stopScenario()!;
    expect(sc.isRecording()).toBe(false);
    expect(out.steps.map((s) => [s.kind, s.value ?? s.target?.text])).toEqual([
      ["input", "4"],
      ["input", "[redacted]"],
      ["select", "cash"],
      ["click", "Check in"],
      ["navigate", "#frontdesk"],
    ]);
    expect(out.steps[0].target).toMatchObject({ selector: "#party", label: "Party Size", inputType: "number" });
    expect(out.steps[2].target?.label).toBe("Method");
    expect(out.steps[3].target).toMatchObject({ tag: "button", selector: "#plain" });
    expect(out.steps.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
    expect(out.truncated).toBe(false);
  });

  it("records nth for ambiguous labels / button names, scoped to the entity row", async () => {
    document.body.innerHTML = `
      <label for="a">Party Size</label><input id="a" type="number">
      <label for="b">Party Size</label><input id="b" type="number">
      <div data-bug-source="listReservations" data-bug-field="reservations[]" data-bug-entity="r1"><button id="c1">Cancel</button></div>
      <div data-bug-source="listReservations" data-bug-field="reservations[]" data-bug-entity="r2"><button id="c2">Cancel</button></div>
      <button id="ok">Only</button>`;
    const sc = await import("@/lib/bugreport/scenario");
    sc.startScenario();
    change(document.getElementById("b") as HTMLInputElement, "3");
    document.getElementById("c2")!.click();
    document.getElementById("ok")!.click();
    const out = sc.stopScenario()!;
    expect(out.steps[0].target?.nth).toBe(1);
    expect(out.steps[1].target?.provenance?.entity).toBe("r2");
    expect(out.steps[1].target?.nth).toBeUndefined(); // unique within its row
    expect(out.steps[2].target?.nth).toBeUndefined();

    const { toPlaywright } = await import("@/lib/bugreport/repro");
    const code = toPlaywright(out);
    expect(code).toContain('page.getByLabel("Party Size", { exact: true }).nth(1).fill("3")');
    expect(code).toContain('page.locator("[data-bug-entity=\\"r2\\"]").first().getByRole("button", { name: "Cancel", exact: true }).click()');
  });

  it("a submit-button click isn't double-recorded as a submit", async () => {
    const sc = await import("@/lib/bugreport/scenario");
    document.getElementById("f")!.addEventListener("submit", (e) => e.preventDefault());
    sc.startScenario();
    (document.querySelector("#f button") as HTMLButtonElement).click();
    const out = sc.stopScenario()!;
    expect(out.steps.map((s) => s.kind)).toEqual(["click"]);
  });

  it("caps steps and marks the scenario truncated", async () => {
    const sc = await import("@/lib/bugreport/scenario");
    sc.startScenario();
    for (let i = 0; i < sc.MAX_STEPS + 5; i++) document.getElementById("plain")!.click();
    const out = sc.stopScenario()!;
    expect(out.steps).toHaveLength(sc.MAX_STEPS);
    expect(out.truncated).toBe(true);
  });

  it("auto-stops at the duration cap", async () => {
    vi.useFakeTimers();
    try {
      const sc = await import("@/lib/bugreport/scenario");
      const onAutoStop = vi.fn();
      sc.startScenario({ onAutoStop });
      vi.advanceTimersByTime(sc.MAX_DURATION_MS + 1);
      expect(onAutoStop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("attributeCalls", () => {
  const net = (name: string, ts: number, extra: Partial<NetworkEntry> = {}): NetworkEntry => ({
    method: "POST", url: "/api/call", status: 200, durationMs: 5, ts: new Date(ts).toISOString(),
    responseBody: JSON.stringify({ success: true, data: { name } }),
    op: { name, params: { n: name }, success: true }, ...extra,
  });
  const raw = (index: number, startMs: number) => ({
    index, ts: new Date(startMs).toISOString(), tOffsetMs: startMs - 1000, startMs, kind: "click" as const,
  });

  it("assigns each call to the last step started before it, drops pre-step calls and non-op requests", async () => {
    const { attributeCalls } = await import("@/lib/bugreport/scenario");
    const steps = attributeCalls([raw(0, 1000), raw(1, 2000)], [
      net("poll", 500),
      net("a", 1100),
      net("b", 1900),
      { method: "GET", url: "/api/me", status: 200, durationMs: 1, ts: new Date(1200).toISOString() },
      net("c", 2002, { op: { name: "c", params: {}, success: false, errorCode: "FORBIDDEN" }, responseBody: '{"success":false,"error":{"code":"FORBIDDEN"}}' }),
    ]);
    expect(steps.map((s) => s.calls.map((c) => c.name))).toEqual([["a", "b"], ["c"]]);
    expect(steps[0].calls[0]).toEqual({ name: "a", params: { n: "a" }, success: true, resultPreview: '{"name":"a"}' });
    expect(steps[1].calls[0]).toMatchObject({ success: false, errorCode: "FORBIDDEN", resultPreview: '{"code":"FORBIDDEN"}' });
    expect("startMs" in steps[0]).toBe(false);
  });
});

describe("repro", () => {
  const scenario = (steps: ScenarioStep[]): Scenario => ({
    startedAt: "2026-11-22T10:00:00.000Z", durationMs: 5000, startUrl: "http://localhost:3000/?x=1#reservations", steps, truncated: false,
  });
  const step = (index: number, kind: ScenarioStep["kind"], target?: ScenarioStep["target"], value?: string, calls: ScenarioStep["calls"] = []): ScenarioStep =>
    ({ index, ts: "2026-11-22T10:00:01.000Z", tOffsetMs: 1000, kind, ...(target ? { target } : {}), ...(value !== undefined ? { value } : {}), calls });

  it("toInvokeScript flattens calls in step order, collapsing back-to-back duplicates", async () => {
    const { toInvokeScript } = await import("@/lib/bugreport/repro");
    expect(toInvokeScript([
      step(0, "click", undefined, undefined, [{ name: "a", params: { x: 1 }, success: true }, { name: "b", params: {}, success: false }]),
      step(1, "click", undefined, undefined, [{ name: "c", params: {}, success: true }, { name: "c", params: {}, success: true }, { name: "a", params: { x: 1 }, success: true }]),
    ])).toEqual([{ name: "a", args: { x: 1 } }, { name: "b", args: {} }, { name: "c", args: {} }, { name: "a", args: { x: 1 } }]);
  });

  it("toPlaywright prefers labels/roles, scopes to entity rows, falls back to selectors, escapes strings", async () => {
    const { toPlaywright } = await import("@/lib/bugreport/repro");
    const at = (index: number, kind: ScenarioStep["kind"], tOffsetMs: number, target?: ScenarioStep["target"], value?: string, calls: ScenarioStep["calls"] = []) =>
      ({ ...step(index, kind, target, value, calls), tOffsetMs });
    const code = toPlaywright(scenario([
      at(0, "input", 1000, { selector: "#party", tag: "input", text: "", label: "Party Size" }, "4"),
      at(1, "input", 2000, { selector: "#pw", tag: "input", text: "", label: "Password", inputType: "password" }, "[redacted]"),
      at(2, "select", 3000, { selector: "#m", tag: "select", text: "", label: 'Pay "method"' }, "cash"),
      at(3, "click", 4000, { selector: "form > button", tag: "button", text: "Search" }, undefined,
        [{ name: "searchAvailability", params: {}, success: true }]),
      at(4, "click", 5000, { selector: "div:nth-of-type(2) > button", tag: "button", text: "Cancel",
        provenance: { op: "listReservations", field: "reservations[]", entity: "res_9", apiValueFound: true, uiText: "" } }),
      at(5, "click", 6000, { selector: "div:nth-of-type(2) > span", tag: "span", text: "4 guests" }),
      at(6, "click", 7000, { selector: "#tab", tag: "button", role: "tab", text: "Guests" }, undefined,
        [{ name: "issueRefund", params: {}, success: false, errorCode: "FORBIDDEN" }]),
      at(7, "navigate", 7100, undefined, "#guests"),
      at(8, "navigate", 20000, undefined, "#frontdesk"),
    ]), { expected: "2 guests", actual: "4 guests", description: "Wrong party size" });

    expect(code).toContain('await page.goto("/?x=1#reservations");');
    expect(code).toContain('await page.getByLabel("Party Size", { exact: true }).fill("4");');
    expect(code).toContain('await page.getByLabel("Password", { exact: true }).fill("<password>");');
    expect(code).toContain('await page.getByLabel("Pay \\"method\\"", { exact: true }).selectOption("cash");');
    // response wait is armed before the click, awaited after
    const arm = code.indexOf("const res4 = page.waitForResponse");
    const click = code.indexOf('await page.getByRole("button", { name: "Search", exact: true }).click();');
    expect(arm).toBeGreaterThan(-1);
    expect(click).toBeGreaterThan(arm);
    expect(code.indexOf("await res4;")).toBeGreaterThan(click);
    expect(code).toContain('r.request().postData()?.includes("\\"name\\":\\"searchAvailability\\"")');
    expect(code).toContain('await page.locator("[data-bug-entity=\\"res_9\\"]").first().getByRole("button", { name: "Cancel", exact: true }).click();');
    expect(code).toContain('await page.locator("div:nth-of-type(2) > span").click();');
    expect(code).toContain('await page.getByRole("tab", { name: "Guests", exact: true }).click();');
    // a hash change right after a tab click is asserted, not re-navigated
    expect(code).toContain('await expect(page).toHaveURL(new RegExp("#guests" + "$"));');
    expect(code).toContain('await page.goto("/?x=1#frontdesk");');
    expect(code).toContain("issueRefund ✗ FORBIDDEN");
    expect(code).toContain("// expected: 2 guests — actual: 4 guests");
  });

  it("escapeRegExp-safe hash values", async () => {
    const { toPlaywright } = await import("@/lib/bugreport/repro");
    const code = toPlaywright(scenario([
      step(0, "click", { selector: "#t", tag: "button", role: "tab", text: "X" }),
      { ...step(1, "navigate", undefined, "#a.b(c)"), tOffsetMs: 1200 },
    ]));
    // generated source: new RegExp("#a\\.b\\(c\\)" + "$")
    expect(code).toContain('new RegExp("#a\\\\.b\\\\(c\\\\)" + "$")');
  });
});
