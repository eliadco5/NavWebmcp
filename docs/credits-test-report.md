# Credits: stress, negative, system and end-to-end test report

**Question:** Can the credit mechanism, or anything around it, make the app unreachable?
**Answer after testing:** Not any more. Testing found **four ways to take the app down or
starve every caller**. Three were pre-existing, and the fourth appeared once Redis was added.
All four are fixed, and each has a regression test. The final run passed **184 of 184**
end-to-end checks, plus **979 automated tests** (975 in the suite and 4 against a live Redis).

- [How it was tested](#how-it-was-tested)
- [What it found, and what was fixed](#what-it-found-and-what-was-fixed)
- [Results](#results)
- [Performance and overhead](#performance-and-overhead)
- [What this does not cover](#what-this-does-not-cover)
- [Run it yourself](#run-it-yourself)

---

## How it was tested

Four layers, from the arithmetic up to real servers under attack.

| Layer | What | Where |
|---|---|---|
| **Property / fuzz** | 480,000 random reserve/settle/refill steps over four policy profiles, including hostile inputs (NaN, ±Infinity, negative charges, the clock going backwards, frozen callers). After every step, six invariants are checked (below). | `tests/unit/credits/ledger-fuzz.test.ts` |
| **Negative / failure injection** | Corrupt stored ledgers, hostile overrides, a Redis that hangs, throws, returns garbage or loses every compare-and-set, a never-settling request holding the state lock, the request gate under every exit path. | `tests/unit/credits/redis-failures.test.ts`, `gate.test.ts`, `tests/unit/shared-state/mutex-watchdog.test.ts` |
| **Unit / integration** | Charges, grants, AIMD, holds, hints, every surface (MCP `_meta` and text block, HTTP headers, 429), fan-out caps, deadlines, the sign-in throttle, the admin operations. | `tests/unit/credits/*.test.ts` and the rest of the suite |
| **System / e2e / performance ("Mad Max")** | Real production builds (`next start`) driven over real HTTP by 14 attack and load scenarios. Run against one instance with no Redis, and against **two instances sharing a real Redis** that is stopped and **frozen** mid-run. | `scripts/credits-stress.mjs` (`npm run test:stress`) |

**Fuzz invariants.** These hold for every reachable ledger state:
1. `outstanding` equals the sum of live reservations and is never negative;
2. after a refill with no debt, `balance + outstanding ≤ window`;
3. `minWindow ≤ window ≤ maxWindow`;
4. every number is finite, so no NaN or Infinity ever reaches storage;
5. after any abuse, an idle caller recovers to a full window;
6. a reservation that is never settled expires.

**End-to-end scenarios** (`scripts/credits-stress.mjs`):

| # | Scenario |
|---|---|
| S1 | Smoke: credits on every surface, discovery shows each function's cost |
| S2 | Negative: no and forged tokens, malformed JSON, hostile `CreditRequest` values, bodies over the cap (declared, chunked, lying `Content-Length`, short body), sign-in body over the cap, a customer calling admin, invalid admin values |
| S3 | Fan-out bombs: `invoke` 6 levels deep; a 50 × 50 batch (2,550 operations) that fits under the body cap; one that doesn't |
| S4 | Flood: 600 parallel calls from one agent |
| S5 | Isolation: one agent floods at 40-way concurrency while a normal agent and a person keep working |
| S6 | 50 agents × 2 in flight × 20 calls: overload is shed with hints, and agents that follow the hints all finish |
| S7 | Long calls (8 s relay waits): charged for time, the window shrinks, 10 in parallel |
| S8 | Long calls vs everybody else: other users while 6-way long calls run |
| S9 | Admin under fire: freeze, unfreeze, window cap with long calls, reset, ledger listing |
| S10 | Sign-in throttle: per IP **and** username, same-IP other users unaffected, 50 parallel bad sign-ins |
| S11 | Two instances sharing Redis: one ledger per agent across both; a 300-call flood across both |
| S12 | Redis **stopped**, then **paused** (connected but not answering), then back |
| S13 | 60 s soak: 10 agents, mixed operations, 20-way concurrency |
| S14 | A slow client trickling a body; malformed MCP bodies, singly and 30 at once |

## What it found, and what was fixed

| # | Severity | Found by | Problem | Fix |
|---|---|---|---|---|
| 1 | **Outage** (pre-existing) | S2 | **One malformed MCP request took the whole instance down.** A 10-byte body that isn't JSON made the MCP transport throw an unhandled rejection and never answer. That request held the per-instance state lock, so every later `/api/call` and MCP request waited forever. Static pages still loaded, so the app looked up. | The MCP route rejects anything that isn't a JSON-RPC object or batch with HTTP 400 `-32700` before it reaches the transport. The state lock has a **watchdog**: a request holding it past `STATE_LOCK_MAX_MS` (30 s) passes it on and is logged. That stops any future hang of this kind from wedging the instance. |
| 2 | **Outage** (pre-existing) | S12 | **A Redis that was connected but not answering hung every request** for 20 s or more (a `docker pause`). `disableOfflineQueue` only helps when the connection is down, not when it's up and silent. Every store (shared state, audit, sessions, telemetry, credits) waited. | The Redis client got a per-command timeout (`REDIS_COMMAND_TIMEOUT_MS`, 1 s), a 1 s PING keepalive, and a socket timeout (`REDIS_SOCKET_TIMEOUT_MS`, 3 s). A hung Redis is detected, the socket dropped, and Redis skipped for the cooldown. Credit commands are also bounded separately at 300 ms. Result with Redis paused: p50 18 ms, p95 29 ms, worst 3.7 s during the detection window. |
| 3 | **Starvation** | audit + fuzz | **A call whose settle never ran leaked its reservation forever.** That happens when an instance is killed mid-call, for example at Vercel's `maxDuration`. On a small window, a few such leaks would refuse that caller permanently. | Each reservation now carries its own id and time and **expires after `CREDITS_HOLD_STALE_MS`** (120 s). A late settle releases nothing, so there is no double release. Invariants 1 and 6 cover this. |
| 4 | **Starvation** | fuzz | **A corrupt stored ledger** (a NaN balance, wrong types, bad JSON) would make every comparison fail and **refuse a caller forever**. | Ledgers and overrides are validated on every read and discarded if unusable: the caller starts fresh. The compare-and-set script tolerates a corrupt stored value. |
| 5 | Degradation | S5 | Credits were checked *inside* the instance's queue, so a flooding agent filled the line. With an expensive request per refusal, it had **815 of its calls served** in 8 s. | A **request gate** (per caller, 8 agents / 16 people in progress) and a **quick refusal** at the door, before the state lock and before the MCP transport builds a server. Refusing costs about what any request costs the framework (5–6 ms), versus about 9 ms for a real MCP call. The same flood now gets **93 served out of 2,870**. |
| 6 | Degradation | S5, S13 | In-flight count never rose under a flood (each request finishes quickly), so grants never fell. Then, applying load to **everyone equally** dropped 20 busy-but-equal agents to **18 % success**. | Pressure now also follows **event-loop lag** (0 at 50 ms, 1 at 400 ms), and each caller feels it in proportion to its **share of recent traffic**. A quiet agent beside a flooding one keeps full grants. Agents that follow the hints get 100 % of their calls through. |
| 7 | Degradation | S14 | The request body was read **inside** the state lock, so a client trickling its body slowly held the instance. | Authentication, body reading and the gate all run before the lock now. While a body trickles in over 8 s, others see p95 104–112 ms. |
| 8 | Lock-out | review | The sign-in throttle keyed on IP only, so an attacker could **lock everyone behind an office NAT** out by guessing one account. | Keyed on IP **and** username. Its Redis calls are bounded, so a slow Redis never blocks sign-in. |
| 9 | Memory | review | The in-process ledger and sign-in maps were unbounded. | LRU-bounded (20,000 ledgers; 50,000 counters). The admin list is capped at 2,000. |
| 10 | Correctness | review | An unexpected exception inside admission would have failed the call. Code between admission and the handler could throw without settling. | Admission fails **open** (the call runs unmetered and the error is logged). Everything after admission is inside one try, so settle always runs. |
| 11 | Hygiene | review | `/api/agent-clients`, `/api/admin/{clients,sessions}`, `/api/intros`, `/api/switch-role`, `/api/audit/report` and `/api/bug-report` buffered whole bodies before checking size. | All of them read only up to their cap. |

## Results

**Final run: 184 / 184 end-to-end checks passed.** Raw results:
[`single-instance-no-redis.json`](credits-stress/single-instance-no-redis.json) (88/88) and
[`two-instances-redis.json`](credits-stress/two-instances-redis.json) (96/96). The test machine
was a Windows 11 laptop running the load generator, two Next.js instances and Redis together.
That is a harsh setup: the attacker and the server compete for the same CPU.

### Availability under attack

| Scenario | Attacker | Everyone else |
|---|---|---|
| S5: 40-way flood, one agent (one instance) | 2,870 calls → **93 served**, 2,777 refused with a hint | Other agent: **100 %** success, p95 **446 ms**. Person in the UI: **100 %** success, p95 2.3 s (see below) |
| S5: same, two instances + Redis | 9,916 calls → 141 served | Other agent: 100 %, p95 623 ms. Person: 100 %, p95 2.3 s |
| S8: 6-way 8 s long calls (one instance) | 6,980 attempts → **5 admitted** | Other agent: 100 %, p95 **24 ms**. Person: 100 %, p95 613 ms |
| S8: same, two instances + Redis | 3,328 attempts → 5 admitted | Other agent: 100 %, p95 43 ms |
| S14: a body trickled in over 8 s | — | Others: p95 **104–112 ms** |
| S14: 30 concurrent malformed MCP bodies | all answered 400 | `/api/call` still answers at once |
| S3: 2,550-operation bomb | admitted against the full window, **stopped at 200 operations** (66 ms, or 940 ms with Redis); caller left deep in debt and refused on its next call | unaffected |
| S12: Redis **paused** (connected, not answering) | — | 289/289 answered, p95 **29 ms**, worst 3.7 s (the detection window), no 5xx |
| S12: Redis stopped | — | 1,152/1,152 answered, p95 29 ms, metering continues per instance |
| S12: Redis back | — | 443/443, p95 58 ms |

**The person's p95 of about 2.3 s during a 40-way flood is not caused by credits.** The same
flood against the same build with `CREDITS_ENABLED=false` gives the same p95 (2.8 s). It is the
cost of the raw request rate on a single Node process sharing a laptop with its attacker. With
credits off, the attacker gets **2,880 real calls** through in the same time; with credits on,
**93**. What's left (CPU spent just receiving requests) needs a per-IP limit at the edge (see
[below](#what-this-does-not-cover)).

### Load shedding and fairness

| Scenario | Result |
|---|---|
| S6: 50 agents × 2 in flight × 20 calls (overload) | **1,000 / 1,000** calls completed by agents that follow the hints (137 needed a retry on one instance; 0 with two); 0 errors |
| S6: then 20 agents, one call each (moderate) | nobody refused |
| S13: 60 s soak, 10 agents, 20-way, mixed ops | **10,563 / 10,563** on one instance (176 calls/s, p95 148 ms) and **4,940 / 4,940** on two instances + Redis (82 calls/s, p95 424 ms) |
| S11: 8 long calls split across two instances, window 4 | **1 admitted.** The shared ledger holds across instances; per-instance ledgers would have admitted 2 |
| S11: 300-call flood split across two instances | 16 served, 284 refused with hints, no 5xx |
| S4: 600 parallel connections | Every answered request was a success or a hinted refusal, with no 5xx. 213–311 connections were refused by the **operating system's accept backlog** before reaching the app. The same burst on a route with no credits and no lock also lost 79 that way. That is an OS limit, not the app's. |

## Performance and overhead

These are sequential requests against one instance with no Redis, measured A/B, twice each
(`CREDITS_ENABLED=false` vs on):

| Request | Credits off | Credits on | Overhead |
|---|---|---|---|
| MCP `tools/call explore` | 8.3–8.7 ms | 8.9–9.0 ms | **≈ +0.4 ms (≈ 5 %)** |
| `/api/call explore` (person) | 4.3–5.4 ms | 4.7–4.8 ms | within noise |
| Refused at the door (frozen / broke agent) | — | 5.8 ms | less than a served call |

With Redis, credits add about four Redis round trips per metered call: a read and a
compare-and-set to reserve, and the same again to settle. On the local Redis this was not
measurable against the noise of the rest of the request. The soak (S13) ran at p50 206 ms with Redis and two instances,
against 90 ms on one instance without Redis, under 20-way concurrency. Most of that
difference is the shared-state hydrate/flush every request already did before credits.

## What this does not cover

- **A raw packet flood needs an edge rate limit.** Inside the app a refusal is as cheap as
  any request the framework serves, but not free. Put a per-IP request limit in front of
  production: Vercel Firewall, a WAF, or the load balancer. Credits decide *how much work*
  each caller gets; the edge decides *how many requests* reach the app.
- **This was one laptop, not a fleet.** The two-instance runs share a CPU. Throughput numbers
  are for comparing runs, not for capacity planning.
- **Vercel-specific behaviour** wasn't reproduced: cold starts, `maxDuration` kills (whose
  effect, leaked reservations, is covered by expiry and the fuzz invariants), and Vercel's
  own `x-forwarded-for`.
- **A real naive LLM agent following the hints** wasn't run in this pass. S6 and S13 use a
  scripted agent that does exactly what the hint says.

## Run it yourself

```bash
npm run build
npx next start -p 3201                                   # one instance, no Redis
npm run test:stress -- --base=http://localhost:3201      # add --quick for a short pass

docker compose up -d --wait redis                        # Redis on :6390
REDIS_URL=redis://localhost:6390 npx next start -p 3202
REDIS_URL=redis://localhost:6390 npx next start -p 3203
npm run test:stress -- --base=http://localhost:3202 --base2=http://localhost:3203 \
  --redis-container=ecstatic-knuth-a38e95-redis-1 --out=results.json
```

`--only=S5,S12` runs a subset. The exit code is 0 only when every check passes. The unit,
fuzz and failure-injection tests run in `npm test`. The live Redis compare-and-set test runs in
`npm run test:redis`.
