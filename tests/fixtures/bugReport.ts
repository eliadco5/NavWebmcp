// A realistic browser-side bundle, as BugReportDialog would POST it.
export const BUG_REPORT_FIXTURE = {
  category: "wrong-value",
  description: "Party size should be 2, not 4",
  expected: "2",
  actual: "4 guests",
  page: { url: "http://localhost:3000/#reservations", tab: "reservations", viewport: { width: 1280, height: 800 }, userAgent: "vitest", storeVersion: 3 },
  element: {
    selector: "div:nth-of-type(2) > span:nth-of-type(3)",
    tag: "span",
    classes: [],
    text: "4 guests",
    outerHTML: '<span data-bug-source="listReservations">4 guests</span>',
    rect: { x: 10, y: 20, width: 60, height: 16 },
    styles: { color: "rgb(107, 114, 128)" },
    a11y: {},
    componentStack: ["ReservationList", "ReservationsPanel", "AppShell"],
    component: "ReservationList",
    provenance: {
      op: "listReservations",
      field: "reservations[].partySize",
      entity: "res_001",
      params: {},
      apiValue: 4,
      apiValueFound: true,
      uiText: "4 guests",
    },
  },
  console: [
    { level: "error", ts: "2026-11-22T10:00:00.000Z", message: "Something broke" },
  ],
  network: [
    {
      method: "POST", url: "/api/call", status: 200, durationMs: 12, ts: "2026-11-22T10:00:00.000Z",
      requestBody: '{"name":"listReservations","params":{}}',
      responseBody: '{"success":true,"data":{"reservations":[]}}',
      op: { name: "listReservations", params: {}, success: true },
    },
    { method: "GET", url: "/api/me", status: 200, durationMs: 5, ts: "2026-11-22T09:59:59.000Z", responseBody: "{}" },
  ],
  recentAudit: [{ timestamp: "2026-11-22T10:00:00.000Z", operation: "listReservations", success: true, source: "ui", input: {} }],
  scenario: {
    startedAt: "2026-11-22T09:59:50.000Z",
    durationMs: 12_000,
    startUrl: "http://localhost:3000/#reservations",
    truncated: false,
    steps: [
      {
        index: 0, ts: "2026-11-22T09:59:52.000Z", tOffsetMs: 2_000, kind: "input", value: "4",
        target: { selector: "#party", tag: "input", text: "", label: "Party Size", inputType: "number" },
        calls: [],
      },
      {
        index: 1, ts: "2026-11-22T09:59:54.000Z", tOffsetMs: 4_000, kind: "click",
        target: { selector: "form > button", tag: "button", text: "Search" },
        calls: [{ name: "searchAvailability", params: { date: "2026-11-23", partySize: 4 }, success: true, resultPreview: '{"slots":[]}' }],
      },
      {
        index: 2, ts: "2026-11-22T09:59:58.000Z", tOffsetMs: 8_000, kind: "navigate", value: "#frontdesk",
        calls: [{ name: "issueRefund", params: { paymentId: "pay_001" }, success: false, errorCode: "FORBIDDEN" }],
      },
    ],
  },
  screenshot: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
};
