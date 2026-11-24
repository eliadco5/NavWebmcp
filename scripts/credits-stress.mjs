#!/usr/bin/env node
// "Mad Max" stress, negative and end-to-end test of NavWebMcp credits against
// REAL running servers (next start), over real HTTP. If credits break, every
// call is refused and the app is unreachable — so this drives every surface
// as hard and as badly as it can and checks the app stays up for everyone.
//
//   node scripts/credits-stress.mjs --base=http://localhost:3201 [--base2=http://localhost:3202]
//        [--quick] [--out=docs/credits-stress-results.json] [--only=S3,S4]
//        [--redis-container=<name>]   # enables the Redis outage/hang scenarios (docker stop/pause)
//
// Exit code 0 = every check passed. Results (checks + latency stats) are
// written as JSON for docs/credits-test-report.md.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const BASE = args.base ?? "http://localhost:3201";
const BASE2 = args.base2 ?? null;
const QUICK = Boolean(args.quick);
const ONLY = args.only ? new Set(String(args.only).split(",")) : null;
const REDIS_CONTAINER = args["redis-container"] ?? null;
const OUT = args.out ?? null;

// ── Tiny framework ───────────────────────────────────────────────────────────

const results = { startedAt: new Date().toISOString(), base: BASE, base2: BASE2, scenarios: [] };
let current;
function scenario(id, title) {
  current = { id, title, checks: [], metrics: {} };
  results.scenarios.push(current);
  console.log(`\n▶ ${id} ${title}`);
}
function check(name, ok, detail = "") {
  current.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  console.log(`  ${ok ? "✔" : "✘"} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
}
function metric(name, value) {
  current.metrics[name] = value;
  console.log(`    · ${name}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(ms) {
  if (!ms.length) return { n: 0 };
  const s = [...ms].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), p99: Math.round(q(0.99)), max: Math.round(s[s.length - 1]) };
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function http(url, init = {}, timeoutMs = 30_000) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, ms: performance.now() - t0 };
  } catch (err) {
    return { status: 0, headers: new Headers(), text: String(err?.cause?.code ?? err?.name ?? err), ms: performance.now() - t0, error: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Send raw bytes over TCP and return the response status (0 if none before the timeout). */
async function rawHttp(base, request, timeoutMs = 5000) {
  const { connect } = await import("node:net");
  const u = new URL(base);
  return new Promise((resolve) => {
    const sock = connect(Number(u.port || 80), u.hostname);
    let buf = "";
    const done = (s) => { sock.destroy(); resolve(s); };
    const timer = setTimeout(() => done(0), timeoutMs);
    sock.on("connect", () => sock.write(request));
    sock.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/^HTTP\/1\.[01] (\d{3})/);
      if (m) { clearTimeout(timer); done(Number(m[1])); }
    });
    sock.on("error", () => { clearTimeout(timer); done(0); });
  });
}

async function login(user, base = BASE, ip) {
  const r = await http(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip && { "x-forwarded-for": ip }) },
    body: JSON.stringify({ username: user, password: "password" }),
  });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  let body = {};
  try { body = JSON.parse(r.text); } catch { /* */ }
  return { cookie, token: body.agentToken, status: r.status };
}

async function newAgent(cookie, label, base = BASE) {
  const r = await http(`${base}/api/agent-clients`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ label }) });
  const b = JSON.parse(r.text);
  return { token: b.agentToken, clientId: b.clientId };
}

let rpcId = 0;
/** One MCP tools/call over raw Streamable HTTP (stateless), so calls really run in parallel. */
async function mcp(token, name, argsIn = {}, { base = BASE, meta, timeoutMs = 30_000, rawBody } = {}) {
  const body = rawBody ?? JSON.stringify({
    jsonrpc: "2.0", id: ++rpcId, method: "tools/call",
    params: { name, arguments: argsIn, ...(meta && { _meta: meta }) },
  });
  const r = await http(`${base}/api/mcp`, {
    method: "POST",
    headers: { ...(token && { authorization: `Bearer ${token}` }), "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
  }, timeoutMs);
  let msg = null;
  const line = r.text.split("\n").find((l) => l.startsWith("data: "));
  try { msg = JSON.parse(line ? line.slice(6) : r.text); } catch { /* */ }
  const result = msg?.result;
  let code = null;
  if (result?.isError) {
    try { code = JSON.parse(result.content[0].text).code; } catch { code = "ERROR"; }
  } else if (msg?.error) code = `RPC_${msg.error.code}`;
  return {
    status: r.status, ms: r.ms, error: r.error, errText: r.error ? r.text : undefined, msg, result,
    ok: r.status === 200 && result && !result.isError,
    code, credits: result?._meta?.["navwebmcp/credits"],
    hintBlock: result?.content?.find?.((c) => c.text?.startsWith("[credits]"))?.text,
  };
}

/** An agent that does what the hint says: on INSUFFICIENT_CREDITS it waits retryAfterMs and tries again. */
async function politeCall(token, name, argsIn = {}, opts = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await mcp(token, name, argsIn, opts);
    if (r.code !== "INSUFFICIENT_CREDITS") return { ...r, attempts: attempt + 1 };
    await sleep(Math.min(5000, r.credits?.retryAfterMs ?? 1000));
  }
  return { ok: false, code: "GAVE_UP", ms: 0, status: 200, attempts: 8 };
}

