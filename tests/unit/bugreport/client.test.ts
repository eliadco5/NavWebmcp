// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { valueAtPath, bugSource } from "@/lib/bugreport/annotate";
import { provenanceVerdict } from "@/lib/bugreport/verdict";

describe("valueAtPath", () => {
  const data = {
    count: 2,
    reservations: [
      { id: "res_1", partySize: 4, guest: { name: "Ann" } },
      { id: "res_2", partySize: 2 },
    ],
    days: [{ date: "2026-11-20", total: 10 }],
    tasks: [{ taskId: "task_9", title: "Lamp" }],
  };
  it("resolves plain keys, entity-picked array items and nested fields", () => {
    expect(valueAtPath(data, "count")).toEqual({ found: true, value: 2 });
    expect(valueAtPath(data, "reservations[].partySize", "res_2")).toEqual({ found: true, value: 2 });
    expect(valueAtPath(data, "reservations[].guest.name", "res_1")).toEqual({ found: true, value: "Ann" });
    expect(valueAtPath(data, "tasks[].title", "task_9")).toEqual({ found: true, value: "Lamp" });
    expect(valueAtPath(data, "days[].total", "2026-11-20")).toEqual({ found: true, value: 10 });
  });
  it("whole array without entity; not found for missing entity/key", () => {
    expect(valueAtPath(data, "reservations").value).toHaveLength(2);
    expect(valueAtPath(data, "reservations[].partySize", "res_404")).toEqual({ found: false });
    expect(valueAtPath(data, "nope.x")).toEqual({ found: false });
    expect(valueAtPath(null, "a")).toEqual({ found: false });
  });
  it("bugSource omits empty optional attrs", () => {
    expect(bugSource("op")).toEqual({ "data-bug-source": "op" });
    expect(bugSource("op", "a", 0)).toEqual({ "data-bug-source": "op", "data-bug-field": "a", "data-bug-entity": "0" });
  });
});

describe("provenanceVerdict", () => {
  const p = { op: "listReservations", field: "reservations[].partySize", apiValueFound: true, apiValue: 1, uiText: "1 guests" };
  it("UI matches API → data/logic issue", () => {
    expect(provenanceVerdict(p, "2")).toMatch(/data or business logic/);
  });
  it("API already returns expected → UI bug", () => {
    expect(provenanceVerdict({ ...p, apiValue: 2 }, "2")).toMatch(/UI bug/);
  });
  it("API differs from UI → display bug", () => {
    expect(provenanceVerdict({ ...p, apiValue: 3 })).toMatch(/display bug/);
  });
  it("no value found → missing on server", () => {
    expect(provenanceVerdict({ ...p, apiValueFound: false, apiValue: undefined })).toMatch(/missing/);
  });
});

describe("capture", () => {
  beforeEach(async () => {
    const g = globalThis as unknown as { __bugCapture?: unknown };
    delete g.__bugCapture;
  });

  it("records console calls and /api/call ops with redaction, skipping ignored urls", async () => {
    const responses: Record<string, unknown> = {
      "/api/call": { success: false, error: { code: "FORBIDDEN" } },
      "/api/me": { success: true, agentToken: "secret-123", user: { id: "u" } },
      "/api/audit": [],
    };
    window.fetch = vi.fn(async (url: string) => new Response(JSON.stringify(responses[url]), { status: 200 })) as unknown as typeof fetch;
    const cap = await import("@/lib/bugreport/capture");
    cap.installCapture();
    cap.installCapture(); // idempotent

    console.error("boom", { a: 1 });
    await fetch("/api/call", { method: "POST", body: JSON.stringify({ name: "issueRefund", params: { paymentId: "p1" } }) });
    await fetch("/api/me");
    await fetch("/api/audit");
    await new Promise((r) => setTimeout(r, 0));

    const logs = cap.getConsoleLog();
    expect(logs.filter((l) => l.message === 'boom {"a":1}')).toHaveLength(1);

    const net = cap.getNetworkLog();
    expect(net.map((n) => n.url)).toEqual(["/api/call", "/api/me"]);
    expect(net[0].op).toEqual({ name: "issueRefund", params: { paymentId: "p1" }, success: false, errorCode: "FORBIDDEN" });
    expect(net[1].responseBody).not.toContain("secret-123");
    expect(net[1].responseBody).toContain("[redacted]");
    expect(cap.findLastCall("issueRefund")?.status).toBe(200);
  });

  it("caps the console ring buffer", async () => {
    const cap = await import("@/lib/bugreport/capture");
    for (let i = 0; i < cap.MAX_CONSOLE + 10; i++) cap.recordConsole("log", [i]);
    const logs = cap.getConsoleLog();
    expect(logs).toHaveLength(cap.MAX_CONSOLE);
    expect(logs[logs.length - 1].message).toBe(String(cap.MAX_CONSOLE + 9));
  });

  it("safeStringify survives cycles and errors", async () => {
    const { safeStringify } = await import("@/lib/bugreport/capture");
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(safeStringify(o)).toBe('{"a":1,"self":"[Circular]"}');
    expect(safeStringify(new Error("x"))).toBe("Error: x");
  });
});

describe("describeElement", () => {
  it("captures selector, label, provenance with the API value, and redacts passwords", async () => {
    const cap = await import("@/lib/bugreport/capture");
    cap.resetCapture();
    cap.noteResponse("listReservations", { reservations: [{ id: "res_1", partySize: 1 }] });
    document.body.innerHTML = `
      <div id="root"><ul>
        <li data-bug-source="listReservations" data-bug-field="reservations[]" data-bug-entity="res_1">
          <span>Ann</span>
          <span id="ps" data-bug-source="listReservations" data-bug-field="reservations[].partySize" data-bug-entity="res_1">1 guests</span>
        </li>
      </ul>
      <label for="pw">Password</label><input id="pw" type="password" value="hunter2">
      <h2 data-bug-component="Panel.title">Wrong Titel</h2></div>`;
    const { describeElement } = await import("@/lib/bugreport/describeElement");

    const info = describeElement(document.getElementById("ps")!);
    expect(info.selector).toBe("#ps");
    expect(info.provenance).toMatchObject({ op: "listReservations", field: "reservations[].partySize", entity: "res_1", apiValue: 1, apiValueFound: true, uiText: "1 guests" });

    const nameSpan = document.querySelector("li > span")!;
    const row = describeElement(nameSpan);
    expect(row.selector).toBe("#root > ul > li > span:nth-of-type(1)");
    expect(row.provenance?.field).toBe("reservations[]");
    expect(row.provenance?.apiValue).toEqual({ id: "res_1", partySize: 1 });

    const pw = describeElement(document.getElementById("pw")!);
    expect(pw.a11y.label).toBe("Password");
    expect(pw.a11y.value).toBe("[redacted]");
    expect(pw.outerHTML).not.toContain("hunter2");

    expect(describeElement(document.querySelector("h2")!).component).toBe("Panel.title");
  });
});
