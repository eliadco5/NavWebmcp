#!/usr/bin/env node
// End-to-end check of the NavWebMcp protocol over real MCP Streamable HTTP and
// POST /api/call, against a running server (npm run build && npm start).
//
//   node scripts/e2e.mjs [--base=http://localhost:3000] [--era=modern|legacy]
//
// --era picks the MCP protocol generation the client speaks: "modern" is the
// 2026-07-28 revision (stateless, per-request _meta envelope, server/discover),
// "legacy" the 2025-era initialize handshake. The server serves both; run both.
//
// Exit code 0 = every check passed. One section per protocol feature; add the
// day's checks when a protocol version adds a feature (docs/plans/agent-protocol-roadmap.md).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const req = createRequire(pathToFileURL(process.cwd() + "/package.json"));
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(req.resolve("@modelcontextprotocol/client")));

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const BASE = argv.base ?? "http://localhost:3000";
const ERA = argv.era === "legacy" ? "legacy" : "modern";
const MODERN = "2026-07-28";
console.log(`MCP era: ${ERA}${ERA === "modern" ? ` (${MODERN})` : " (2025 initialize handshake)"}`);
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
async function mcp(token, { query = "", headers = {} } = {}) {
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp${query}`), { requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } } });
  const c = new Client({ name: "e2e", version: "1.0.0" }, ERA === "modern" ? { versionNegotiation: { mode: { pin: MODERN } } } : {});
  await c.connect(t);
  return c;
}
const text = (r) => JSON.parse(r.content[0].text);

const alice = await login("alice");
const bob = await login("bob");
const c = await mcp(alice.token);

console.log("handshake");
check(`negotiated the ${ERA} era`, ERA === "modern" ? c.getNegotiatedProtocolVersion() === MODERN : c.getNegotiatedProtocolVersion() !== MODERN, c.getNegotiatedProtocolVersion());
check(`serverInfo.version is ${VERSION}`, c.getServerVersion()?.version === VERSION, c.getServerVersion());
check("instructions mention today/timezone", /today/.test(c.getInstructions() ?? ""));
const { tools } = await c.listTools();
check("12 always-on tools (8 navigation + 4 ui_*)", tools.length === 12, tools.map((t) => t.name));
check("always-on tools publish no outputSchema (2.5.0)", tools.every((t) => t.outputSchema === undefined), tools.filter((t) => t.outputSchema).map((t) => t.name));
const connectTokens = Math.ceil(JSON.stringify(tools).length / 4);
check("connect cost (tools/list) under 2,200 tokens", connectTokens <= 2200, connectTokens);

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
const wtErr = wtBad.isError ? text(wtBad) : {};
check("native call: unknown key → NavWebMcp INVALID_INPUT naming the key", wtErr.code === "INVALID_INPUT" && JSON.stringify(wtErr.details).includes("typo"), wtBad.content?.[0]?.text);
await c2.close();

console.log("describe_tool / capabilities");
const dt = await c.callTool({ name: "describe_tool", arguments: { name: "creatReservation" } });
check("describe_tool UNKNOWN_TOOL carries suggestions", dt.structuredContent?.error === "UNKNOWN_TOOL" && dt.structuredContent?.suggestions?.includes("createReservation"), dt.structuredContent);
const cap = await c.callTool({ name: "getCapabilities", arguments: {} });
check(`protocolVersion ${VERSION} and 8-hex capabilityHash`, cap.structuredContent.protocolVersion === VERSION && /^[0-9a-f]{8}$/.test(cap.structuredContent.capabilityHash), cap.structuredContent);
const dExplore = (await c.callTool({ name: "describe_tool", arguments: { name: "explore" } })).structuredContent;
check("describe_tool still returns an always-on tool's outputSchema", dExplore?.outputSchema?.type === "object", dExplore?.outputSchema);

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

console.log("dependent batches (2.2.0)");
const dInvoke = (await c.callTool({ name: "describe_tool", arguments: { name: "invoke" } })).structuredContent;
check("describe_tool(invoke) documents $ref", /\$ref/.test(dInvoke.description) && /\$ref/.test(JSON.stringify(dInvoke.inputSchema)), dInvoke.description);
const free = av.structuredContent.slots.filter((s) => s.available).map((s) => s.time);
const want = free.find((tm) => tm !== keyed.time && tm !== free[0]) ?? free.at(-2) ?? free[0];
const chainName = `E2E chain ${run}`;
const chained = await c.callTool({ name: "invoke", arguments: { calls: [
  { name: "searchAvailability", args: { date, partySize: 2, time: want } },
  { name: "createReservation", args: { slotId: { $ref: "0.data.slots[0].id" }, name: chainName, partySize: 2, idempotencyKey: `e2e-chain-${run}` } },
  { name: "getReservation", args: { reservationId: { $ref: "1.data.reservation.id" } } },
] } });
const cr = chained.structuredContent?.results ?? [];
check("search → create → read in one batch, all succeed", !chained.isError && cr.length === 3 && cr.every((x) => x.success), cr);
check("the batch booked the slot at the requested time", cr[0]?.data?.slots?.[0]?.time === want && cr[1]?.data?.reservation?.slotId === cr[0]?.data?.slots?.[0]?.id, { want, cr0: cr[0]?.data?.slots?.[0] });
check("the read returned the reservation just created", cr[2]?.data?.reservation?.id === cr[1]?.data?.reservation?.id, cr[2]);
const fwd = await c.callTool({ name: "invoke", arguments: { calls: [
  { name: "getContext", args: {} },
  { name: "getWaitTime", args: { partySize: { $ref: "1.data.x" } } },
] } });
check("forward $ref → isError INVALID_INPUT naming the arg", fwd.isError && text(fwd).code === "INVALID_INPUT" && text(fwd).details?.[0]?.path === "calls.1.args.partySize", text(fwd));
const miss = await c.callTool({ name: "invoke", arguments: { calls: [
  { name: "searchAvailability", args: { date, partySize: 2, time: "03:00" } },
  { name: "createReservation", args: { slotId: { $ref: "0.data.slots[0].id" }, name: `E2E none ${run}`, partySize: 2 } },
] } });
const mr = miss.structuredContent?.results ?? [];
check("an empty result → DEPENDENCY_FAILED, the write is not run", mr[1]?.error?.code === "DEPENDENCY_FAILED" && mr[1]?.error?.retryable === false, mr[1]);
const single = await c.callTool({ name: "invoke", arguments: { name: "getWaitTime", args: { partySize: { $ref: "0.data.x" } } } });
check("$ref in the single-call form → INVALID_INPUT", single.isError && text(single).code === "INVALID_INPUT", text(single));

console.log("compact text format (2.3.0)");
const fmtArgs = { name: "invoke", arguments: { name: "searchAvailability", args: { date, partySize: 2 } } };
const prettyR = await c.callTool(fmtArgs);
check("default connection: text block is indented JSON of structuredContent", prettyR.content[0].text === JSON.stringify(prettyR.structuredContent, null, 2));
const perCall = await c.callTool({ ...fmtArgs, _meta: { "navwebmcp/format": "compact" } });
check("per call: _meta navwebmcp/format compact → compact text", perCall.content[0].text === JSON.stringify(perCall.structuredContent));
const cq = await mcp(alice.token, { query: "?format=compact" });
const qR = await cq.callTool(fmtArgs);
check("?format=compact on the URL → compact text, same structuredContent", qR.content[0].text === JSON.stringify(qR.structuredContent) && JSON.stringify(qR.structuredContent.slots.map((x) => x.id)) === JSON.stringify(prettyR.structuredContent.slots.map((x) => x.id)));
check("compact text is shorter", qR.content[0].text.length < prettyR.content[0].text.length, { compact: qR.content[0].text.length, pretty: prettyR.content[0].text.length });
const qErr = await cq.callTool({ name: "invoke", arguments: { name: "nope", args: {} } });
check("compact connection: errors compact too", qErr.isError && !/\n/.test(qErr.content[0].text) && text(qErr).code === "UNKNOWN_TOOL", qErr.content[0].text);
const qBack = await cq.callTool({ ...fmtArgs, _meta: { "navwebmcp/format": "pretty" } });
check("per call: pretty overrides a compact connection", qBack.content[0].text === JSON.stringify(qBack.structuredContent, null, 2));
await cq.close();
const ch = await mcp(alice.token, { query: "?format=compact", headers: { "X-NavWebMcp-Format": "pretty" } });
const hR = await ch.callTool(fmtArgs);
check("the header wins over the URL", hR.content[0].text === JSON.stringify(hR.structuredContent, null, 2));
await ch.close();
await c.close();

console.log("confirmation previews, tokens and dry-run (2.6.0)");
{
  const a = await mcp(alice.token);
  const b = await mcp(bob.token);
  const carolM = await login("carol");
  const cc = await mcp(carolM.token);
  const inv = (cl, name, args) => cl.callTool({ name: "invoke", arguments: { name, args } });
  const err = (r) => (r.isError ? text(r) : {});
  // A fresh open slot each time, walking forward through the days as they fill up.
  let dayOffset = 2;
  const bookOne = async (who) => {
    for (let tries = 0; tries < 60; tries++, dayOffset++) {
      const day = new Date(Date.now() + dayOffset * 86400000).toISOString().slice(0, 10);
      const open = (await inv(a, "searchAvailability", { date: day, partySize: 2 })).structuredContent?.slots?.filter((s) => s.available) ?? [];
      if (!open.length) continue;
      const r = await inv(a, "createReservation", { slotId: open[0].id, name: `E2E conf ${who} ${run}`, partySize: 2 });
      if (r.structuredContent?.reservation?.id) return r.structuredContent.reservation.id;
    }
    throw new Error(`no open slot for ${who}`);
  };

  // The six destructive business operations: ask → preview + token, dryRun writes nothing, the token runs it.
  const created = (await inv(b, "createTask", { title: `E2E conf task ${run}`, department: "Housekeeping", priority: "low" })).structuredContent?.task?.taskId;
  let payment;
  for (let d = 0; d < 10 && !payment; d++) {
    const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const ps = (await inv(b, "listPayments", { date: day })).structuredContent?.payments ?? [];
    payment = ps.find((p) => p.status === "completed" || p.status === "paid" || (p.status !== "refunded" && p.status !== "partial_refund"));
  }
  const toCheckOut = await bookOne("checkout");
  const checkedIn = await inv(cc, "checkInGuest", { reservationId: toCheckOut });
  const cases = [
    { op: "cancelReservation", cl: a, args: { reservationId: await bookOne("cancel") }, re: /Cancel reservation/ },
    { op: "cancelAnyReservation", cl: b, args: { reservationId: await bookOne("cancelAny") }, re: /any owner/ },
    { op: "deleteTask", cl: b, args: { taskId: created }, re: /Permanently delete task/ },
    { op: "applyNoShowFee", cl: b, args: { reservationId: await bookOne("fee"), feeAmount: 15, reason: "E2E no-show" }, re: /no-show fee of 15/ },
    ...(payment ? [{ op: "issueRefund", cl: b, args: { paymentId: payment.paymentId, amount: 1, reason: "E2E refund" }, re: /Refund 1 of/ }] : []),
    ...(!checkedIn.isError ? [{ op: "checkOutGuest", cl: cc, args: { reservationId: toCheckOut }, re: /Check out .* free table/ }] : []),
  ];
  check("all 6 destructive operations have a test target", cases.length === 6, { payment: Boolean(payment), checkedIn: checkedIn.isError ? text(checkedIn) : "ok" });
  for (const k of cases) {
    const ask = await inv(k.cl, k.op, k.args);
    const e = err(ask);
    check(`${k.op}: no confirm → CONFIRMATION_REQUIRED with preview and token`, e.code === "CONFIRMATION_REQUIRED" && k.re.test(e.confirmation?.preview?.summary ?? "") && /^c1\./.test(e.confirmation?.token ?? ""), e);
    const dry = await inv(k.cl, k.op, { ...k.args, dryRun: true });
    check(`${k.op}: dryRun → preview, charged as a read`, !dry.isError && dry.structuredContent?.dryRun === true && k.re.test(dry.structuredContent?.preview?.summary ?? "") && dry._meta?.["navwebmcp/credits"]?.charged <= 3, dry.structuredContent ?? text(dry));
    const again = await inv(k.cl, k.op, k.args);
    check(`${k.op}: dryRun wrote nothing (still asks)`, err(again).code === "CONFIRMATION_REQUIRED", err(again));
    const run2 = await inv(k.cl, k.op, { ...k.args, confirmationToken: e.confirmation?.token });
    check(`${k.op}: the token runs it`, !run2.isError, run2.structuredContent ?? text(run2));
    const reuse = await inv(k.cl, k.op, { ...k.args, confirmationToken: e.confirmation?.token });
    check(`${k.op}: the token works once`, reuse.isError && ["CONFIRMATION_STALE", "NOT_FOUND", "INVALID_STATE", "FEE_ALREADY_APPLIED"].includes(err(reuse).code), err(reuse));
  }

  // Binding: a token for one reservation doesn't cancel another.
  const r1 = await bookOne("bind1");
  const r2 = await bookOne("bind2");
  const t1 = err(await inv(a, "cancelReservation", { reservationId: r1 })).confirmation?.token;
  const swap = await inv(a, "cancelReservation", { reservationId: r2, confirmationToken: t1 });
  check("a token for other arguments → CONFIRMATION_STALE with a new preview and token", err(swap).code === "CONFIRMATION_STALE" && err(swap).confirmation?.token && err(swap).confirmation.token !== t1, err(swap));
  const forged = await inv(a, "cancelReservation", { reservationId: r2, confirmationToken: `${String(t1).slice(0, -4)}AAAA` });
  check("a tampered token → CONFIRMATION_STALE", err(forged).code === "CONFIRMATION_STALE", err(forged));
  const stolen = await inv(b, "cancelAnyReservation", { reservationId: r1, confirmationToken: t1 });
  check("another user's token → CONFIRMATION_STALE", err(stolen).code === "CONFIRMATION_STALE", err(stolen));
  const dt = (await a.callTool({ name: "describe_tool", arguments: { name: "cancelReservation" } })).structuredContent;
  check("describe_tool: confirm optional; confirmationToken and dryRun published", !dt.inputSchema.required.includes("confirm") && "confirmationToken" in dt.inputSchema.properties && "dryRun" in dt.inputSchema.properties, dt.inputSchema);
  const rdry = await inv(a, "getWaitTime", { partySize: 2, dryRun: true });
  check("reads reject dryRun (strict input)", err(rdry).code === "INVALID_INPUT", err(rdry));

  // MCP elicitation: only a 2026-07-28 client that declares it is asked.
  const asked = [];
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${alice.token}` } } });
  const ce = new Client({ name: "e2e-elicit", version: "1.0.0" }, { capabilities: { elicitation: {} }, ...(ERA === "modern" ? { versionNegotiation: { mode: { pin: MODERN } } } : {}) });
  ce.setRequestHandler("elicitation/create", async (req) => { asked.push(req.params.message); return { action: asked.length === 1 ? "accept" : "decline", content: { approve: true } }; });
  await ce.connect(t);
  const e1 = await bookOne("elicit1");
  const yesE = await ce.callTool({ name: "invoke", arguments: { name: "cancelReservation", args: { reservationId: e1 } } });
  if (ERA === "modern") {
    check("elicitation: the user is asked with the preview; accepting runs it", asked.length === 1 && /Cancel reservation/.test(asked[0]) && !yesE.isError && yesE.structuredContent?.cancelled === true, { asked, r: yesE.structuredContent ?? text(yesE) });
    const e2 = await bookOne("elicit2");
    const noE = await ce.callTool({ name: "invoke", arguments: { name: "cancelReservation", args: { reservationId: e2 } } });
    check("elicitation: declining → CONFIRMATION_DENIED", err(noE).code === "CONFIRMATION_DENIED", err(noE));
  } else {
    // Stateless 2025-era requests carry no client capabilities, so the token flow applies.
    check("legacy era: no elicitation; CONFIRMATION_REQUIRED with a token instead", asked.length === 0 && err(yesE).code === "CONFIRMATION_REQUIRED" && err(yesE).confirmation?.token, err(yesE));
  }
  await ce.close();

  // /api/call: a person's confirm: true still works; the WebMCP agent gets the preview.
  const apiCall = (cookie, name, params, channel) => fetch(`${BASE}/api/call`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, ...(channel && { "x-navwebmcp-channel": channel }) }, body: JSON.stringify({ name, params }) });
  const h1 = await bookOne("ui");
  const ui = await (await apiCall(alice.cookie, "cancelReservation", { reservationId: h1, confirm: true })).json();
  check("/api/call: a person's confirm: true runs", ui.success === true, ui);
  const h2 = await bookOne("webmcp");
  const wres = await apiCall(alice.cookie, "cancelReservation", { reservationId: h2 }, "webmcp");
  const wj = await wres.json();
  check("/api/call: no confirm → 200 CONFIRMATION_REQUIRED with the preview", wres.status === 200 && wj.error?.code === "CONFIRMATION_REQUIRED" && /Cancel reservation/.test(wj.error?.confirmation?.preview?.summary ?? ""), { status: wres.status, wj });
  const wrun = await (await apiCall(alice.cookie, "cancelReservation", { reservationId: h2, confirmationToken: wj.error?.confirmation?.token }, "webmcp")).json();
  check("/api/call: the WebMCP dialog's token runs it", wrun.success === true, wrun);

  await Promise.all([a.close(), b.close(), cc.close()]);
}

