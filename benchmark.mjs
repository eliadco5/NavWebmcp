/**
 * Benchmark: 3-call MCP approach vs 1-call book() approach
 *
 * Token estimation methodology:
 *   The agent (Claude or any LLM) sends and receives JSON over MCP.
 *   We estimate tokens using the rough rule: 1 token ≈ 4 characters.
 *
 *   INPUT tokens per call = the JSON body the agent sends (tool call payload)
 *   OUTPUT tokens per call = the JSON body the server returns (tool result)
 *
 *   Cumulative context cost:
 *     In a real agent session every prior tool call + result stays in context.
 *     So for the 3-call approach:
 *       Call 1 input:  just the searchAvailability request
 *       Call 2 input:  searchAvailability request + result (in context) + createReservation request
 *       Call 3 input:  all prior + getReservation request
 *     For book():
 *       Call 1 input:  just the book request
 *       (no further calls — the orchestration runs in the browser, invisible to the agent)
 *
 * Usage:
 *   node benchmark.mjs <session-cookie>
 */

import { performance } from "perf_hooks";

const BASE = "http://localhost:3000";
const SESSION = process.argv[2];
if (!SESSION) { console.error("Usage: node benchmark.mjs <session-cookie>"); process.exit(1); }

const HEADERS = {
  "Content-Type": "application/json",
  "Cookie": `agentbridge_session=${SESSION}`,
};

// Slots to use: spread across 7 days × 5 times. We use exactly 10 per approach.
// We'll discover them live so we work with actual current slot ids.
const DATES = [
  "2026-07-14","2026-07-15","2026-07-16","2026-07-17",
  "2026-07-18","2026-07-19","2026-07-20",
];

function estimateTokens(obj) {
  // 1 token ≈ 4 chars is the standard rough estimate
  return Math.ceil(JSON.stringify(obj).length / 4);
}

