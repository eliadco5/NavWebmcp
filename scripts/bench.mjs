/**
 * NavWebMcp lecture benchmark: 4 lanes over 4 flows, all against a running server.
 *
 *   Lane A-native — real MCP: load_tools([...]) once, then N native tools/call.
 *   Lane A-invoke — real MCP: N x invoke({name,args}), no load step.
 *   Lane B        — real MCP: load_tools([...composite]) then 1 (or a few) tools/call.
 *   Lane C        — real browser: document.modelContext.executeTool(...) (WebMCP).
 *   Lane D        — real browser: Playwright drives the actual UI, click by click.
 *
 * Flows:
 *   booking — search availability, book a table (`book` composite op).
 *   checkin — front-desk seating (`seatGuest` composite op).
 *   journey — one session, two independent receptionist actions: book() then
 *             seatGuest() (see FLOW_DEFS.journey — these are disjoint stores, this is
 *             NOT "seat the guest just booked"). Lane B/C make 2 composite calls.
 *   vip     — 7-call chain across CRM + front desk (`hostVipGuest` composite op).
 *             No lane D — CRM has no screens in this app.
 *
 * Why not /api/call or a Node-side simulation (see benchmark.mjs)? Because "regular
 * MCP" only means something if it goes over the real MCP Streamable HTTP transport,
 * and "WebMCP" only means something if it runs in a real browser. This harness
 * measures both directly instead of estimating them.
 *
 * Usage:
 *   node scripts/bench.mjs [--flow=booking,checkin,journey,vip] [--lane=a,b,c,d] [--n=5]
 *                          [--headed] [--slowmo=250] [--demo] [--dev] [--verbose]
 *
 * Requires a running server (npm run build && npm start, or --dev against `npm run dev`).
 */

import { performance } from "perf_hooks";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ── CLI flags ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name, def) {
  const pfx = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(pfx));
  if (hit) return hit.slice(pfx.length);
  return argv.includes(`--${name}`) ? true : def;
}

const FLOWS = String(flag("flow", "booking,checkin,journey,vip")).split(",").filter(Boolean);
const LANES = String(flag("lane", "a,b,c,d")).split(",").filter(Boolean);
const N = Math.max(1, Math.min(5, parseInt(flag("n", "5"), 10) || 5));
const HEADED = Boolean(flag("headed", false));
const SLOWMO = parseInt(flag("slowmo", "0"), 10) || 0;
const DEMO = Boolean(flag("demo", false));
const DEV = Boolean(flag("dev", false));
const VERBOSE = Boolean(flag("verbose", false));

const BASE = process.env.BENCH_BASE ?? "http://localhost:3000";

function log(...args) { console.log(...args); }
function vlog(...args) { if (VERBOSE) console.log(...args); }

// ── Token model ──────────────────────────────────────────────────────────────────

const TOKEN_MODEL = "chars/4";
function estimateTokens(value) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

// ── Self-auth ──────────────────────────────────────────────────────────────────
// One /api/login gives both the session cookie (for /api/call and the browser lanes)
// and the agent bearer token (for real MCP) — no DevTools copy-paste required.

async function login(username, password = "password") {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.success) throw new Error(`login failed for ${username}: ${body.error?.message}`);
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean);
  const cookieHeader = setCookie.map((c) => c.split(";")[0]).join("; ");
  return { agentToken: body.agentToken, cookie: cookieHeader, user: body.user };
}

// ── Startup assertions ─────────────────────────────────────────────────────────

async function assertServerUp() {
  let res;
  try {
    res = await fetch(BASE);
  } catch (err) {
    console.error(`Cannot reach ${BASE} — is the server running? (${err.message})`);
    process.exit(1);
  }
  if (!res.ok && res.status !== 307 && res.status !== 308) {
    console.error(`${BASE} responded with HTTP ${res.status} — expected the app to be up.`);
    process.exit(1);
  }
  if (DEV) {
    console.log("\n  ⚠ --dev mode: timings are NOT FOR PUBLICATION (Next.js dev-mode compiles on first hit).\n");
  }
}

