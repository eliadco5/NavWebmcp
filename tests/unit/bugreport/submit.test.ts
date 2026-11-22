// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import { adminCtx, supportCtx, customerCtx } from "@/tests/helpers";
import { BUG_REPORT_FIXTURE } from "@/tests/fixtures/bugReport";

const alice = { id: "u_alice", role: "customer", displayName: "Alice" };

async function submit(body: unknown = BUG_REPORT_FIXTURE, sinks?: unknown[]) {
  const { submitBugReport } = await import("@/lib/bugreport/submit");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return submitBugReport(alice, typeof body === "string" ? body : JSON.stringify(body), sinks as any);
}

async function submitOk(body: unknown = BUG_REPORT_FIXTURE, sinks?: unknown[]) {
  const r = await submit(body, sinks);
  if (!r.ok) throw new Error(r.message);
  return r;
}

describe("submitBugReport", () => {
  it("stores a valid report with server-assigned id, reporter, status and replayable calls", async () => {
    const r = await submitOk({ ...BUG_REPORT_FIXTURE, id: "bug_evil", reporter: { userId: "u_bob", role: "admin", displayName: "x" }, status: "fixed", finalized: true });
    expect(r.report.id).toMatch(/^bug_/);
    expect(r.report.id).not.toBe("bug_evil");
    expect(r.report.reporter).toEqual({ userId: "u_alice", role: "customer", displayName: "Alice" });
    expect(r.report.status).toBe("open");
    expect(r.report.finalized).toBe(false);
    expect(r.report.calls).toEqual([{ name: "listReservations", params: {}, success: true }]);
    expect(r.report.sinks).toEqual([{ sink: "store", ok: true, ref: r.report.id }]);
    expect(r.uploadToken).toBeTruthy();

    const { bugReports } = await import("@/lib/bugreports");
    expect(bugReports()[0].id).toBe(r.report.id);
  });

  it("moves an inline screenshot into attachments and out of the stored report", async () => {
    const r = await submitOk();
    expect(r.report.screenshot).toBeUndefined();
    expect(r.report.attachments).toEqual([{ kind: "screenshot", mime: "image/jpeg", bytes: expect.any(Number) }]);
    const { getAttachment } = await import("@/lib/bugreport/attachments");
    expect((await getAttachment(r.report.id, "screenshot"))?.mime).toBe("image/jpeg");
  });

  it("builds repro scripts from a scenario", async () => {
    const r = await submitOk();
    expect(r.report.repro?.invoke).toEqual([
      { name: "searchAvailability", args: { date: "2026-11-23", partySize: 4 } },
      { name: "issueRefund", args: { paymentId: "pay_001" } },
    ]);
    expect(r.report.repro?.playwright).toContain('page.getByLabel("Party Size", { exact: true }).fill("4")');
    const { repro: _r, ...noScenario } = { ...BUG_REPORT_FIXTURE, scenario: undefined, repro: 1 };
    expect((await submitOk(noScenario)).report.repro).toBeUndefined();
  });

  it("rejects invalid JSON, schema violations and oversized bodies", async () => {
    expect(await submit("{nope")).toMatchObject({ ok: false, status: 400, code: "INVALID_INPUT" });
    expect(await submit({ ...BUG_REPORT_FIXTURE, description: "" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await submit({ ...BUG_REPORT_FIXTURE, category: "rant" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await submit({ ...BUG_REPORT_FIXTURE, screenshot: "javascript:alert(1)" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await submit({ ...BUG_REPORT_FIXTURE, scenario: { ...BUG_REPORT_FIXTURE.scenario, steps: [{ kind: "teleport" }] } })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await submit("x".repeat(1_600_000))).toMatchObject({ ok: false, status: 413, code: "TOO_LARGE" });
  });

  it("caps the store at MAX_BUG_REPORTS, newest first, and drops evicted attachments", async () => {
    const { MAX_BUG_REPORTS, bugReports } = await import("@/lib/bugreports");
    const { getAttachment } = await import("@/lib/bugreport/attachments");
    const first = await submitOk();
    let last = "";
    for (let i = 0; i < MAX_BUG_REPORTS + 2; i++) last = (await submitOk({ ...BUG_REPORT_FIXTURE, screenshot: undefined })).report.id;
    expect(bugReports()).toHaveLength(MAX_BUG_REPORTS);
    expect(bugReports()[0].id).toBe(last);
    expect(await getAttachment(first.report.id, "screenshot")).toBeNull();
  });

  it("a failing sink is recorded but doesn't fail the submit or block later sinks", async () => {
    const { storeSink } = await import("@/lib/bugreport/sinks/store");
    const boom = { name: "boom", phase: "submit", enabled: () => true, send: async () => { throw new Error("down"); } };
    const off = { name: "off", phase: "submit", enabled: () => false, send: async () => ({}) };
    const later = { name: "later", phase: "finalize", enabled: () => true, send: async () => ({ ref: "x" }) };
    const r = await submitOk(BUG_REPORT_FIXTURE, [boom, off, later, storeSink]);
    expect(r.report.sinks).toEqual([
      { sink: "boom", ok: false, error: "down" },
      { sink: "store", ok: true, ref: r.report.id },
    ]);
  });
});

describe("attachments + finalize", () => {
  const png = (n: number) => Buffer.alloc(n, 1);

  it("accepts a valid upload with the report's token and records it", async () => {
    const { addAttachment } = await import("@/lib/bugreport/submit");
    const { findBugReport } = await import("@/lib/bugreports");
    const r = await submitOk();
    expect(await addAttachment(r.report.id, "before", r.uploadToken, "image/png", png(100))).toEqual({ ok: true, bytes: 100 });
    expect(await addAttachment(r.report.id, "replay", r.uploadToken, "application/gzip", png(50))).toEqual({ ok: true, bytes: 50 });
    expect(await addAttachment(r.report.id, "video", r.uploadToken, "video/webm;codecs=vp9", png(70))).toEqual({ ok: true, bytes: 70 });
    // re-upload replaces, doesn't duplicate
    await addAttachment(r.report.id, "before", r.uploadToken, "image/png", png(120));
    expect(findBugReport(r.report.id)!.attachments.map((a) => `${a.kind}:${a.bytes}`).sort())
      .toEqual(["before:120", "replay:50", "screenshot:" + r.report.attachments[0].bytes, "video:70"].sort());
  });

  it("rejects wrong/expired tokens, bad kinds, types and sizes", async () => {
    const { addAttachment } = await import("@/lib/bugreport/submit");
    const { signUploadToken } = await import("@/lib/auth-tokens");
    const a = await submitOk();
    const b = await submitOk();
    expect(await addAttachment(a.report.id, "before", null, "image/png", png(10))).toMatchObject({ ok: false, status: 403 });
    expect(await addAttachment(a.report.id, "before", b.uploadToken, "image/png", png(10))).toMatchObject({ ok: false, status: 403 });
    const expired = signUploadToken(a.report.id, Date.now() - 11 * 60 * 1000);
    expect(await addAttachment(a.report.id, "before", expired, "image/png", png(10))).toMatchObject({ ok: false, status: 403 });
    expect(await addAttachment(a.report.id, "exe", a.uploadToken, "image/png", png(10))).toMatchObject({ ok: false, status: 400 });
    expect(await addAttachment(a.report.id, "before", a.uploadToken, "text/html", png(10))).toMatchObject({ ok: false, status: 415 });
    expect(await addAttachment(a.report.id, "before", a.uploadToken, "image/png", png(1_000_001))).toMatchObject({ ok: false, status: 413 });
    expect(await addAttachment(a.report.id, "video", a.uploadToken, "video/webm", png(4_000_001))).toMatchObject({ ok: false, status: 413 });
  });

  it("finalize runs finalize-phase sinks once, then blocks further uploads", async () => {
    const { finalizeBugReport, addAttachment } = await import("@/lib/bugreport/submit");
    const send = vi.fn(async () => ({ ref: "J-1" }));
    const sink = { name: "j", phase: "finalize" as const, enabled: () => true, send };
    const r = await submitOk();
    const f1 = await finalizeBugReport(r.report.id, r.uploadToken, [sink]);
    const f2 = await finalizeBugReport(r.report.id, r.uploadToken, [sink]);
    expect(f1.ok && f2.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f2.ok && f2.report.sinks.map((s) => s.sink)).toEqual(["store", "j"]);
    expect(await addAttachment(r.report.id, "after", r.uploadToken, "image/png", png(5))).toMatchObject({ ok: false, status: 409 });
    expect(await finalizeBugReport(r.report.id, "bogus", [sink])).toMatchObject({ ok: false, status: 403 });
  });

  it("in-memory store evicts oldest past the total cap", async () => {
    const { putAttachment, getAttachment, MEMORY_CAP_BYTES } = await import("@/lib/bugreport/attachments");
    const big = Math.ceil(MEMORY_CAP_BYTES / 3) + 1;
    for (const id of ["a", "b", "c"]) await putAttachment(id, "video", { mime: "video/webm", data: Buffer.alloc(big) });
    expect(await getAttachment("a", "video")).toBeNull();
    expect(await getAttachment("c", "video")).not.toBeNull();
  });
});

describe("Jira sink", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubJiraEnv() {
    vi.stubEnv("JIRA_BASE_URL", "https://acme.atlassian.net/");
    vi.stubEnv("JIRA_EMAIL", "bot@acme.dev");
    vi.stubEnv("JIRA_API_TOKEN", "t0k");
    vi.stubEnv("JIRA_PROJECT_KEY", "WEB");
  }

  it("is disabled without config", async () => {
    vi.stubEnv("JIRA_BASE_URL", "");
    const { jiraSink } = await import("@/lib/bugreport/sinks/jira");
    expect(jiraSink.enabled()).toBe(false);
  });

  it("runs at finalize: creates an issue with the steps, attaches bundle + repro + every attachment", async () => {
    stubJiraEnv();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/issue")) return new Response(JSON.stringify({ key: "WEB-7" }), { status: 201 });
      return new Response("[]", { status: 200 });
    }));
    const { addAttachment, finalizeBugReport } = await import("@/lib/bugreport/submit");

    const r = await submitOk();
    expect(calls).toHaveLength(0); // nothing sent to Jira before finalize
    await addAttachment(r.report.id, "replay", r.uploadToken, "application/gzip", Buffer.from("gz"));
    const f = await finalizeBugReport(r.report.id, r.uploadToken);
    expect(f.ok && f.report.sinks.find((s) => s.sink === "jira")).toEqual({ sink: "jira", ok: true, ref: "WEB-7", url: "https://acme.atlassian.net/browse/WEB-7" });

    expect(calls[0].url).toBe("https://acme.atlassian.net/rest/api/3/issue");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Basic " + Buffer.from("bot@acme.dev:t0k").toString("base64"));
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.fields.project.key).toBe("WEB");
    expect(body.fields.summary).toBe("[Wrong value] Party size should be 2, not 4");
    const desc = JSON.stringify(body.fields.description);
    expect(desc).toContain("listReservations → reservations[].partySize");
    expect(desc).toContain("Scenario (3 steps");
    expect(desc).toContain("issueRefund ✗");

    expect(calls[1].url).toBe("https://acme.atlassian.net/rest/api/3/issue/WEB-7/attachments");
    const names = (calls[1].init.body as FormData).getAll("file").map((f) => (f as File).name);
    expect(names).toEqual([
      `bug-report-${r.report.id}.json`, `repro-${r.report.id}.spec.ts`,
      `screenshot-${r.report.id}.jpg`, `replay-${r.report.id}.json.gz`,
    ]);
  });

  it("a Jira error surfaces as a failed sink, the report is still stored", async () => {
    stubJiraEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const { finalizeBugReport } = await import("@/lib/bugreport/submit");
    const r = await submitOk();
    const f = await finalizeBugReport(r.report.id, r.uploadToken);
    expect(f.ok && f.report.sinks.find((s) => s.sink === "jira")).toMatchObject({ ok: false, error: expect.stringContaining("401") });
    const { findBugReport } = await import("@/lib/bugreports");
    expect(findBugReport(r.report.id)).toBeDefined();
  });
});

describe("support.bugs ops", () => {
  async function ops() {
    await import("@/lib/operations/index");
    const { registry } = await import("@/lib/operations/registry");
    const { roleSatisfies } = await import("@/lib/auth");
    const get = (n: string) => registry.find((o) => o.name === n)!;
    return { get, roleSatisfies };
  }

  it("are admin-only", async () => {
    const { get, roleSatisfies } = await ops();
    for (const name of ["listBugReports", "getBugReport", "updateBugReportStatus"]) {
      expect(roleSatisfies(adminCtx.role, get(name).roles), name).toBe(true);
      expect(roleSatisfies(supportCtx.role, get(name).roles), name).toBe(false);
      expect(roleSatisfies(customerCtx.role, get(name).roles), name).toBe(false);
    }
  });

  it("list → get (with scenario + repro, no blobs) → update status", async () => {
    const { get } = await ops();
    const r = await submitOk();

    const list = await get("listBugReports").handler({}, adminCtx);
    expect(list.success && list.data.reports[0]).toMatchObject({ id: r.report.id, op: "listReservations", field: "reservations[].partySize", status: "open" });

    const detail = await get("getBugReport").handler({ id: r.report.id }, adminCtx);
    expect(detail.success).toBe(true);
    if (!detail.success) return;
    expect(detail.data.report.hasScreenshot).toBe(true);
    expect("screenshot" in detail.data.report).toBe(false);
    expect(detail.data.report.scenario.steps).toHaveLength(3);
    expect(detail.data.report.repro.invoke).toHaveLength(2);

    await get("updateBugReportStatus").handler({ id: r.report.id, status: "fixed" }, adminCtx);
    const open = await get("listBugReports").handler({ status: "open" }, adminCtx);
    expect(open.success && open.data.count).toBe(0);

    expect(await get("getBugReport").handler({ id: "bug_nope" }, adminCtx)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  it("repro.invoke is accepted as-is by invoke({ calls }) and replays each call", async () => {
    const { get } = await ops();
    const { inputObject } = await import("@/lib/schema");
    const r = await submitOk();
    const invoke = get("invoke");
    const input = inputObject(invoke.inputSchema).parse({ calls: r.report.repro!.invoke });
    const out = await invoke.handler(input, customerCtx);
    expect(out.success).toBe(true);
    if (!out.success) return;
    const results = (out.data as { results: { success: boolean; error?: { code: string } }[] }).results;
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true); // searchAvailability
    expect(results[1]).toMatchObject({ success: false, error: { code: "FORBIDDEN" } }); // issueRefund as customer — same as the user saw
  });

  it("round-trips through the shared-state descriptor, without attachment bytes", async () => {
    await submitOk();
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    const { bugReports } = await import("@/lib/bugreports");
    const d = ALL_DESCRIPTORS.find((x) => x.key === "bugReports")!;
    const before = bugReports();
    const json = JSON.stringify(d.snapshot());
    expect(json).not.toContain("base64");
    const snap = JSON.parse(json);
    d.restore([]);
    expect(bugReports()).toHaveLength(0);
    d.restore(snap);
    expect(bugReports()).toBe(before);
    expect(bugReports()).toHaveLength(1);
  });
});
