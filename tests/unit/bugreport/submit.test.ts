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

describe("submitBugReport", () => {
  it("stores a valid report with server-assigned id, reporter, status and replayable calls", async () => {
    const r = await submit({ ...BUG_REPORT_FIXTURE, id: "bug_evil", reporter: { userId: "u_bob", role: "admin", displayName: "x" }, status: "fixed" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.id).toMatch(/^bug_/);
    expect(r.report.id).not.toBe("bug_evil");
    expect(r.report.reporter).toEqual({ userId: "u_alice", role: "customer", displayName: "Alice" });
    expect(r.report.status).toBe("open");
    expect(r.report.calls).toEqual([{ name: "listReservations", params: {}, success: true }]);
    expect(r.report.sinks).toEqual([{ sink: "store", ok: true, ref: r.report.id }]);

    const { bugReports } = await import("@/lib/bugreports");
    expect(bugReports()[0].id).toBe(r.report.id);
  });

  it("rejects invalid JSON, schema violations and oversized bodies", async () => {
    expect(await submit("{nope")).toMatchObject({ ok: false, status: 400, code: "INVALID_INPUT" });
    expect(await submit({ ...BUG_REPORT_FIXTURE, description: "" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await submit({ ...BUG_REPORT_FIXTURE, category: "rant" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await submit({ ...BUG_REPORT_FIXTURE, screenshot: "javascript:alert(1)" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await submit("x".repeat(1_600_000))).toMatchObject({ ok: false, status: 413, code: "TOO_LARGE" });
  });

  it("caps the store at MAX_BUG_REPORTS, newest first", async () => {
    const { MAX_BUG_REPORTS, bugReports } = await import("@/lib/bugreports");
    let last = "";
    for (let i = 0; i < MAX_BUG_REPORTS + 3; i++) {
      const r = await submit({ ...BUG_REPORT_FIXTURE, screenshot: undefined });
      if (r.ok) last = r.report.id;
    }
    expect(bugReports()).toHaveLength(MAX_BUG_REPORTS);
    expect(bugReports()[0].id).toBe(last);
  });

  it("a failing sink is recorded but doesn't fail the submit or block later sinks", async () => {
    const { storeSink } = await import("@/lib/bugreport/sinks/store");
    const boom = { name: "boom", enabled: () => true, send: async () => { throw new Error("down"); } };
    const off = { name: "off", enabled: () => false, send: async () => ({}) };
    const r = await submit(BUG_REPORT_FIXTURE, [boom, off, storeSink]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.sinks).toEqual([
      { sink: "boom", ok: false, error: "down" },
      { sink: "store", ok: true, ref: r.report.id },
    ]);
  });
});

describe("Jira sink", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("is disabled without config", async () => {
    vi.stubEnv("JIRA_BASE_URL", "");
    const { jiraSink } = await import("@/lib/bugreport/sinks/jira");
    expect(jiraSink.enabled()).toBe(false);
  });

  it("creates an issue, attaches bundle + screenshot, and returns the key", async () => {
    vi.stubEnv("JIRA_BASE_URL", "https://acme.atlassian.net/");
    vi.stubEnv("JIRA_EMAIL", "bot@acme.dev");
    vi.stubEnv("JIRA_API_TOKEN", "t0k");
    vi.stubEnv("JIRA_PROJECT_KEY", "WEB");
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/issue")) return new Response(JSON.stringify({ key: "WEB-7" }), { status: 201 });
      return new Response("[]", { status: 200 });
    }));

    const r = await submit();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.sinks.find((s) => s.sink === "jira")).toEqual({ sink: "jira", ok: true, ref: "WEB-7", url: "https://acme.atlassian.net/browse/WEB-7" });

    expect(calls[0].url).toBe("https://acme.atlassian.net/rest/api/3/issue");
    const auth = (calls[0].init.headers as Record<string, string>).Authorization;
    expect(auth).toBe("Basic " + Buffer.from("bot@acme.dev:t0k").toString("base64"));
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.fields.project.key).toBe("WEB");
    expect(body.fields.summary).toBe("[Wrong value] Party size should be 2, not 4");
    expect(JSON.stringify(body.fields.description)).toContain("listReservations → reservations[].partySize");

    expect(calls[1].url).toBe("https://acme.atlassian.net/rest/api/3/issue/WEB-7/attachments");
    const form = calls[1].init.body as FormData;
    expect(form.getAll("file")).toHaveLength(2);
  });

  it("a Jira error surfaces as a failed sink, the report is still stored", async () => {
    vi.stubEnv("JIRA_BASE_URL", "https://acme.atlassian.net");
    vi.stubEnv("JIRA_EMAIL", "a");
    vi.stubEnv("JIRA_API_TOKEN", "b");
    vi.stubEnv("JIRA_PROJECT_KEY", "WEB");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const r = await submit();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.sinks.find((s) => s.sink === "jira")).toMatchObject({ ok: false, error: expect.stringContaining("401") });
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

  it("list → get (without screenshot) → update status", async () => {
    const { get } = await ops();
    const r = await submit();
    if (!r.ok) throw new Error(r.message);

    const list = await get("listBugReports").handler({}, adminCtx);
    expect(list.success && list.data.reports[0]).toMatchObject({ id: r.report.id, op: "listReservations", field: "reservations[].partySize", status: "open" });

    const detail = await get("getBugReport").handler({ id: r.report.id }, adminCtx);
    expect(detail.success).toBe(true);
    if (!detail.success) return;
    expect(detail.data.report.hasScreenshot).toBe(true);
    expect("screenshot" in detail.data.report).toBe(false);
    expect(detail.data.report.calls).toHaveLength(1);

    await get("updateBugReportStatus").handler({ id: r.report.id, status: "fixed" }, adminCtx);
    const open = await get("listBugReports").handler({ status: "open" }, adminCtx);
    expect(open.success && open.data.count).toBe(0);

    expect(await get("getBugReport").handler({ id: "bug_nope" }, adminCtx)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  it("round-trips through the shared-state descriptor", async () => {
    await submit();
    const { ALL_DESCRIPTORS } = await import("@/lib/shared-state/registry");
    const { bugReports } = await import("@/lib/bugreports");
    const d = ALL_DESCRIPTORS.find((x) => x.key === "bugReports")!;
    const before = bugReports();
    const snap = JSON.parse(JSON.stringify(d.snapshot()));
    d.restore([]);
    expect(bugReports()).toHaveLength(0);
    d.restore(snap);
    expect(bugReports()).toBe(before);
    expect(bugReports()).toHaveLength(1);
  });
});