// ── Store reset between lanes ───────────────────────────────────────────────────
// Booking slots (35 total) and the front-office reservations are shared, finite,
// in-memory resources. Re-running lanes without cleanup exhausts them.

async function resetStores(adminCookie) {
  // Booking: cancel every reservation as admin, which reopens each slot.
  const listRes = await fetch(`${BASE}/api/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ name: "listAllReservations", params: {} }),
  });
  const listBody = await listRes.json();
  if (listBody.success) {
    for (const r of listBody.data.reservations) {
      await fetch(`${BASE}/api/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ name: "cancelAnyReservation", params: { reservationId: r.id, confirm: true } }),
      });
    }
  }

  await resetFrontOffice(adminCookie);
}

// Front office only — cheaper than resetStores(), used between iterations within a
// single lane run for the checkin flow (res_003 is the only reservation that fits an
// available table, so every iteration needs it back to "pending" before it runs).
async function resetFrontOffice(adminCookie) {
  await fetch(`${BASE}/api/bench/reset`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });
}

// ── MCP client helper (real Streamable HTTP transport) ─────────────────────────
// Wraps fetch to count HTTP calls and bytes for this client, rather than assuming
// them — the same transport an external agent would use.

function makeCountingFetch() {
  const stats = { calls: 0, requestBytes: 0, responseBytes: 0 };
  const countingFetch = async (url, init) => {
    stats.calls += 1;
    if (init?.body) stats.requestBytes += Buffer.byteLength(String(init.body));
    const res = await fetch(url, init);
    const clone = res.clone();
    const text = await clone.text();
    stats.responseBytes += Buffer.byteLength(text);
    return res;
  };
  return { countingFetch, stats };
}