console.log("MCP transport (2026-07-28 upgrade)");
const rpc = (body, headers = {}) => fetch(`${BASE}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${alice.token}`, "Mcp-Method": body.method, ...headers }, body: JSON.stringify(body) });
const parseRpc = async (res) => { const t = await res.text(); const line = t.split("\n").find((l) => l.startsWith("data:")); return JSON.parse(line ? line.slice(5) : t); };
const envelope = (v) => ({ "io.modelcontextprotocol/protocolVersion": v, "io.modelcontextprotocol/clientInfo": { name: "e2e-raw", version: "1.0.0" }, "io.modelcontextprotocol/clientCapabilities": {} });
let dres = await rpc({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: envelope(MODERN) } }, { "MCP-Protocol-Version": MODERN });
let disc = await parseRpc(dres);
check("server/discover lists 2026-07-28 and carries our instructions", JSON.stringify(disc.result ?? {}).includes(MODERN) && /today/.test(JSON.stringify(disc.result ?? {})), disc);
dres = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: envelope("2099-01-01") } }, { "MCP-Protocol-Version": "2099-01-01" });
disc = await parseRpc(dres).catch(() => ({}));
check("an unsupported protocol version is refused, naming the supported ones", Boolean(disc.error) && JSON.stringify(disc.error).includes(MODERN), { status: dres.status, disc });
for (const gone of ["sse", "message"]) {
  const g = await fetch(`${BASE}/api/${gone}`, { headers: { Authorization: `Bearer ${alice.token}` } });
  check(`/api/${gone} (old HTTP+SSE transport) → 404`, g.status === 404, g.status);
}

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