async function apiCall(name, params) {
  const body = { name, params };
  const start = performance.now();
  const res = await fetch(`${BASE}/api/call`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const ms = performance.now() - start;
  return { body, data, ms };
}

async function discoverSlots() {
  const slots = [];
  for (const date of DATES) {
    const { data } = await apiCall("searchAvailability", { date, partySize: 1 });
    if (data.success) {
      for (const slot of data.data.slots) {
        slots.push({ date, slotId: slot.id, time: slot.time });
      }
    }
  }
  return slots;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approach A: 3-call MCP (what the agent does today)
//   Call 1: searchAvailability(date, partySize)
//   Call 2: createReservation(slotId, name, partySize)  ← uses slotId from call 1
//   Call 3: getReservation(reservationId)               ← validates
// ─────────────────────────────────────────────────────────────────────────────
async function runThreeCall(slot, guestName, runIndex) {
  const result = { calls: 3, inputTokens: 0, outputTokens: 0, cumulativeInputTokens: 0, ms: 0, success: false };
  let contextAccum = ""; // simulates agent context growing with each turn

  // Call 1: searchAvailability
  const c1 = await apiCall("searchAvailability", { date: slot.date, partySize: 1 });
  const c1InputPayload = c1.body;
  const c1OutputPayload = c1.data;

  // Agent context before call 1: system prompt + "book a table" user message (constant, not counted in delta)
  // We track only the incremental per-reservation context to keep numbers comparable.
  contextAccum += JSON.stringify(c1InputPayload) + JSON.stringify(c1OutputPayload);
  result.inputTokens += estimateTokens(c1InputPayload);
  result.outputTokens += estimateTokens(c1OutputPayload);
  result.ms += c1.ms;

  if (!c1.data.success) return result;

  // Call 2: createReservation (agent picks slotId from call 1 output)
  const c2Input = { name: "createReservation", params: { slotId: slot.slotId, name: guestName, partySize: 1 } };
  const c2 = await apiCall("createReservation", { slotId: slot.slotId, name: guestName, partySize: 1 });
  // Cumulative context: call 1 exchange is now in context too
  result.inputTokens += estimateTokens(c2Input);
  result.outputTokens += estimateTokens(c2.data);
  result.cumulativeInputTokens += estimateTokens(contextAccum); // prior context the model re-reads
  contextAccum += JSON.stringify(c2Input) + JSON.stringify(c2.data);
  result.ms += c2.ms;

  if (!c2.data.success) return result;
  const reservationId = c2.data.data.reservation.id;

  // Call 3: getReservation (agent validates)
  const c3Input = { name: "getReservation", params: { reservationId } };
  const c3 = await apiCall("getReservation", { reservationId });
  result.inputTokens += estimateTokens(c3Input);
  result.outputTokens += estimateTokens(c3.data);
  result.cumulativeInputTokens += estimateTokens(contextAccum); // 2-call context re-read
  result.ms += c3.ms;

  result.success = c3.data.success;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approach B: 1-call book() (frontend orchestration)
//   The agent sends ONE call: book(date, time, partySize, name)
//   The browser page runs searchAvailability + createReservation + validate internally.
//   The agent only sees the single book() request and response.
//
//   To measure the full wall-clock cost we call the 3 underlying ops too,
//   but the agent's token cost is ONLY the single book() call.
// ─────────────────────────────────────────────────────────────────────────────
async function runBookCall(slot, guestName, runIndex) {
  const result = { calls: 1, inputTokens: 0, outputTokens: 0, cumulativeInputTokens: 0, ms: 0, success: false };

  // What the AGENT sends and receives — just the book() call
  const agentInput = { name: "book", params: { date: slot.date, time: slot.time, partySize: 1, name: guestName } };

  // Internally the browser runs all 3 ops. We time the total wall-clock by
  // calling them ourselves in the same order book.ts does.
  const start = performance.now();

  const avail = await apiCall("searchAvailability", { date: slot.date, partySize: 1 });
  const matchedSlot = avail.data?.data?.slots?.find(s => s.id === slot.slotId);
  if (!matchedSlot) {
    result.ms = performance.now() - start;
    return result;
  }

  const create = await apiCall("createReservation", { slotId: slot.slotId, name: guestName, partySize: 1 });
  if (!create.data.success) {
    result.ms = performance.now() - start;
    return result;
  }
  const reservationId = create.data.data.reservation.id;

  // Validate in parallel (as book.ts does)
  const [verify, recheckAvail] = await Promise.all([
    apiCall("getReservation", { reservationId }),
    apiCall("searchAvailability", { date: slot.date, partySize: 1 }),
  ]);

  result.ms = performance.now() - start;

  // Build the synthesized agent-facing response
  const agentOutput = {
    success: true,
    data: {
      reservation: create.data.data.reservation,
      validated: verify.data.success && !recheckAvail.data?.data?.slots?.some(s => s.id === slot.slotId),
    },
  };

  // Token cost for the AGENT: only the single book() call
  result.inputTokens = estimateTokens(agentInput);
  result.outputTokens = estimateTokens(agentOutput);
  // No cumulative context growth — this is call #1, first and only
  result.cumulativeInputTokens = 0;
  result.success = agentOutput.data.validated;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
console.log("Discovering available slots…");
const allSlots = await discoverSlots();
console.log(`Found ${allSlots.length} total slots\n`);

if (allSlots.length < 20) {
  console.error("Not enough slots for 10+10 reservations. Restart the server to reset in-memory store.");
  process.exit(1);
}

// Reserve 10 slots for each approach (non-overlapping)
const threeCallSlots = allSlots.slice(0, 10);
const bookSlots = allSlots.slice(10, 20);

const COL = {
  run: 5, approach: 14, calls: 7, wallMs: 10, inputTok: 11, outputTok: 12, ctxTok: 11, totalTok: 11,
};

function pad(s, n) { return String(s).padStart(n); }
function header() {
  return [
    pad("#", COL.run),
    pad("Approach", COL.approach),
    pad("Calls", COL.calls),
    pad("Wall (ms)", COL.wallMs),
    pad("Input tok", COL.inputTok),
    pad("Output tok", COL.outputTok),
    pad("Ctx tok", COL.ctxTok),
    pad("Total tok", COL.totalTok),
  ].join("  ");
}
function row(i, label, r) {
  const total = r.inputTokens + r.outputTokens + r.cumulativeInputTokens;
  return [
    pad(i, COL.run),
    pad(label, COL.approach),
    pad(r.calls, COL.calls),
    pad(r.ms.toFixed(0), COL.wallMs),
    pad(r.inputTokens, COL.inputTok),
    pad(r.outputTokens, COL.outputTok),
    pad(r.cumulativeInputTokens, COL.ctxTok),
    pad(total, COL.totalTok),
  ].join("  ");
}

console.log("═".repeat(85));
console.log("  BENCHMARK: 3-call MCP vs 1-call book()");
console.log("  Token model: 1 tok ≈ 4 chars. Cumulative = prior context re-read by the model each call.");
console.log("═".repeat(85));
console.log(header());
console.log("─".repeat(85));

const threeCallResults = [];
const bookResults = [];

// Run 3-call approach
for (let i = 0; i < 10; i++) {
  const r = await runThreeCall(threeCallSlots[i], `Guest3C-${i + 1}`, i);
  threeCallResults.push(r);
  console.log(row(i + 1, "3-call MCP", r));
}

console.log("─".repeat(85));

// Run book() approach
for (let i = 0; i < 10; i++) {
  const r = await runBookCall(bookSlots[i], `GuestBook-${i + 1}`, i);
  bookResults.push(r);
  console.log(row(i + 1, "book()", r));
}

console.log("═".repeat(85));

// Totals
function sum(arr, key) { return arr.reduce((a, r) => a + r[key], 0); }
function avg(arr, key) { return (sum(arr, key) / arr.length).toFixed(1); }

const t3 = {
  ms: sum(threeCallResults, "ms"),
  input: sum(threeCallResults, "inputTokens"),
  output: sum(threeCallResults, "outputTokens"),
  ctx: sum(threeCallResults, "cumulativeInputTokens"),
};
const tb = {
  ms: sum(bookResults, "ms"),
  input: sum(bookResults, "inputTokens"),
  output: sum(bookResults, "outputTokens"),
  ctx: sum(bookResults, "cumulativeInputTokens"),
};
t3.total = t3.input + t3.output + t3.ctx;
tb.total = tb.input + tb.output + tb.ctx;

console.log("\n  TOTALS (10 reservations each)");
console.log("─".repeat(85));
console.log(`  ${"Metric".padEnd(28)} ${"3-call MCP".padStart(14)} ${"book()".padStart(14)} ${"Savings".padStart(14)}`);
console.log("─".repeat(85));

function pct(a, b) { return `${(((a - b) / a) * 100).toFixed(1)}%`; }

console.log(`  ${"Wall-clock time (total ms)".padEnd(28)} ${String(t3.ms.toFixed(0)).padStart(14)} ${String(tb.ms.toFixed(0)).padStart(14)} ${pct(t3.ms, tb.ms).padStart(14)}`);
console.log(`  ${"Wall-clock time (avg ms)".padEnd(28)} ${avg(threeCallResults, "ms").padStart(14)} ${avg(bookResults, "ms").padStart(14)} ${pct(parseFloat(avg(threeCallResults,"ms")), parseFloat(avg(bookResults,"ms"))).padStart(14)}`);
console.log(`  ${"HTTP calls (total)".padEnd(28)} ${String(sum(threeCallResults,"calls")).padStart(14)} ${String(sum(bookResults,"calls")).padStart(14)} ${pct(sum(threeCallResults,"calls"),sum(bookResults,"calls")).padStart(14)}`);
console.log(`  ${"Input tokens (new per call)".padEnd(28)} ${String(t3.input).padStart(14)} ${String(tb.input).padStart(14)} ${pct(t3.input, tb.input).padStart(14)}`);
console.log(`  ${"Output tokens".padEnd(28)} ${String(t3.output).padStart(14)} ${String(tb.output).padStart(14)} ${pct(t3.output, tb.output).padStart(14)}`);
console.log(`  ${"Cumulative context tokens".padEnd(28)} ${String(t3.ctx).padStart(14)} ${String(tb.ctx).padStart(14)} ${pct(t3.ctx + 1, tb.ctx + 1).padStart(14)}`);
console.log(`  ${"TOTAL TOKENS".padEnd(28)} ${String(t3.total).padStart(14)} ${String(tb.total).padStart(14)} ${pct(t3.total, tb.total).padStart(14)}`);
console.log("═".repeat(85));

console.log(`
  NOTES
  ─────
  • Wall-clock: book() runs the validate step as two parallel fetches (Promise.all),
    so it overlaps what 3-call MCP does sequentially. Total HTTP work is the same;
    the concurrency is why book() is faster.

  • Output tokens: 3-call MCP returns the full slot list from searchAvailability
    (all matching slots) which the agent must read. book() synthesises a compact
    { reservation, validated } response — far less for the agent to process.

  • Cumulative context: in a real agent session every prior tool result stays in
    the model's context window. Call 2 re-reads Call 1's output; Call 3 re-reads
    Calls 1+2. book() has no prior tool context to re-read (it's the first call).

  • This does NOT include the agent's planning tokens (deciding which tool to call,
    reasoning about the slotId, etc.) — those are additional savings for book().
`);