async function connectMcpClient(bearerToken) {
  const { countingFetch, stats } = makeCountingFetch();
  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE}/api/mcp`),
    {
      requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
      fetch: countingFetch,
    }
  );
  const client = new Client({ name: "lecture-bench", version: "1.0.0" });
  const connectStart = performance.now();
  await client.connect(transport);
  const connectMs = performance.now() - connectStart;
  return { client, stats, connectMs };
}

function mcpResultTokens(mcpResult) {
  // MCP tool results carry { content: [{ type: "text", text: "<pretty-printed JSON>" }] }.
  // The pretty-print whitespace is real wire cost the agent pays — measured as-is.
  const text = mcpResult?.content?.map((c) => c.text ?? "").join("") ?? "";
  return Math.ceil(text.length / 4);
}

// ── Flow definitions ─────────────────────────────────────────────────────────
// Each flow supplies: the 2-4 primitive ops for lane A, the composite op name for
// lane B/C, and the args generator per-iteration (so 5 iterations use 5 disjoint
// bookings / reservations rather than colliding on the same row).

function futureDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

const BOOKING_TIMES = ["10:00", "12:00", "14:00", "18:00", "20:00"];

// Extracted to standalone functions (rather than inline in FLOW_DEFS.booking/checkin)
// so `journey` below can chain them without a self-referencing object literal.
async function bookingPrimitiveSteps(input, callTool, acc) {
  const avail = await callTool("searchAvailability", { date: input.date, partySize: input.partySize });
  acc.push(avail);
  const slots = avail.data?.slots ?? [];
  const slot = slots.find((s) => s.time === input.time);
  if (!slot) return null;
  const create = await callTool("createReservation", { slotId: slot.id, name: input.name, partySize: input.partySize });
  acc.push(create);
  if (!create.data?.reservation) return null;
  const got = await callTool("getReservation", { reservationId: create.data.reservation.id });
  acc.push(got);
  return got;
}

async function checkinPrimitiveSteps(input, callTool, acc) {
  const occ = await callTool("getOccupancy", {});
  acc.push(occ);
  const checkin = await callTool("checkInGuest", { reservationId: input.reservationId });
  acc.push(checkin);
  if (!checkin.data) return null;
  const status = await callTool("getCheckinStatus", { reservationId: input.reservationId });
  acc.push(status);
  return status;
}

const FLOW_DEFS = {
  booking: {
    label: "Book a table",
    role: "customer",
    primitiveOps: ["searchAvailability", "createReservation", "getReservation"],
    compositeOp: "book",
    iterationInput(i) {
      // Distinct (date, time) pairs so the 5 iterations don't collide on one slot.
      return { date: futureDate(i), time: BOOKING_TIMES[i % BOOKING_TIMES.length], partySize: 2, name: `Bench Guest ${i + 1}` };
    },
    primitiveSteps: bookingPrimitiveSteps,
  },
  checkin: {
    label: "Seat a guest (front desk)",
    role: "admin",
    primitiveOps: ["getOccupancy", "checkInGuest", "getCheckinStatus"],
    compositeOp: "seatGuest",
    // Only res_003 (partySize 3) fits an available table given the seeded tables, so
    // every iteration reuses the same reservation id — that's the flow's real
    // constraint. resetBetweenIterations=true tells each lane runner to put it back
    // to "pending" before every iteration, not just once per lane.
    resetBetweenIterations: true,
    iterationInput() {
      return { reservationId: "res_003" };
    },
    primitiveSteps: checkinPrimitiveSteps,
  },
  // Two independent receptionist actions in one session: book a phone-in reservation,
  // then separately seat the walk-in already waiting at the desk. NOT "seat the guest
  // just booked" — book() (lib/store.ts) and seatGuest() (the frontoffice store) are
  // disjoint, unlinked data stores with no shared id. compositeOps (plural) reflects
  // that lane B/C make TWO composite calls here, not one.
  journey: {
    label: "Book + seat a guest (receptionist session)",
    role: "admin",
    primitiveOps: ["searchAvailability", "createReservation", "getReservation", "getOccupancy", "checkInGuest", "getCheckinStatus"],
    compositeOps: ["book", "seatGuest"],
    resetBetweenIterations: true,
    iterationInput(i) {
      return {
        booking: { date: futureDate(i), time: BOOKING_TIMES[i % BOOKING_TIMES.length], partySize: 2, name: `Journey Guest ${i + 1}` },
        checkin: { reservationId: "res_003" },
      };
    },
    async primitiveSteps(input, callTool, acc) {
      const bookingResult = await bookingPrimitiveSteps(input.booking, callTool, acc);
      if (!bookingResult) return null;
      return checkinPrimitiveSteps(input.checkin, callTool, acc);
    },
    async compositeSteps(input, callComposite) {
      await callComposite("book", input.booking);
      await callComposite("seatGuest", input.checkin);
    },
  },
  // Seven calls across two domains (CRM + front desk) contrasted against one op. No
  // lane D — CRM has no UI screens in this app, and building one is out of scope.
  vip: {
    label: "Host a VIP guest (CRM + front desk, no UI lane)",
    role: "admin",
    noLaneD: "CRM has no UI screens in this app",
    primitiveOps: ["getGuestPreferences", "getLoyaltyStatus", "getOccupancy", "checkInGuest", "getCheckinStatus", "addLoyaltyPoints", "logCommunication"],
    compositeOp: "hostVipGuest",
    // res_003 / g_003 is the only seeded pairing where the reservation fits an
    // available table AND the guest has seeded loyalty + preferences (see
    // hostVipGuest-op.test.ts for the CRM/frontoffice naming quirk on g_003).
    // Loyalty points accumulate across repeated runs — cosmetic only, not reset.
    resetBetweenIterations: true,
    iterationInput(i) {
      return { reservationId: "res_003", guestId: "g_003", pointsToAward: 100, visitNote: `VIP visit note ${i + 1}` };
    },
    async primitiveSteps(input, callTool, acc) {
      acc.push(await callTool("getGuestPreferences", { guestId: input.guestId }));
      acc.push(await callTool("getLoyaltyStatus", { guestId: input.guestId }));
      acc.push(await callTool("getOccupancy", {}));
      const checkin = await callTool("checkInGuest", { reservationId: input.reservationId });
      acc.push(checkin);
      if (!checkin.data) return null;
      const status = await callTool("getCheckinStatus", { reservationId: input.reservationId });
      acc.push(status);
      if (status.data?.status !== "checked-in") return null;
      acc.push(await callTool("addLoyaltyPoints", { guestId: input.guestId, points: input.pointsToAward, reason: input.visitNote }));
      const log = await callTool("logCommunication", { guestId: input.guestId, type: "note", subject: "VIP visit hosted", body: input.visitNote });
      acc.push(log);
      return log;
    },
  },
};

// ── Lane A-native: load_tools once, then N native tools/call ───────────────────

async function laneANative(flow, bearerToken, n, adminCookie) {
  const def = FLOW_DEFS[flow];
  const { client, stats } = await connectMcpClient(bearerToken);

  const loadResult = await client.callTool({ name: "load_tools", arguments: { names: def.primitiveOps } });
  const loadTaxTokens = mcpResultTokens(loadResult);

  const perRun = [];
  for (let i = 0; i < n; i++) {
    if (i > 0 && def.resetBetweenIterations) await resetFrontOffice(adminCookie);
    const input = def.iterationInput(i);
    const runTokens = { input: 0, output: 0 };
    const start = performance.now();
    let success = true;
    const acc = [];
    const callTool = async (name, args) => {
      runTokens.input += estimateTokens({ name, arguments: args });
      const res = await client.callTool({ name, arguments: args });
      runTokens.output += mcpResultTokens(res);
      const text = res.content?.[0]?.text ?? "{}";
      let data;
      try { data = JSON.parse(text); } catch { data = {}; }
      if (res.isError) success = false;
      return { data, isError: !!res.isError };
    };
    const finalRes = await def.primitiveSteps(input, callTool, acc);
    if (!finalRes) success = false;
    const ms = performance.now() - start;
    perRun.push({ ms, calls: acc.length, inputTokens: runTokens.input, outputTokens: runTokens.output, success });
  }

  await client.close();
  return { lane: "A-native", toolSchemaTaxTokens: loadTaxTokens, httpCalls: stats.calls, runs: perRun };
}

// ── Lane A-invoke: N x invoke({name,args}), no load step ────────────────────────

async function laneAInvoke(flow, bearerToken, n, adminCookie) {
  const def = FLOW_DEFS[flow];
  const { client, stats } = await connectMcpClient(bearerToken);

  const perRun = [];
  for (let i = 0; i < n; i++) {
    if (i > 0 && def.resetBetweenIterations) await resetFrontOffice(adminCookie);
    const input = def.iterationInput(i);
    const runTokens = { input: 0, output: 0 };
    const start = performance.now();
    let success = true;
    const acc = [];
    const callTool = async (name, args) => {
      const invokeArgs = { name, args };
      runTokens.input += estimateTokens(invokeArgs);
      const res = await client.callTool({ name: "invoke", arguments: invokeArgs });
      runTokens.output += mcpResultTokens(res);
      const text = res.content?.[0]?.text ?? "{}";
      let outer;
      try { outer = JSON.parse(text); } catch { outer = {}; }
      const data = outer?.data ?? outer;
      if (res.isError || outer?.success === false) success = false;
      return { data, isError: res.isError || outer?.success === false };
    };
    const finalRes = await def.primitiveSteps(input, callTool, acc);
    if (!finalRes) success = false;
    const ms = performance.now() - start;
    perRun.push({ ms, calls: acc.length, inputTokens: runTokens.input, outputTokens: runTokens.output, success });
  }

  await client.close();
  return { lane: "A-invoke", toolSchemaTaxTokens: 0, httpCalls: stats.calls, runs: perRun };
}

// ── Lane B: load_tools([composite]) then one tools/call ────────────────────────

// Flows with a single compositeOp call it once; `journey` overrides compositeSteps to
// call `book` then `seatGuest` — two real-world actions, not one op standing in for both.
function defaultCompositeSteps(compositeOp) {
  return async (input, callComposite) => {
    await callComposite(compositeOp, input);
  };
}

async function laneB(flow, bearerToken, n, adminCookie) {
  const def = FLOW_DEFS[flow];
  const compositeNames = def.compositeOps ?? [def.compositeOp];
  const runCompositeSteps = def.compositeSteps ?? defaultCompositeSteps(def.compositeOp);
  const { client, stats } = await connectMcpClient(bearerToken);

  const loadResult = await client.callTool({ name: "load_tools", arguments: { names: compositeNames } });
  const loadTaxTokens = mcpResultTokens(loadResult);

  const perRun = [];
  for (let i = 0; i < n; i++) {
    if (i > 0 && def.resetBetweenIterations) await resetFrontOffice(adminCookie);
    const input = def.iterationInput(i);
    const calls = { count: 0 };
    const tokens = { input: 0, output: 0 };
    let success = true;
    const start = performance.now();
    const callComposite = async (name, args) => {
      calls.count += 1;
      const res = await client.callTool({ name, arguments: args });
      tokens.input += estimateTokens({ name, arguments: args });
      tokens.output += mcpResultTokens(res);
      if (res.isError) success = false;
      return res;
    };
    await runCompositeSteps(input, callComposite);
    const ms = performance.now() - start;
    perRun.push({ ms, calls: calls.count, inputTokens: tokens.input, outputTokens: tokens.output, success });
  }

  await client.close();
  return { lane: "B", toolSchemaTaxTokens: loadTaxTokens, httpCalls: stats.calls, runs: perRun };
}

// ── Browser lanes (C, D) ─────────────────────────────────────────────────────

async function withBrowserContext(loginInfo, fn) {
  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO || undefined });
  const context = await browser.newContext();
  await context.request.post(`${BASE}/api/login`, {
    data: { username: loginInfo.username, password: "password" },
    headers: { "Content-Type": "application/json" },
  });
  const page = await context.newPage();
  const inPageCalls = { count: 0 };
  page.on("request", (req) => {
    if (req.url().includes("/api/call")) inPageCalls.count += 1;
  });
  await page.goto(`${BASE}/`);
  try {
    return await fn(page, inPageCalls);
  } finally {
    await browser.close();
  }
}

// Lane C: call the real WebMCP surface (document.modelContext.executeTool), the same
// entry point a browser-side MCP client would use — not window.bookTool.
async function laneC(flow, loginInfo, n, adminCookie) {
  const def = FLOW_DEFS[flow];
  const compositeNames = def.compositeOps ?? [def.compositeOp];
  const runCompositeSteps = def.compositeSteps ?? defaultCompositeSteps(def.compositeOp);
  return withBrowserContext(loginInfo, async (page, inPageCalls) => {
    await page.waitForFunction(
      (toolNames) => toolNames.every((n) => !!document.modelContext?.getTools?.().some((t) => t.name === n)),
      compositeNames,
      { timeout: 15000 }
    );

    const perRun = [];
    for (let i = 0; i < n; i++) {
      if (i > 0 && def.resetBetweenIterations) await resetFrontOffice(adminCookie);
      const input = def.iterationInput(i);
      inPageCalls.count = 0;
      const tokens = { input: 0, output: 0 };
      let success = true;
      const start = performance.now();
      const callComposite = async (toolName, args) => {
        const result = await page.evaluate(
          ([name, a]) => document.modelContext.executeTool(name, a),
          [toolName, args]
        );
        tokens.input += estimateTokens(args);
        tokens.output += estimateTokens(result);
        if (!result?.success) success = false;
        return result;
      };
      await runCompositeSteps(input, callComposite);
      const ms = performance.now() - start;
      perRun.push({ ms, calls: inPageCalls.count, inputTokens: tokens.input, outputTokens: tokens.output, success });
    }
    return { lane: "C", toolSchemaTaxTokens: 0, httpCalls: 0, runs: perRun };
  });
}

// Lane D: drive the real UI, click by click. Selectors confirmed against
// components/BookingApp.tsx, AvailabilityList.tsx, and FrontDeskPanel.tsx.

async function captureObservation(page) {
  const [aria, outerHtmlLen] = await Promise.all([
    page.locator("body").ariaSnapshot(),
    page.evaluate(() => document.body.outerHTML.length),
  ]);
  const accessibilitySnapshot = await page.accessibility.snapshot();
  return {
    ariaTokens: estimateTokens(aria),
    accessibilityTokens: estimateTokens(accessibilitySnapshot),
    outerHtmlTokens: Math.ceil(outerHtmlLen / 4),
  };
}

function sumObservationTokens(steps) {
  return steps.reduce(
    (acc, s) => ({
      ariaTokens: acc.ariaTokens + s.ariaTokens,
      accessibilityTokens: acc.accessibilityTokens + s.accessibilityTokens,
      outerHtmlTokens: acc.outerHtmlTokens + s.outerHtmlTokens,
    }),
    { ariaTokens: 0, accessibilityTokens: 0, outerHtmlTokens: 0 }
  );
}

// Drives the booking form for one iteration, appending an observation snapshot after
// every interaction to `steps`. Shared by laneDBooking and laneDJourney so the two
// don't drift out of sync on selectors.
async function runBookingUiSteps(page, { date, time, guestName }, steps) {
  steps.push(await captureObservation(page));
  await page.getByLabel("Date").fill(date);
  steps.push(await captureObservation(page));
  await page.getByLabel("Party Size").fill("2");
  steps.push(await captureObservation(page));
  await page.getByRole("button", { name: "Search" }).click();

  const row = page.locator("div", { hasText: time }).filter({ has: page.getByRole("button", { name: "Book" }) }).last();
  const bookInRow = row.getByRole("button", { name: "Book" });
  // waitFor(), not count()/isVisible() — those check immediately and race the
  // async searchAvailability fetch triggered by the Search click above.
  const rowVisible = await bookInRow
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  steps.push(await captureObservation(page));

  if (!rowVisible) return false;
  await bookInRow.click();
  steps.push(await captureObservation(page));
  await page.getByLabel("Guest Name").fill(guestName);
  steps.push(await captureObservation(page));
  await page.getByRole("button", { name: "Confirm Booking" }).click();
  await page.getByLabel("Guest Name").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  steps.push(await captureObservation(page));
  return true;
}

// Drives the front-desk check-in→bill→checkout for one iteration on res_003 (Carol
// Diaz), appending an observation snapshot after every interaction to `steps`. Shared
// by laneDCheckin and laneDJourney.
async function runCheckinUiSteps(page, steps, iterLabel) {
  const checkInBtn = page.getByRole("button", { name: /Check in Carol Diaz/i });
  // isVisible() checks immediately and does NOT wait despite taking a `timeout`
  // option (that only bounds internal actionability checks) — waitFor() is the
  // real wait. Without this the first iteration races the panel's initial
  // getOccupancy/listFrontDeskReservations fetch after page.goto()/reload().
  const checkInVisible = await checkInBtn
    .waitFor({ state: "visible", timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!checkInVisible) {
    if (VERBOSE) {
      const buttons = await page.getByRole("button").allTextContents().catch(() => []);
      vlog(`  [lane D checkin] ${iterLabel}: "Check in Carol Diaz" not visible. Buttons on page:`, buttons);
    }
    return false;
  }

  await checkInBtn.click();
  const viewBillBtn = page.getByRole("button", { name: /View bill for Carol Diaz/i });
  await viewBillBtn.waitFor({ state: "visible", timeout: 5000 });
  steps.push(await captureObservation(page));

  await viewBillBtn.click();
  const checkOutBtn = page.getByRole("button", { name: /Check out Carol Diaz/i });
  await checkOutBtn.waitFor({ state: "visible", timeout: 5000 });
  steps.push(await captureObservation(page));

  await checkOutBtn.click();
  // checkOutGuest requires confirmation — approve the dialog the same way a human
  // would. The dialog mounts after a React state update, not synchronously with
  // the click, so wait for it rather than assuming it's already there.
  const confirmBtn = page.getByRole("button", { name: "Confirm" });
  await confirmBtn.waitFor({ state: "visible", timeout: 5000 });
  await confirmBtn.click();
  await checkOutBtn.waitFor({ state: "hidden", timeout: 5000 });
  steps.push(await captureObservation(page));
  return true;
}

async function laneDBooking(loginInfo, n) {
  return withBrowserContext(loginInfo, async (page, inPageCalls) => {
    const perRun = [];
    for (let i = 0; i < n; i++) {
      // resetStores() runs before this lane, reopening every slot, so it's safe to reuse
      // the same (date, time) pattern as the other lanes — seedSlots() only covers 7 days.
      const date = futureDate(i);
      const time = BOOKING_TIMES[i % BOOKING_TIMES.length];
      const guestName = `UI Guest ${i + 1}`;
      inPageCalls.count = 0;
      const steps = [];
      const start = performance.now();

      const success = await runBookingUiSteps(page, { date, time, guestName }, steps);

      const ms = performance.now() - start;
      perRun.push({ ms, calls: inPageCalls.count, steps: steps.length, observationTokens: sumObservationTokens(steps), success });
    }
    return { lane: "D", toolSchemaTaxTokens: 0, httpCalls: 0, runs: perRun };
  });
}

async function laneDCheckin(n) {
  return withBrowserContext({ username: "bob" }, async (page, inPageCalls) => {
    const perRun = [];
    for (let i = 0; i < n; i++) {
      inPageCalls.count = 0;
      const steps = [];
      const start = performance.now();

      steps.push(await captureObservation(page));
      const success = await runCheckinUiSteps(page, steps, `iter ${i}`);

      const ms = performance.now() - start;
      perRun.push({ ms, calls: inPageCalls.count, steps: steps.length, observationTokens: sumObservationTokens(steps), success });

      if (i < n - 1) {
        // Reset front-office store between UI iterations. This mutates server state
        // directly (outside React's data flow) and front-office ops emit no SSE
        // events, so the page must reload to see the restored "pending" reservation.
        await page.request.post(`${BASE}/api/bench/reset`);
        await page.reload();
        await page.getByRole("button", { name: /Check in Carol Diaz/i }).waitFor({ state: "visible", timeout: 10000 });
      }
    }
    return { lane: "D", toolSchemaTaxTokens: 0, httpCalls: 0, runs: perRun };
  });
}

// One continuous session: book a phone-in reservation, then — on the same page, no
// reload — seat the walk-in already waiting at the desk. Two independent receptionist
// actions, not "seat the guest just booked" (book() and seatGuest() run on disjoint
// stores; see FLOW_DEFS.journey comment). This is what makes the DOM-tax number
// larger than either flow alone: roughly booking's steps plus checkin's steps.
async function laneDJourney(n) {
  return withBrowserContext({ username: "bob" }, async (page, inPageCalls) => {
    const perRun = [];
    for (let i = 0; i < n; i++) {
      const date = futureDate(i);
      const time = BOOKING_TIMES[i % BOOKING_TIMES.length];
      const guestName = `Journey Guest ${i + 1}`;
      inPageCalls.count = 0;
      const steps = [];
      const start = performance.now();

      const bookingOk = await runBookingUiSteps(page, { date, time, guestName }, steps);
      const checkinOk = await runCheckinUiSteps(page, steps, `journey iter ${i}`);

      const ms = performance.now() - start;
      perRun.push({
        ms,
        calls: inPageCalls.count,
        steps: steps.length,
        observationTokens: sumObservationTokens(steps),
        success: bookingOk && checkinOk,
      });

      if (i < n - 1) {
        // Same reload requirement as laneDCheckin — front-office writes emit no SSE.
        await page.request.post(`${BASE}/api/bench/reset`);
        await page.reload();
        await page.getByRole("button", { name: /Check in Carol Diaz/i }).waitFor({ state: "visible", timeout: 10000 });
      }
    }
    return { lane: "D", toolSchemaTaxTokens: 0, httpCalls: 0, runs: perRun };
  });
}

// ── Reporting ────────────────────────────────────────────────────────────────

function summarize(laneResult) {
  const { runs } = laneResult;
  const okRuns = runs.filter((r) => r.success);
  const avgMs = runs.reduce((a, r) => a + r.ms, 0) / runs.length;
  const avgInput = runs.reduce((a, r) => a + (r.inputTokens ?? 0), 0) / runs.length;
  const avgOutput = runs.reduce((a, r) => a + (r.outputTokens ?? 0), 0) / runs.length;
  const avgObservation = runs.reduce((a, r) => a + (r.observationTokens?.ariaTokens ?? 0), 0) / runs.length;
  return {
    lane: laneResult.lane,
    successRate: `${okRuns.length}/${runs.length}`,
    avgMs: Math.round(avgMs),
    httpCalls: laneResult.httpCalls,
    toolSchemaTaxTokens: laneResult.toolSchemaTaxTokens,
    avgInputTokens: Math.round(avgInput),
    avgOutputTokens: Math.round(avgOutput),
    avgObservationTokens: Math.round(avgObservation),
  };
}

function printTable(rows) {
  const cols = ["lane", "successRate", "avgMs", "httpCalls", "toolSchemaTaxTokens", "avgInputTokens", "avgOutputTokens", "avgObservationTokens"];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)) + 2);
  const line = (vals) => vals.map((v, i) => String(v).padStart(widths[i])).join(" ");
  console.log(line(cols));
  console.log(line(cols.map((c) => "-".repeat(c.length))));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await assertServerUp();

  const alice = await login("alice"); // customer
  const bob = await login("bob");     // admin

  const allResults = {};

  for (const flow of FLOWS) {
    const def = FLOW_DEFS[flow];
    if (!def) { console.error(`Unknown flow "${flow}" — expected one of ${Object.keys(FLOW_DEFS).join(", ")}`); continue; }

    console.log(`\n${"=".repeat(70)}\nFLOW: ${flow} — ${def.label}\n${"=".repeat(70)}`);

    const loginInfo = def.role === "admin" ? { ...bob, username: "bob" } : { ...alice, username: "alice" };
    const bearerToken = loginInfo.agentToken;

    await resetStores(bob.cookie);

    const rows = [];
    for (const lane of LANES) {
      let result;
      vlog(`Running lane ${lane} for flow ${flow}...`);
      if (lane === "a") {
        result = await laneANative(flow, bearerToken, N, bob.cookie);
        rows.push(summarize(result));
        await resetStores(bob.cookie);
        const invokeResult = await laneAInvoke(flow, bearerToken, N, bob.cookie);
        rows.push(summarize(invokeResult));
        await resetStores(bob.cookie);
      } else if (lane === "b") {
        result = await laneB(flow, bearerToken, N, bob.cookie);
        rows.push(summarize(result));
        await resetStores(bob.cookie);
      } else if (lane === "c") {
        result = await laneC(flow, loginInfo, N, bob.cookie);
        rows.push(summarize(result));
        await resetStores(bob.cookie);
      } else if (lane === "d") {
        if (def.noLaneD) {
          vlog(`  Skipping lane D for "${flow}" — ${def.noLaneD}`);
          continue;
        }
        if (flow === "booking") result = await laneDBooking(loginInfo, N);
        else if (flow === "journey") result = await laneDJourney(N);
        else result = await laneDCheckin(N);
        rows.push(summarize(result));
        await resetStores(bob.cookie);
      } else {
        console.error(`Unknown lane "${lane}" — expected one of a, b, c, d`);
        continue;
      }
      if (VERBOSE) console.log(JSON.stringify(result, null, 2));
    }

    printTable(rows);
    allResults[flow] = rows;
  }

  if (!DEMO) {
    await writeBenchOutputs(allResults);
  }
}

async function writeBenchOutputs(allResults) {
  const fs = await import("fs");
  const path = await import("path");
  const outDir = path.resolve(process.cwd(), "docs");
  const payload = { generatedAt: null, tokenModel: TOKEN_MODEL, buildMode: DEV ? "dev" : "prod", n: N, results: allResults };
  fs.writeFileSync(path.join(outDir, "bench-results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "bench-data.js"), `window.BENCH = ${JSON.stringify(payload, null, 2)};\n`);
  console.log(`\nWrote docs/bench-results.json and docs/bench-data.js`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
