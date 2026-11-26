#!/usr/bin/env node
// End-to-end check of the NavWebMcp protocol over real MCP Streamable HTTP and
// POST /api/call, against a running server (npm run build && npm start).
//
//   node scripts/e2e.mjs [--base=http://localhost:3000]
//
// Exit code 0 = every check passed. One section per protocol feature; add the
// day's checks when a protocol version adds a feature (docs/plans/agent-protocol-roadmap.md).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const req = createRequire(pathToFileURL(process.cwd() + "/package.json"));
const { Client } = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/index.js")));
const { StreamableHTTPClientTransport } = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")));

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const BASE = argv.base ?? "http://localhost:3000";
const VERSION = readFileSync("lib/protocol.ts", "utf8").match(/PROTOCOL_VERSION = "([^"]+)"/)[1];
let pass = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failCount++; console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ""); }
}

async function login(username) {
  const res = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "password" }) });
  const body = await res.json();
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { token: body.agentToken, cookie };
}
async function mcp(token) {
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const c = new Client({ name: "e2e", version: "1.0.0" });
  await c.connect(t);
  return c;
}
const text = (r) => JSON.parse(r.content[0].text);

const alice = await login("alice");
const bob = await login("bob");
const c = await mcp(alice.token);

console.log("handshake");
check(`serverInfo.version is ${VERSION}`, c.getServerVersion()?.version === VERSION, c.getServerVersion());
check("instructions mention today/timezone", /today/.test(c.getInstructions() ?? ""));
const { tools } = await c.listTools();
check("12 always-on tools (8 navigation + 4 ui_*)", tools.length === 12, tools.map((t) => t.name));

console.log("getContext");
const ctx = await c.callTool({ name: "getContext", arguments: {} });
const sc = ctx.structuredContent;
check("role/now/today/timezone present", sc.role === "customer" && sc.timezone === "UTC" && sc.today === sc.now.slice(0, 10), sc);
check("page is null", sc.page === null, sc);

console.log("invoke (flat)");
const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const av = await c.callTool({ name: "invoke", arguments: { name: "searchAvailability", args: { date, partySize: 2 } } });
check("credits still reported in _meta on success", typeof av._meta?.["navwebmcp/credits"]?.balance === "number", av._meta);
check("success: data returned flat, no inner success", !av.isError && Array.isArray(av.structuredContent.slots) && !("success" in av.structuredContent), av.structuredContent);
const unk = await c.callTool({ name: "invoke", arguments: { name: "searchAvailabilty", args: {} } });
const ue = text(unk);
check("unknown op → isError UNKNOWN_TOOL with suggestion", unk.isError && ue.code === "UNKNOWN_TOOL" && ue.suggestions?.includes("searchAvailability"), ue);
check("error has retryable/hint/requestId/callId", ue.retryable === false && typeof ue.hint === "string" && typeof ue.requestId === "string" && typeof ue.callId === "string", ue);
check("credits still reported in _meta on errors", typeof unk._meta?.["navwebmcp/credits"]?.balance === "number", unk._meta);
const bad = await c.callTool({ name: "invoke", arguments: { name: "searchAvailability", args: { date: "nope", partySize: 0 } } });
const be = text(bad);
check("bad input → INVALID_INPUT with per-field details", bad.isError && be.code === "INVALID_INPUT" && be.details?.length === 2, be);
const forb = await c.callTool({ name: "invoke", arguments: { name: "listAllReservations", args: {} } });
check("customer → FORBIDDEN", forb.isError && text(forb).code === "FORBIDDEN", text(forb));
const both = await c.callTool({ name: "invoke", arguments: { name: "getContext", calls: [{ name: "getContext", args: {} }] } });
check("name + calls → INVALID_INPUT", both.isError && text(both).code === "INVALID_INPUT", text(both));

console.log("batch");
const batch = await c.callTool({ name: "invoke", arguments: { calls: [{ name: "getContext", args: {} }, { name: "nope", args: {} }] } });
const items = batch.structuredContent?.results;
check("batch returns per-call envelopes", !batch.isError && items?.[0]?.success === true && items?.[1]?.error?.code === "UNKNOWN_TOOL" && items?.[1]?.error?.retryable === false, batch.structuredContent);

console.log("invoke relaying data with its own `results`");
const lt = await c.callTool({ name: "invoke", arguments: { name: "load_tools", args: { names: ["getWaitTime"] } } });
check("passes SDK output validation", !lt.isError && lt.structuredContent?.results?.[0]?.status === "LOADED", lt);