async function call(cookie, name, params = {}, { base = BASE, agent = false, headers = {}, rawBody, timeoutMs } = {}) {
  const r = await http(`${base}/api/call`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", ...(agent && { "x-navwebmcp-channel": "webmcp" }), ...headers },
    body: rawBody ?? JSON.stringify({ name, params }),
  }, timeoutMs);
  let body = null;
  try { body = JSON.parse(r.text); } catch { /* */ }
  return { ...r, body, ok: r.status === 200 && body?.success === true };
}

async function admin(cookie, payload, base = BASE) {
  return http(`${base}/api/admin/credits`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(payload) });
}

/** Run `fn` with `concurrency` workers until `durationMs` passes; collect each result. */
async function load(fn, { concurrency, durationMs, count }) {
  const out = [];
  const end = Date.now() + (durationMs ?? 1e12);
  let issued = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (Date.now() < end && (count === undefined || issued < count)) {
      issued++;
      out.push(await fn(issued));
    }
  }));
  return out;
}

async function alive(base = BASE) {
  const r = await http(`${base}/login`, {}, 10_000);
  return r.status === 200;
}

const isFiveXX = (r) => r.status >= 500 || r.status === 0;

function should(id) {
  return !ONLY || ONLY.has(id);
}

// A fake open tab with one component, so ui_* calls over MCP are relayed to a
// page that never answers: a genuinely long call (the relay waits 8 s).
async function publishSilentTab(cookie, base = BASE) {
  return http(`${base}/api/ui/snapshot`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      tabId: `stress-${Date.now()}`, activeTab: "reservations", visible: true, focusedAt: Date.now(),
      components: [{
        id: "stress.table", kind: "table", title: "Stress", stateSchema: { type: "object" },
        state: { filters: {}, sort: [] }, version: 1, actions: [{ name: "refresh", description: "r" }],
      }],
    }),
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────────

