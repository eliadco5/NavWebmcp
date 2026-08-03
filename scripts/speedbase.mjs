/**
 * speedbase: automation test-execution speed — Playwright UI test vs. in-process
 * function-call test, for the SAME business-logic scenarios. Not an agent or MCP
 * comparison (see scripts/bench.mjs for that) — this is a QA/test-architecture
 * argument: the Operation layer (lib/operations/) can be tested directly, in
 * milliseconds, with the exact same Zod validation + RBAC path a browser-driven E2E
 * test exercises, with none of the browser/network cost.
 *
 * Function side: tests/bench/operation-speed.test.ts, run as a child vitest process.
 *   That file times ONLY the runOne() calls internally (performance.now() around each
 *   call) and prints one `SPEEDBASE_RESULT {...}` JSON line — vitest's own
 *   process/reporter startup is deliberately excluded from the number, the same way a
 *   real unit-test suite amortizes runner startup across many tests rather than
 *   charging it to any one test.
 * Playwright side: this script launches a FRESH browser per iteration (login, goto,
 *   interact, close) — deliberately NOT amortized across iterations, because that's
 *   the real cost of running one browser-driven test in isolation (e.g. `npx
 *   playwright test book.spec.ts` on its own).
 *
 * Scenarios (reusing existing UI + operations — no new business logic added here):
 *   book         — booking form UI vs. runOne("book", ...)
 *   seatGuest    — front-desk check-in UI vs. runOne("seatGuest", ...)
 *   hostVipGuest — function-call only; no CRM UI exists in this app (documented, not
 *                  silently blank — same honesty pattern as the `vip` flow in
 *                  scripts/bench.mjs)
 *
 * Usage:
 *   node scripts/speedbase.mjs [--n=5] [--headed] [--slowmo=150] [--demo] [--verbose]
 *
 * Requires a running server (npm run build && npm start) for the Playwright side.
 */

import { performance } from "perf_hooks";
import { chromium } from "playwright";
import { spawn } from "node:child_process";

// ── CLI flags ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name, def) {
  const pfx = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(pfx));
  if (hit) return hit.slice(pfx.length);
  return argv.includes(`--${name}`) ? true : def;
}

const N = Math.max(1, Math.min(5, parseInt(flag("n", "5"), 10) || 5));
const HEADED = Boolean(flag("headed", false));
const SLOWMO = parseInt(flag("slowmo", "0"), 10) || 0;
const DEMO = Boolean(flag("demo", false));
const VERBOSE = Boolean(flag("verbose", false));

const BASE = process.env.BENCH_BASE ?? "http://localhost:3000";

function vlog(...args) { if (VERBOSE) console.log(...args); }

// ── Self-auth / startup (same helpers as scripts/bench.mjs) ─────────────────────

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
}

async function resetFrontOffice(adminCookie) {
  await fetch(`${BASE}/api/bench/reset`, { method: "POST", headers: { Cookie: adminCookie } });
}

// Booking: cancel every reservation as admin, which reopens each slot. Without this,
// repeated speedbase.mjs invocations reuse the exact same futureDate(i)/BOOKING_TIMES[i]
// slots and every run after the first collides with the previous run's bookings.
async function resetBooking(adminCookie) {
  const listRes = await fetch(`${BASE}/api/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ name: "listAllReservations", params: {} }),
  });
  const listBody = await listRes.json();
  if (!listBody.success) return;
  for (const r of listBody.data.reservations) {
    await fetch(`${BASE}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ name: "cancelAnyReservation", params: { reservationId: r.id, confirm: true } }),
    });
  }
}

function futureDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}
const BOOKING_TIMES = ["10:00", "12:00", "14:00", "18:00", "20:00"];

// ── Function-call side: spawn the vitest file, read its one JSON result line ───

function runFunctionCallBenchmark(n) {
  return new Promise((resolve, reject) => {
    // --reporter=verbose is required, not cosmetic: vitest's default reporter
    // suppresses console.log from passing tests, which would silently swallow the
    // SPEEDBASE_RESULT line below.
    vlog(`Spawning: npx vitest run tests/bench/operation-speed.test.ts --reporter=verbose (SPEEDBASE_N=${n})`);
    const child = spawn(
      "npx vitest run tests/bench/operation-speed.test.ts --reporter=verbose",
      { shell: true, cwd: process.cwd(), env: { ...process.env, SPEEDBASE_N: String(n) } }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (VERBOSE) { console.log(stdout); if (stderr) console.error(stderr); }
      const match = stdout.match(/SPEEDBASE_RESULT (.+)/);
      if (!match) {
        reject(new Error(
          `vitest child produced no SPEEDBASE_RESULT line (exit code ${code}). ` +
          (VERBOSE ? "" : "Re-run with --verbose to see its output.")
        ));
        return;
      }
      try {
        resolve(JSON.parse(match[1]));
      } catch (err) {
        reject(new Error(`failed to parse SPEEDBASE_RESULT JSON: ${err.message}`));
      }
    });
  });
}

// ── Playwright side: fresh browser per iteration, no amortization ──────────────
// Timing starts at page.goto (after browser launch + login), matching the
// methodology scripts/bench.mjs's lane D already uses — but here EACH iteration
// gets its own fresh browser+context+close, rather than one browser reused across
// N iterations, because the point of this comparison is "what does it cost to run
// ONE automated UI test", including its own launch overhead.

async function timedPlaywrightIteration(username, interact) {
  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO || undefined });
  try {
    const context = await browser.newContext();
    await context.request.post(`${BASE}/api/login`, {
      data: { username, password: "password" },
      headers: { "Content-Type": "application/json" },
    });
    const page = await context.newPage();
    const start = performance.now();
    await page.goto(`${BASE}/`);
    const success = await interact(page);
    const ms = performance.now() - start;
    return { ms, success };
  } finally {
    await browser.close();
  }
}