console.log("native (loaded) tool path");
const c2 = await mcp(alice.token); // fresh session sees the promoted tool
const { tools: tools2 } = await c2.listTools();
check("getWaitTime promoted into tools/list", tools2.some((t) => t.name === "getWaitTime"));
const wt = await c2.callTool({ name: "getWaitTime", arguments: { partySize: 2 } });
check("native call succeeds with structuredContent", !wt.isError && wt.structuredContent && typeof wt.structuredContent === "object", wt);
const wtBad = await c2.callTool({ name: "getWaitTime", arguments: { partySize: 2, typo: 1 } });
check("native call: unknown key rejected", wtBad.isError === true, wtBad.content?.[0]?.text);
await c2.close();

console.log("describe_tool / capabilities");
const dt = await c.callTool({ name: "describe_tool", arguments: { name: "creatReservation" } });
check("describe_tool UNKNOWN_TOOL carries suggestions", dt.structuredContent?.error === "UNKNOWN_TOOL" && dt.structuredContent?.suggestions?.includes("createReservation"), dt.structuredContent);
const cap = await c.callTool({ name: "getCapabilities", arguments: {} });
check(`protocolVersion ${VERSION} and 8-hex capabilityHash`, cap.structuredContent.protocolVersion === VERSION && /^[0-9a-f]{8}$/.test(cap.structuredContent.capabilityHash), cap.structuredContent);

console.log("confirmation gate");
const book = await c.callTool({ name: "invoke", arguments: { name: "book", args: { date, time: av.structuredContent.slots.find((s) => s.available)?.time ?? "18:00", partySize: 2, name: "E2E" } } });
check("book composite succeeds and validates", !book.isError && book.structuredContent?.validated === true, book.structuredContent ?? text(book));
const resId = book.structuredContent?.reservation?.id;
const noConfirm = await c.callTool({ name: "invoke", arguments: { name: "cancelReservation", args: { reservationId: resId, confirm: false } } });
check("cancel without confirm → CONFIRMATION_REQUIRED + hint", noConfirm.isError && text(noConfirm).code === "CONFIRMATION_REQUIRED" && /confirm/.test(text(noConfirm).hint), text(noConfirm));
const yes = await c.callTool({ name: "invoke", arguments: { name: "cancelReservation", args: { reservationId: resId, confirm: true } } });
check("cancel with confirm succeeds", !yes.isError && yes.structuredContent?.cancelled === true, yes.structuredContent ?? text(yes));

console.log("idempotency keys (2.1.0)");
const run = Date.now().toString(36);
const capBook = cap.structuredContent.tools.find((t) => t.name === "book");
const capRead = cap.structuredContent.tools.find((t) => t.name === "getReservation");
check("getCapabilities: idempotent on writes only", capBook?.idempotent === true && capRead?.idempotent === undefined, { capBook, capRead });
const dBook = (await c.callTool({ name: "describe_tool", arguments: { name: "book" } })).structuredContent;
check("describe_tool: idempotent + optional idempotencyKey in the input schema", dBook.idempotent === true && "idempotencyKey" in dBook.inputSchema.properties && !dBook.inputSchema.required.includes("idempotencyKey"), dBook);
const slot2 = av.structuredContent.slots.filter((s) => s.available).at(-1);
const keyed = { date, time: slot2?.time ?? "20:00", partySize: 2, name: `E2E idem ${run}`, idempotencyKey: `e2e-${run}` };
const k1 = await c.callTool({ name: "invoke", arguments: { name: "book", args: keyed } });
const k2 = await c.callTool({ name: "invoke", arguments: { name: "book", args: keyed } });
check("keyed book succeeds", !k1.isError && k1.structuredContent?.reservation?.id, k1.structuredContent ?? text(k1));
check("same key + args → same reservation, replayed in _meta and a text block",
  !k2.isError && k2.structuredContent?.reservation?.id === k1.structuredContent?.reservation?.id &&
  k2._meta?.["navwebmcp/idempotency"]?.replayed === true && k2.content.some((b) => b.text?.startsWith("[idempotency]")), k2);