async function main() {
  check0: {
    if (!(await alive())) {
      console.error(`Server at ${BASE} is not reachable.`);
      process.exit(2);
    }
  }
  const bob = await login("bob");      // admin
  const alice = await login("alice");  // customer
  const carol = await login("carol");  // support

  if (should("S1")) {
    scenario("S1", "Smoke: every surface carries credits");
    const a = await newAgent(alice.cookie, "s1");
    const r = await mcp(a.token, "explore");
    check("MCP call succeeds", r.ok, r.code);
    check("MCP _meta carries credits", r.credits && r.credits.charged === 2 && r.credits.granted === 2, JSON.stringify(r.credits));
    check("no [credits] block in steady state", !r.hintBlock);
    const s = await mcp(a.token, "search", { pattern: "book" });
    const fn = s.result?.structuredContent?.functions?.find((f) => f.name === "book");
    check("search shows each function's cost", fn?.credits === 5, JSON.stringify(fn?.credits));
    const h = await call(alice.cookie, "explore", {}, { agent: true });
    check("/api/call (in-page agent) succeeds with credit headers", h.ok && h.headers.get("x-navwebmcp-credits-charged") === "2", `${h.status} ${h.headers.get("x-navwebmcp-credits-charged")}`);
    const u = await call(alice.cookie, "explore", {});
    check("/api/call (human UI) metered on the loose profile", u.ok && Number(u.headers.get("x-navwebmcp-credits-window")) >= 128, u.headers.get("x-navwebmcp-credits-window"));
    const ctx = await mcp(a.token, "getContext");
    check("getContext returns the snapshot", ctx.result?.structuredContent?.credits?.window >= 16, JSON.stringify(ctx.result?.structuredContent?.credits));
  }

  if (should("S2")) {
    scenario("S2", "Negative: auth, malformed input, hostile credit requests, oversize bodies");
    const a = await newAgent(alice.cookie, "s2");
    const noAuth = await mcp(null, "explore");
    check("MCP without a token → 401", noAuth.status === 401, noAuth.status);
    const forged = await mcp("ab1.forged.token", "explore");
    check("MCP with a forged token → 401", forged.status === 401, forged.status);
    const garbage = await mcp(a.token, null, {}, { rawBody: "{not json" });
    check("MCP garbage JSON → no 5xx", !isFiveXX(garbage), garbage.status);
    for (const [label, meta] of [
      ["negative", { "navwebmcp/credits": { request: -50 } }],
      ["string", { "navwebmcp/credits": { request: "lots" } }],
      ["huge", { "navwebmcp/credits": { request: 1e15 } }],
      ["object", { "navwebmcp/credits": { request: { $gt: 1 } } }],
      ["null meta", { "navwebmcp/credits": null }],
    ]) {
      const r = await mcp(a.token, "explore", {}, { meta });
      check(`CreditRequest ${label}: call succeeds, grant stays within the window`, r.ok && r.credits && r.credits.balance <= r.credits.window, JSON.stringify(r.credits));
    }
    for (const v of ["-1", "abc", "1e309", "", "  "]) {
      const r = await call(alice.cookie, "explore", {}, { agent: true, headers: { "x-navwebmcp-credit-request": v } });
      check(`HTTP credit-request header ${JSON.stringify(v)}: OK and bounded`, r.ok && Number(r.headers.get("x-navwebmcp-credits-balance")) <= Number(r.headers.get("x-navwebmcp-credits-window")), r.status);
    }
    const badJson = await call(alice.cookie, null, {}, { rawBody: "{oops" });
    check("/api/call malformed JSON → 400", badJson.status === 400, badJson.status);
    const notObj = await call(alice.cookie, null, {}, { rawBody: "[1,2,3]" });
    check("/api/call JSON array body → handled, no 5xx", !isFiveXX(notObj), notObj.status);
    const big = "x".repeat(70 * 1024);
    const over = await call(alice.cookie, "explore", { path: big });
    check("/api/call body over 64 KB → 413", over.status === 413, over.status);
    const overMcp = await mcp(a.token, "explore", { path: big });
    check("MCP body over 64 KB → 413", overMcp.status === 413, overMcp.status);
    // Chunked upload with no Content-Length: must still be capped.
    const chunked = await http(`${BASE}/api/call`, {
      method: "POST", headers: { cookie: alice.cookie, "content-type": "application/json" }, duplex: "half",
      body: new ReadableStream({ start(c) { for (let i = 0; i < 80; i++) c.enqueue(new TextEncoder().encode("x".repeat(1024))); c.close(); } }),
    });
    check("chunked body (no Content-Length) over the cap → 413", chunked.status === 413, chunked.status);
    // fetch refuses to send a lying Content-Length, so speak raw HTTP.
    const lieStatus = await rawHttp(BASE, `POST /api/call HTTP/1.1\r\nHost: x\r\nCookie: ${alice.cookie}\r\nContent-Type: application/json\r\nContent-Length: 999999999\r\nConnection: close\r\n\r\n{}`);
    check("lying Content-Length (claims 1 GB) → 413 at once, nothing buffered", lieStatus === 413, lieStatus);
    const shortStatus = await rawHttp(BASE, `POST /api/call HTTP/1.1\r\nHost: x\r\nCookie: ${alice.cookie}\r\nContent-Type: application/json\r\nContent-Length: 50\r\nConnection: close\r\n\r\n{"name":`, 4000);
    check("body shorter than its Content-Length → no hang past the client, no 5xx", shortStatus !== 500, shortStatus);
    const ok = await call(alice.cookie, "explore", {});
    check("…and the next request on the instance is still served", ok.ok, ok.status);
    const near = await mcp(a.token, "search", { pattern: "x".repeat(200) });
    check("argument near a limit is validated, not crashed", !isFiveXX(near), near.code ?? near.status);
    const unknown = await mcp(a.token, "invoke", { name: "doesNotExist", args: {} });
    check("unknown op through invoke → handled", unknown.ok || unknown.code, unknown.code);
    const loginBig = await http(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "x".repeat(10_000), password: "y" }) });
    check("oversized sign-in body → 413", loginBig.status === 413, loginBig.status);
    const adminByCustomer = await admin(alice.cookie, { kind: "agent", id: a.clientId, frozen: true });
    check("customer cannot change credit policy → 403", adminByCustomer.status === 403, adminByCustomer.status);
    const adminBad = await admin(bob.cookie, { kind: "agent", id: a.clientId, maxWindow: -3 });
    check("admin with an invalid value → 400", adminBad.status === 400, adminBad.status);
  }

  if (should("S3")) {
    scenario("S3", "Fan-out bombs: invoke inside invoke, 50×50 batches");
    const a = await newAgent(alice.cookie, "s3");
    let deep = { name: "explore", args: {} };
    for (let i = 0; i < 6; i++) deep = { name: "invoke", args: deep };
    const d = await mcp(a.token, "invoke", deep);
    check("6-deep invoke → FANOUT_LIMIT, server fine", JSON.stringify(d.msg ?? "").includes("FANOUT_LIMIT"), d.code ?? "");
    // Smallest possible inner calls, so the bomb fits under the 64 KB body cap.
    const inner = Array.from({ length: 50 }, () => ({ name: "getContext" }));
    const bomb = { calls: Array.from({ length: 50 }, () => ({ name: "invoke", args: { calls: inner } })) };
    metric("bomb body bytes", JSON.stringify(bomb).length);
    // A fresh agent has a full window, so the bomb is admitted (a charge bigger than
    // the window is taken against the whole window) and the fan-out cap must stop it.
    const fresh = await newAgent(alice.cookie, "s3-bomb");
    const t0 = Date.now();
    const b = await mcp(fresh.token, "invoke", bomb, { timeoutMs: 60_000 });
    metric("50×50 bomb ms", Date.now() - t0);
    const fanout = (JSON.stringify(b.msg ?? "").match(/FANOUT_LIMIT/g) ?? []).length;
    metric("inner calls refused with FANOUT_LIMIT", fanout);
    check("50×50 bomb (2,550 ops) is admitted, then capped at 200 operations", fanout > 0, `${fanout} inner calls refused`);
    check("…and leaves its caller in debt (the extra ops were charged)", (b.credits?.balance ?? 1) < 0, JSON.stringify(b.credits));
    const after = await mcp(fresh.token, "explore");
    check("…so its next call is refused until the debt is paid", after.code === "INSUFFICIENT_CREDITS", after.code);
    check("…and does not 5xx", !isFiveXX(b), b.status);
    check("…charged for what it asked to run (or refused up front)", b.code === "INSUFFICIENT_CREDITS" || (b.credits?.charged ?? 0) >= 16, JSON.stringify(b.credits ?? b.code));
    const oversized = { calls: Array.from({ length: 50 }, () => ({ name: "invoke", args: { calls: Array.from({ length: 50 }, () => ({ name: "explore", args: {} })) } })) };
    const o = await mcp(a.token, "invoke", oversized, { timeoutMs: 30_000 });
    check("a bomb over 64 KB is stopped at the door (413)", o.status === 413, o.status);
    check("server still answers", await alive());
  }

  if (should("S4")) {
    scenario("S4", "Flood: one agent fires hundreds of parallel calls");
    const a = await newAgent(alice.cookie, "s4");
    const n = QUICK ? 200 : 600;
    const rs = await Promise.all(Array.from({ length: n }, () => mcp(a.token, "explore")));
    const by = {};
    for (const r of rs) { const k = r.ok ? "ok" : r.code ?? (r.status === 0 ? `NET_${r.errText ?? r.text ?? "?"}` : `HTTP_${r.status}`); by[k] = (by[k] ?? 0) + 1; }
    metric("outcomes", by);
    metric("latency", stats(rs.map((r) => r.ms)));
    // Past ~500 simultaneous connections the OS refuses new ones (accept backlog)
    // before the app sees them. Measure that on a route with no credits and no lock,
    // so it is reported as what it is, and fail only on what the app answers.
    const base = await Promise.all(Array.from({ length: n }, () => http(`${BASE}/api/me`).then((r) => (r.status === 0 ? `NET_${r.text}` : "answered"))));
    const baseBy = {};
    for (const k of base) baseBy[k] = (baseBy[k] ?? 0) + 1;
    metric("same burst on /api/me (no credits, no lock)", baseBy);
    const answered = rs.filter((r) => r.status !== 0);
    const netOther = rs.filter((r) => r.status === 0 && r.errText !== "ECONNREFUSED");
    check("no HTTP 5xx from the app", answered.every((r) => r.status < 500), JSON.stringify(by));
    check("no timeouts or resets: the only network errors are OS backlog refusals", netOther.length === 0, JSON.stringify(by));
    check("every answered request is either success or INSUFFICIENT_CREDITS", answered.every((r) => r.ok || r.code === "INSUFFICIENT_CREDITS"), JSON.stringify(by));
    const refusal = rs.find((r) => r.code === "INSUFFICIENT_CREDITS");
    if (refusal) {
      const err = JSON.parse(refusal.result.content[0].text);
      check("refusals carry a plain-language hint", /Retry in|waiting for credits|Refused/.test(err.message), err.message);
      check("refusals carry retryAfterMs in _meta", refusal.credits?.retryAfterMs > 0, JSON.stringify(refusal.credits));
    }
    check("server still answers", await alive());
    await sleep(3000);
    const after = await mcp(a.token, "explore");
    check("the flooding agent recovers after a pause", after.ok, after.code);
  }

  if (should("S5")) {
    scenario("S5", "Isolation: a flooding agent must not take the app down for others");
    const attacker = await newAgent(alice.cookie, "s5-attacker");
    const victim = await newAgent(carol.cookie, "s5-victim");
    const dur = QUICK ? 8000 : 20_000;
    const flood = load(() => mcp(attacker.token, "explore"), { concurrency: 40, durationMs: dur });
    await sleep(500);
    // A normal agent: one call at a time, a few per second.
    const v = await load(async () => { const r = await mcp(victim.token, "explore"); await sleep(300); return r; }, { concurrency: 1, durationMs: dur - 1000 });
    const human = await load(async () => { const r = await call(bob.cookie, "explore", {}); await sleep(200); return r; }, { concurrency: 1, durationMs: dur - 1000 });
    const f = await flood;
    const fBy = {};
    for (const r of f) { const k = r.ok ? "ok" : r.code ?? (r.status === 0 ? `NET_${r.errText ?? r.text ?? "?"}` : `HTTP_${r.status}`); fBy[k] = (fBy[k] ?? 0) + 1; }
    metric("attacker outcomes", fBy);
    metric("victim agent latency", stats(v.map((r) => r.ms)));
    metric("human UI latency", stats(human.map((r) => r.ms)));
    const vOk = v.filter((r) => r.ok).length / v.length;
    const hOk = human.filter((r) => r.ok).length / human.length;
    check("victim agent: ≥ 99 % success while another agent floods", vOk >= 0.99, `${(vOk * 100).toFixed(1)} % of ${v.length}`);
    check("victim agent: never refused for someone else's credits", v.every((r) => r.code !== "INSUFFICIENT_CREDITS"));
    check("human UI: 100 % success during the flood", hOk === 1, `${(hOk * 100).toFixed(1)} % of ${human.length}`);
    check("victim p95 < 1 s", stats(v.map((r) => r.ms)).p95 < 1000, stats(v.map((r) => r.ms)).p95);
    // Load generator and server share one machine here, so a 40-way flood also
    // starves the client side; 2 s is the bar for "still usable".
    // The same flood with credits OFF gives the same human p95 (~2.8 s on the test
    // laptop): it is the raw request rate, which needs an edge limit (docs/credits.md
    // §17). The bar here is "still usable", and that credits do not make it worse.
    check("human p95 < 4 s (usable)", stats(human.map((r) => r.ms)).p95 < 4000, stats(human.map((r) => r.ms)).p95);
    check("no 5xx anywhere", [...f, ...v, ...human].every((r) => !isFiveXX(r)));
    check("the attacker's excess is refused at the door (gate), not queued", (fBy.INSUFFICIENT_CREDITS ?? 0) > 0, JSON.stringify(fBy));
  }

  if (should("S14")) {
    scenario("S14", "Slow clients and wedge attempts must not block the instance");
    const a = await newAgent(alice.cookie, "s14");
    // Slowloris: a body trickled in over ~8 s.
    const slowBody = http(`${BASE}/api/call`, {
      method: "POST", headers: { cookie: alice.cookie, "content-type": "application/json" }, duplex: "half",
      body: new ReadableStream({
        async start(c) {
          const s = JSON.stringify({ name: "explore", params: {} });
          for (const ch of s) { c.enqueue(new TextEncoder().encode(ch)); await sleep(8000 / s.length); }
          c.close();
        },
      }),
    }, 30_000);
    await sleep(500);
    const during = await load(async () => { const r = await call(bob.cookie, "explore", {}); await sleep(200); return r; }, { concurrency: 1, durationMs: 5000 });
    metric("other users while a body trickles in", stats(during.map((r) => r.ms)));
    check("a trickling body does not hold the instance (others p95 < 500 ms)", stats(during.map((r) => r.ms)).p95 < 500, stats(during.map((r) => r.ms)).p95);
    const sb = await slowBody;
    check("…and the slow request itself completes", sb.status === 200, sb.status);
    // The wedge that used to take the app down: malformed MCP bodies.
    for (const body of ["{not json", "[]", "[1,2]", '"x"', "null", '{"jsonrpc":"2.0"}']) {
      await mcp(a.token, null, {}, { rawBody: body, timeoutMs: 5000 });
    }
    const after = await call(bob.cookie, "explore", {}, { timeoutMs: 5000 });
    check("after malformed MCP bodies, /api/call still answers at once", after.ok && after.ms < 1000, `${after.status} ${Math.round(after.ms)} ms`);
    const conc = await Promise.all(Array.from({ length: 30 }, () => mcp(a.token, null, {}, { rawBody: "{bad", timeoutMs: 5000 })));
    check("30 concurrent malformed bodies → all answered 400", conc.every((r) => r.status === 400), [...new Set(conc.map((r) => r.status))].join(","));
    const after2 = await call(bob.cookie, "explore", {}, { timeoutMs: 5000 });
    check("…and the instance is still reachable", after2.ok, after2.status);
  }

  if (should("S6")) {
    scenario("S6", "Many agents at once: overload is shed with hints, and agents that follow them all finish");
    const agents = await Promise.all(Array.from({ length: QUICK ? 20 : 50 }, (_, i) => newAgent(i % 2 ? alice.cookie : carol.cookie, `s6-${i}`)));
    const polite = (a) => politeCall(a.token, "explore");
    const t0 = Date.now();
    const rs = (await Promise.all(agents.map((a) => load(() => polite(a), { concurrency: 2, count: 20 })))).flat();
    const secs = (Date.now() - t0) / 1000;
    const ok = rs.filter((r) => r.ok).length;
    const retried = rs.filter((r) => r.attempts > 1).length;
    metric("calls", rs.length);
    metric("needed a retry (load shed)", retried);
    metric("throughput calls/s", Math.round(rs.length / secs));
    metric("latency of each attempt", stats(rs.map((r) => r.ms)));
    check("agents that follow the hints all complete every call", ok === rs.length, `${ok}/${rs.length}; ${[...new Set(rs.filter((r) => !r.ok).map((r) => r.code))]}`);
    check("no 5xx", rs.every((r) => !isFiveXX(r)));
    const calm = await Promise.all(agents.slice(0, 20).map((a) => mcp(a.token, "explore")));
    check("at moderate load (20 agents, one call each) nobody is refused", calm.every((r) => r.ok), [...new Set(calm.map((r) => r.code))].join(","));
  }

  if (should("S7")) {
    scenario("S7", "Long calls: relay waits are charged for their time and shrink the window");
    const a = await newAgent(alice.cookie, "s7");
    await publishSilentTab(alice.cookie);
    const r1 = await mcp(a.token, "ui_action", { componentId: "stress.table", action: "refresh" }, { timeoutMs: 30_000 });
    metric("first long call", { ms: Math.round(r1.ms), code: r1.code, credits: r1.credits });
    check("the long call ran ~8 s and timed out at the relay (not at credits)", r1.code === "UI_TIMEOUT" || r1.code === "UI_NO_ACTIVE_PAGE", r1.code);
    if (r1.code === "UI_TIMEOUT") {
      check("it was charged for its run time", r1.credits?.charged >= 4 + 7, JSON.stringify(r1.credits));
      check("its window shrank", r1.credits?.window < 16, JSON.stringify(r1.credits));
      check("the agent was told why in a [credits] block", /ran \d+ s/.test(r1.result?.content?.map((c) => c.text).join(" ") ?? ""), r1.result?.content?.at(-1)?.text);
    }
    // A run of long calls in parallel: the window must cap them.
    await publishSilentTab(alice.cookie);
    const par = await Promise.all(Array.from({ length: 10 }, () => mcp(a.token, "ui_action", { componentId: "stress.table", action: "refresh" }, { timeoutMs: 40_000 })));
    const admitted = par.filter((r) => r.code !== "INSUFFICIENT_CREDITS").length;
    metric("10 parallel long calls", { admitted, refused: 10 - admitted });
    check("the shrunk window admits only a few long calls at once", admitted <= 4, `${admitted} admitted`);
    const victim = await newAgent(carol.cookie, "s7-victim");
    const v = await mcp(victim.token, "explore");
    check("another agent is unaffected right after", v.ok, v.code);
  }

  if (should("S8")) {
    scenario("S8", "Long calls vs. everybody else: is the app reachable while slow calls run?");
    const attacker = await newAgent(alice.cookie, "s8-attacker");
    const victim = await newAgent(carol.cookie, "s8-victim");
    await publishSilentTab(alice.cookie);
    const slow = load(() => mcp(attacker.token, "ui_action", { componentId: "stress.table", action: "refresh" }, { timeoutMs: 40_000 }), { concurrency: 6, durationMs: QUICK ? 10_000 : 20_000 });
    await sleep(1000);
    const v = await load(async () => { const r = await mcp(victim.token, "explore"); await sleep(250); return r; }, { concurrency: 1, durationMs: QUICK ? 8000 : 16_000 });
    const human = await load(async () => { const r = await call(bob.cookie, "explore", {}); await sleep(250); return r; }, { concurrency: 1, durationMs: QUICK ? 8000 : 16_000 });
    const s = await slow;
    metric("attacker long calls", { total: s.length, admitted: s.filter((r) => r.code !== "INSUFFICIENT_CREDITS").length });
    metric("victim latency while slow calls run", stats(v.map((r) => r.ms)));
    metric("human latency while slow calls run", stats(human.map((r) => r.ms)));
    check("victim agent stays ≥ 99 % successful", v.filter((r) => r.ok).length / v.length >= 0.99, `${v.filter((r) => r.ok).length}/${v.length}`);
    check("human UI stays 100 % successful", human.every((r) => r.ok), `${human.filter((r) => r.ok).length}/${human.length}`);
    check("victim p95 < 3 s", stats(v.map((r) => r.ms)).p95 < 3000, stats(v.map((r) => r.ms)).p95);
    check("human p95 < 3 s", stats(human.map((r) => r.ms)).p95 < 3000, stats(human.map((r) => r.ms)).p95);
  }

  if (should("S9")) {
    scenario("S9", "Admin controls under fire: freeze, cap, reset");
    const a = await newAgent(alice.cookie, "s9");
    const fz = await admin(bob.cookie, { kind: "agent", id: a.clientId, frozen: true });
    check("freeze accepted", fz.status === 200, fz.status);
    const r = await mcp(a.token, "explore");
    check("frozen agent refused with the admin hint", r.code === "INSUFFICIENT_CREDITS" && /administrator/.test(r.result?.content?.[0]?.text ?? ""), r.code);
    const other = await newAgent(alice.cookie, "s9-other");
    check("…a sibling agent of the same user is unaffected", (await mcp(other.token, "explore")).ok);
    await admin(bob.cookie, { kind: "agent", id: a.clientId, frozen: false });
    check("unfreeze restores access", (await mcp(a.token, "explore")).ok);
    // Quick calls finish one by one in this instance's queue, so a small window
    // never binds for them; long calls overlap, and that's where a cap must hold.
    await admin(bob.cookie, { kind: "agent", id: a.clientId, maxWindow: 2, refillPerSec: 0.05 });
    await publishSilentTab(alice.cookie);
    const par = await Promise.all(Array.from({ length: 10 }, () => mcp(a.token, "ui_action", { componentId: "stress.table", action: "refresh" }, { timeoutMs: 40_000 })));
    const admittedLong = par.filter((x) => x.code !== "INSUFFICIENT_CREDITS").length;
    metric("window 2, 10 parallel long calls", { admitted: admittedLong });
    check("a capped agent gets only one long call through at a time", admittedLong <= 1, admittedLong);
    check("…and none 5xx", par.every((x) => !isFiveXX(x)));
    await admin(bob.cookie, { kind: "agent", id: a.clientId, reset: true });
    await sleep(2000);
    check("reset restores the defaults", (await mcp(a.token, "explore")).ok);
    const list = await http(`${BASE}/api/admin/credits?kind=agent`, { headers: { cookie: bob.cookie } });
    check("ledger list still served under load", list.status === 200 && JSON.parse(list.text).data.ledgers.length > 0, list.status);
  }

  if (should("S10")) {
    scenario("S10", "Sign-in throttle");
    const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const codes = [];
    for (let i = 0; i < 12; i++) {
      const r = await http(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ username: "bob", password: "wrong" }) });
      codes.push(r.status);
    }
    metric("12 wrong passwords", codes.join(","));
    check("first 10 → 401, then 429", codes.slice(0, 10).every((c) => c === 401) && codes.slice(10).every((c) => c === 429));
    const otherUser = await login("alice", BASE, ip);
    check("same IP, another user can still sign in", otherUser.status === 200, otherUser.status);
    const lockedReal = await login("bob", BASE, ip);
    check("the guessed account is throttled even with the right password", lockedReal.status === 429, lockedReal.status);
    const parallel = await Promise.all(Array.from({ length: 50 }, (_, i) => http(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.8.0.${i}` }, body: JSON.stringify({ username: `u${i}`, password: "x" }) })));
    check("50 parallel bad sign-ins from different IPs → no 5xx", parallel.every((r) => !isFiveXX(r)));
  }

  if (should("S11") && BASE2) {
    scenario("S11", "Two instances sharing Redis: one ledger per agent across both");
    const a = await newAgent(alice.cookie, "s11");
    // Window 4, almost no refill: only 2 long calls (charge 4 each... capped to the window) can be outstanding.
    await admin(bob.cookie, { kind: "agent", id: a.clientId, maxWindow: 4, refillPerSec: 0.01 });
    await publishSilentTab(alice.cookie, BASE);
    await publishSilentTab(alice.cookie, BASE2);
    const both = await Promise.all(Array.from({ length: 8 }, (_, i) => mcp(a.token, "ui_action", { componentId: "stress.table", action: "refresh" }, { base: i % 2 ? BASE2 : BASE, timeoutMs: 40_000 })));
    const admitted = both.filter((r) => r.code !== "INSUFFICIENT_CREDITS").length;
    metric("8 long calls split over 2 instances", { admitted, codes: both.map((r) => r.code) });
    check("the shared window admits ≤ 1 at a time across BOTH instances (per-instance ledgers would admit 2)", admitted <= 1, `${admitted} admitted`);
    await admin(bob.cookie, { kind: "agent", id: a.clientId, reset: true });
    const b = await newAgent(alice.cookie, "s11-b");
    const flood = await Promise.all(Array.from({ length: 300 }, (_, i) => mcp(b.token, "explore", {}, { base: i % 2 ? BASE2 : BASE })));
    const by = {};
    for (const r of flood) { const k = r.ok ? "ok" : r.code ?? (r.status === 0 ? `NET_${r.errText ?? r.text ?? "?"}` : `HTTP_${r.status}`); by[k] = (by[k] ?? 0) + 1; }
    metric("300-call flood across both instances", by);
    check("no 5xx across instances", flood.every((r) => !isFiveXX(r)));
  }

  if (should("S12") && REDIS_CONTAINER) {
    scenario("S12", "Redis outages: stopped, then frozen (connected but not answering)");
    const docker = (...a) => spawnSync("docker", a, { encoding: "utf8", shell: process.platform === "win32" });
    const a = await newAgent(alice.cookie, "s12");
    const probe = async (label) => {
      const rs = await load(() => mcp(a.token, "explore", {}, { timeoutMs: 20_000 }), { concurrency: 4, durationMs: 5000 });
      const st = stats(rs.map((r) => r.ms));
      metric(label, { ...st, ok: rs.filter((r) => r.ok).length, n: rs.length, fiveXX: rs.filter(isFiveXX).length });
      return { rs, st };
    };
    await probe("baseline (Redis up)");
    docker("pause", REDIS_CONTAINER);
    try {
      const frozen = await probe("Redis PAUSED (connected, not answering)");
      check("Redis hung: calls still answered, no 5xx", frozen.rs.every((r) => !isFiveXX(r)), JSON.stringify(frozen.st));
      check("Redis hung: p95 bounded (< 5 s)", frozen.st.p95 < 5000, frozen.st.p95);
    } finally {
      docker("unpause", REDIS_CONTAINER);
    }
    docker("stop", REDIS_CONTAINER);
    try {
      const down = await probe("Redis STOPPED");
      check("Redis down: calls still answered, no 5xx", down.rs.every((r) => !isFiveXX(r)), JSON.stringify(down.st));
      check("Redis down: p95 bounded (< 3 s)", down.st.p95 < 3000, down.st.p95);
      check("Redis down: metering still on (per-instance)", down.rs.some((r) => r.credits), "");
    } finally {
      docker("start", REDIS_CONTAINER);
    }
    await sleep(35_000); // REDIS_RETRY_COOLDOWN_MS default 30 s
    const back = await probe("Redis back");
    check("Redis back: service recovered", back.rs.every((r) => !isFiveXX(r)) && back.rs.filter((r) => r.ok).length > 0);
  }

  if (should("S13")) {
    scenario("S13", "Soak: sustained mixed load, many agents");
    const agents = await Promise.all(Array.from({ length: 10 }, (_, i) => newAgent(alice.cookie, `s13-${i}`)));
    const ops = [
      ["explore", {}], ["search", { pattern: "guest" }], ["getContext", {}], ["describe_tool", { name: "book" }],
      ["invoke", { calls: [{ name: "explore", args: {} }, { name: "getContext", args: {} }] }],
    ];
    const dur = QUICK ? 15_000 : 60_000;
    const t0 = Date.now();
    const rs = await load(async (i) => {
      const a = agents[i % agents.length];
      const [name, ar] = ops[i % ops.length];
      return politeCall(a.token, name, ar);
    }, { concurrency: 20, durationMs: dur });
    const secs = (Date.now() - t0) / 1000;
    const by = {};
    for (const r of rs) { const k = r.ok ? "ok" : r.code ?? (r.status === 0 ? `NET_${r.errText ?? r.text ?? "?"}` : `HTTP_${r.status}`); by[k] = (by[k] ?? 0) + 1; }
    metric("duration s", Math.round(secs));
    metric("throughput calls/s", Math.round(rs.length / secs));
    metric("outcomes", by);
    metric("latency", stats(rs.map((r) => r.ms)));
    check("no 5xx during the soak", rs.every((r) => !isFiveXX(r)), JSON.stringify(by));
    check("agents that follow the hints: ≥ 99 % of calls complete", (by.ok ?? 0) / rs.length >= 0.99, `${(((by.ok ?? 0) / rs.length) * 100).toFixed(1)} %`);
    check("server still answers", await alive());
  }

  // ── Summary ──
  const all = results.scenarios.flatMap((s) => s.checks.map((c) => ({ ...c, scenario: s.id })));
  const failed = all.filter((c) => !c.ok);
  results.finishedAt = new Date().toISOString();
  results.summary = { checks: all.length, passed: all.length - failed.length, failed: failed.length };
  console.log(`\n${failed.length ? "✘" : "✔"} ${all.length - failed.length}/${all.length} checks passed`);
  for (const f of failed) console.log(`   ✘ [${f.scenario}] ${f.name} — ${f.detail}`);
  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