async function runPlaywrightBook(n) {
  const perRun = [];
  for (let i = 0; i < n; i++) {
    const date = futureDate(i);
    const time = BOOKING_TIMES[i % BOOKING_TIMES.length];
    const guestName = `Speedbase UI Guest ${i + 1}`;
    const result = await timedPlaywrightIteration("alice", async (page) => {
      await page.getByLabel("Date").fill(date);
      await page.getByLabel("Party Size").fill("2");
      await page.getByRole("button", { name: "Search" }).click();
      const row = page.locator("div", { hasText: time }).filter({ has: page.getByRole("button", { name: "Book" }) }).last();
      const bookInRow = row.getByRole("button", { name: "Book" });
      const rowVisible = await bookInRow.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
      if (!rowVisible) return false;
      await bookInRow.click();
      await page.getByLabel("Guest Name").fill(guestName);
      await page.getByRole("button", { name: "Confirm Booking" }).click();
      await page.getByLabel("Guest Name").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
      return true;
    });
    perRun.push(result);
  }
  return perRun;
}

async function runPlaywrightSeatGuest(n, adminCookie) {
  const perRun = [];
  for (let i = 0; i < n; i++) {
    // Fixture setup (arrange), not counted in the timed window — mirrors a real
    // suite's beforeEach, and matches how `book` above needs no reset because each
    // iteration already uses a distinct, never-before-booked slot.
    await resetFrontOffice(adminCookie);
    const result = await timedPlaywrightIteration("bob", async (page) => {
      const checkInBtn = page.getByRole("button", { name: /Check in Carol Diaz/i });
      const checkInVisible = await checkInBtn.waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false);
      if (!checkInVisible) return false;
      await checkInBtn.click();
      const viewBillBtn = page.getByRole("button", { name: /View bill for Carol Diaz/i });
      await viewBillBtn.waitFor({ state: "visible", timeout: 5000 });
      await viewBillBtn.click();
      const checkOutBtn = page.getByRole("button", { name: /Check out Carol Diaz/i });
      await checkOutBtn.waitFor({ state: "visible", timeout: 5000 });
      await checkOutBtn.click();
      const confirmBtn = page.getByRole("button", { name: "Confirm" });
      await confirmBtn.waitFor({ state: "visible", timeout: 5000 });
      await confirmBtn.click();
      await checkOutBtn.waitFor({ state: "hidden", timeout: 5000 });
      return true;
    });
    perRun.push(result);
  }
  return perRun;
}

function summarizePlaywright(perRun) {
  const okRuns = perRun.filter((r) => r.success);
  const avgMs = perRun.reduce((a, r) => a + r.ms, 0) / perRun.length;
  return { avgMs: Math.round(avgMs), successRate: `${okRuns.length}/${perRun.length}` };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function printTable(rows) {
  const cols = ["scenario", "functionMs", "functionSuccess", "playwrightMs", "playwrightSuccess", "speedup"];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "—").length)) + 2);
  const line = (vals) => vals.map((v, i) => String(v ?? "—").padStart(widths[i])).join(" ");
  console.log(line(cols));
  console.log(line(cols.map((c) => "-".repeat(c.length))));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

async function writeOutputs(rows) {
  const fs = await import("fs");
  const path = await import("path");
  const outDir = path.resolve(process.cwd(), "docs");
  const payload = { generatedAt: null, n: N, rows };
  fs.writeFileSync(path.join(outDir, "speedbase-results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "speedbase-data.js"), `window.SPEEDBASE = ${JSON.stringify(payload, null, 2)};\n`);
  console.log(`\nWrote docs/speedbase-results.json and docs/speedbase-data.js`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await assertServerUp();
  const bob = await login("bob");
  await resetBooking(bob.cookie);
  await resetFrontOffice(bob.cookie);

  console.log("Running function-call benchmark (vitest, in-process, no transport)...");
  const fn = await runFunctionCallBenchmark(N);

  console.log("Running Playwright UI benchmark (fresh browser per iteration)...");
  const pwBook = summarizePlaywright(await runPlaywrightBook(N));
  await resetBooking(bob.cookie);
  const pwSeatGuest = summarizePlaywright(await runPlaywrightSeatGuest(N, bob.cookie));

  const rows = [
    {
      scenario: "book",
      functionMs: Math.round(fn.book.avgMs * 100) / 100,
      functionSuccess: fn.book.successRate,
      playwrightMs: pwBook.avgMs,
      playwrightSuccess: pwBook.successRate,
      speedup: `${Math.round(pwBook.avgMs / fn.book.avgMs)}x`,
    },
    {
      scenario: "seatGuest",
      functionMs: Math.round(fn.seatGuest.avgMs * 100) / 100,
      functionSuccess: fn.seatGuest.successRate,
      playwrightMs: pwSeatGuest.avgMs,
      playwrightSuccess: pwSeatGuest.successRate,
      speedup: `${Math.round(pwSeatGuest.avgMs / fn.seatGuest.avgMs)}x`,
    },
    {
      scenario: "hostVipGuest",
      functionMs: Math.round(fn.hostVipGuest.avgMs * 100) / 100,
      functionSuccess: fn.hostVipGuest.successRate,
      playwrightMs: "—",
      playwrightSuccess: "no UI exists",
      speedup: "—",
    },
  ];

  console.log();
  printTable(rows);

  if (!DEMO) {
    await writeOutputs(rows);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