check("a replay is charged 1 credit", k2._meta?.["navwebmcp/credits"]?.charged === 1, k2._meta);
const mine = (await c.callTool({ name: "invoke", arguments: { name: "listReservations", args: {} } })).structuredContent.reservations;
check("one reservation in the store", mine.filter((x) => x.name === keyed.name && x.status !== "cancelled").length === 1, mine.length);
const k3 = await c.callTool({ name: "invoke", arguments: { name: "book", args: { ...keyed, partySize: 3 } } });
check("same key + other args → IDEMPOTENCY_CONFLICT, not retryable", k3.isError && text(k3).code === "IDEMPOTENCY_CONFLICT" && text(k3).retryable === false, text(k3));
const rk = k1.structuredContent?.reservation?.id;
const ck = `e2e-cancel-${run}`;
const c1 = await c.callTool({ name: "invoke", arguments: { name: "cancelReservation", args: { reservationId: rk, confirm: false, idempotencyKey: ck } } });
const c2b = await c.callTool({ name: "invoke", arguments: { name: "cancelReservation", args: { reservationId: rk, confirm: true, idempotencyKey: ck } } });
check("CONFIRMATION_REQUIRED frees the key: confirm: true with the same key runs", c1.isError && text(c1).code === "CONFIRMATION_REQUIRED" && !c2b.isError && c2b.structuredContent?.cancelled === true, c2b.structuredContent ?? text(c2b));
const c3 = await c.callTool({ name: "invoke", arguments: { name: "cancelReservation", args: { reservationId: rk, confirm: true, idempotencyKey: ck } } });
check("a repeated keyed cancel is replayed, not ALREADY_CANCELLED", !c3.isError && c3._meta?.["navwebmcp/idempotency"]?.replayed === true, c3.structuredContent ?? text(c3));
const rd = await c.callTool({ name: "invoke", arguments: { name: "getWaitTime", args: { partySize: 2, idempotencyKey: "x" } } });
check("reads reject idempotencyKey (strict input)", rd.isError && text(rd).code === "INVALID_INPUT", text(rd));
const t = (await c.listTools()).tools;
check("tools/list annotations unchanged for reads (no idempotentHint)", !t.find((x) => x.name === "getContext")?.annotations?.idempotentHint, t.find((x) => x.name === "getContext")?.annotations);
await c.close();

console.log("/api/call (UI + in-page surface)");
const call = (cookie, name, params) => fetch(`${BASE}/api/call`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name, params }) });
let r = await call(alice.cookie, "nope", {});
let j = await r.json();
check("unknown op → 404 UNKNOWN_TOOL", r.status === 404 && j.error.code === "UNKNOWN_TOOL", { status: r.status, j });
r = await call(alice.cookie, "listAllReservations", {});
j = await r.json();
check("forbidden → 403", r.status === 403 && j.error.code === "FORBIDDEN", { status: r.status, j });
r = await call(alice.cookie, "searchAvailability", { date: "x", partySize: 2 });
j = await r.json();
check("invalid → 200 INVALID_INPUT with details", r.status === 200 && j.error.code === "INVALID_INPUT" && j.error.details?.[0]?.path === "date", j);
r = await call(bob.cookie, "getWeeklyRevenueSummary", { weekStartDate: "2026-02-31" });
j = await r.json();
check("weekly summary bad date → INVALID_INPUT (was INVALID_DATE)", j.success === true || j.error.code === "INVALID_INPUT", j);
r = await call(alice.cookie, "getContext", {});
j = await r.json();
check("getContext via /api/call ok", r.status === 200 && j.success && j.data.timezone === "UTC", j);
const carolS = await login("carol");
const taskArgs = { title: `E2E task ${run}`, department: "Housekeeping", priority: "low", idempotencyKey: `e2e-task-${run}` };
const t1 = await call(carolS.cookie, "createTask", taskArgs);
const t1j = await t1.json();
const t2 = await call(carolS.cookie, "createTask", taskArgs);
const t2j = await t2.json();
check("/api/call: keyed replay is 200 with Idempotent-Replayed and the same task",
  t2.status === 200 && t2.headers.get("idempotent-replayed") === "true" && t2j.idempotency?.replayed === true && t2j.data.task.taskId === t1j.data.task.taskId, { status: t2.status, t2j });
const t3 = await call(carolS.cookie, "createTask", { ...taskArgs, priority: "high" });
check("/api/call: IDEMPOTENCY_CONFLICT is HTTP 409", t3.status === 409 && (await t3.json()).error.code === "IDEMPOTENCY_CONFLICT", t3.status);
const audit = await (await fetch(`${BASE}/api/audit`, { headers: { Cookie: bob.cookie } })).json();
const entries = Array.isArray(audit) ? audit : audit.entries ?? audit.data ?? [];
check("audit log received the calls", Array.isArray(entries) && entries.length > 0, Object.keys(audit));

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
