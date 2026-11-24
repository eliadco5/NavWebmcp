# NavWebMcp credits (≥ 1.4.0)

Flow control for agent traffic, modeled on SMB2/3 credits. One agent client shouldn't be
able to slow the server down for everyone else, whether it sends many calls, long calls or
calls that fan out wide.

Credits are not a daily quota and not billing. They are a **window**. The server decides how
much work each caller may have in flight and how fast that work comes back to it, depending
on how expensive the caller's calls are and how loaded the server is.

The mechanism is **transport-agnostic**, like the rest of NavWebMcp. It is defined once,
against the `Result` envelope, and each surface (MCP, WebMCP, plain HTTP) carries it in its
own native way. **No client cooperation is required.** An agent that has never heard of
credits is still paced, and the server tells it in plain language what to do.

Implementation:
- `lib/credits/`: `policy.ts` (costs, profiles), `ledger.ts` (state and arithmetic),
  `hint.ts` (wording), `index.ts` (admission and settlement);
- the hook in `lib/operations/execute.ts`.

## How SMB does it, and what we kept

In SMB the server grants credits. Each request consumes a `CreditCharge` that grows with its
payload size. The client asks for more with `CreditRequest`, and the server answers with a
`CreditResponse` it picks based on its own load. The server is therefore in control of both
how many requests are outstanding and how fast credits flow back.

NavWebMcp keeps that shape and adds two cost factors: the **operation type** and the **time
the call spent running**. Long calls are the expensive ones, so they cost more.

## Lifecycle of one call

Only **top-level** calls are metered. Nested calls (inside `invoke` or a composite) are
counted toward their parent's cost. A composite therefore never runs out of credits halfway
through its writes.

1. **Charge up front** (SMB `CreditCharge`):
   `REQUEST_COST (1) + weight + floor(requestBytes / sizeUnit)`.
   - `weight` is read 1, write 2, or whatever the operation declares (`credits.weight`). The
     composites declare how many operations they run: `book` 4, `seatGuest` 4,
     `hostVipGuest` 7. The `ui_*` ops declare 2 or 3, because over MCP they wait on the
     user's tab.
   - `invoke` is charged the sum of the weights of what it will run, read from its args.
     One batch pays `REQUEST_COST` once; the same calls sent separately pay it once each.
2. **Admission.** If `balance ≥ charge`, the charge is reserved and the call runs.
   - If the caller is short but the trickle refill would cover it within `maxHoldMs`, the
     server **holds** the call and then runs it. That is backpressure, not an error, and the
     result reports `heldMs`.
   - A call is never held while the per-instance state lock is held, because that would
     stall every other request on the instance (`isStateLockHeld()`,
     `lib/shared-state/mutex.ts`).
   - Each caller can have only one call held at a time.
   - Otherwise the call is **refused** with `INSUFFICIENT_CREDITS` and `retryAfterMs`. It
     is audited and nothing ran.
3. **Settle** once it finishes. The extra cost is
   `floor(responseBytes / sizeUnit) + floor(durationMs / timeUnitMs) × timeRate`, plus any
   nested operations nobody declared up front. It is taken from the balance, which can go
   negative: a caller who ran something expensive pays the debt back before it can run
   much more.
4. **Grant** (SMB `CreditResponse`):
   `min(creditRequest ?? reserved, window − outstanding − balance) × (1 − pressure)`.
   - `pressure` is in-flight metered calls on this instance against `CREDITS_CAPACITY`. It
     is 0 below half capacity and reaches 1 at full capacity.
5. **Window (AIMD).**
   - A call longer than `longCallMs`, or one that leaves the caller in debt, halves the
     window, down to `minWindow`.
   - A call that finishes quickly while pressure is low grows it by 1, up to `maxWindow`.
6. **Trickle.** The balance refills toward the window at `refillPerSec`. This is the
   starvation guard: a caller is never stuck at zero for good.

## Profiles

Agents (MCP clients, and the in-page WebMCP agent) are metered strictly. People clicking in
the UI get a loose safety net. System calls (seed data, scripts) are exempt.

| | agent | human |
|---|---|---|
| initial / min / max window | 16 / 2 / 64 | 128 / 32 / 512 |
| refillPerSec | 2 | 20 |
| sizeUnit | 4 KB | 16 KB |
| timeUnitMs × timeRate | 1 s × 1 | not charged |
| longCallMs | 3 s | 10 s |
| maxHoldMs | 1.5 s | 1 s |

Every field can be overridden as `CREDITS_<AGENT|HUMAN>_<FIELD>`, for example
`CREDITS_AGENT_MAX_WINDOW=128`. Other settings:
- `CREDITS_CAPACITY` (default 64): the load capacity behind `pressure`;
- `CREDITS_ENABLED=false`: turns metering off entirely.

Admins can override `maxWindow` or `refillPerSec` for one caller, or freeze it, through
`setClientCreditPolicy` or the Management tab.

## What the caller sees

**The piggybacked hint.** Every surface returns the `Result` envelope. It gains an optional
field:

```jsonc
{
  "success": true,
  "data": { … },
  "credits": {
    "balance": 3, "window": 16, "charged": 7, "granted": 2,
    "hint": "Credits low (3 of 16). That call cost 7 credits because it ran 4 s; wait ~3 s before the next call, or combine independent reads into one invoke({ calls: [...] }) batch."
  }
}
```

It appears **only when the caller should change what it's doing**, so steady-state calls
cost no extra tokens:
- the balance is below 25 % of the window;
- the balance went negative;
- the window shrank;
- the call was held;
- the call was refused.

`hint` is a single sentence an LLM can act on without knowing this spec.

| Surface | In-band (what a model reads) | Out-of-band (protocol-aware clients) |
|---|---|---|
| WebMCP, in-page | `credits` in the returned Result | same |
| MCP | an extra `[credits] …` text block in `content`, only with a hint. `structuredContent` is unchanged, so it still matches the outputSchema | `_meta["navwebmcp/credits"]` on every metered result |
| HTTP `/api/call` | `credits` in the body | `X-NavWebMcp-Credits-Balance/Window/Charged/Granted` on every metered response; refusal is `429` + `Retry-After` |

**Discovery.**
- Two sentences in the server instructions, which every MCP client receives on `initialize`.
- `getContext()` returns a `credits` snapshot `{ balance, window, maxWindow, refillPerSec, frozen }`.

**Optional cooperation.** A client may send a `CreditRequest` to ask for more credits back on
each response:
- MCP: `params._meta["navwebmcp/credits"] = { request: n }`;
- HTTP: `X-NavWebMcp-Credit-Request: n`.

Nothing depends on it.

## Related limits

These are not credits, but they ship with them.

| Limit | Default | Error |
|---|---|---|
| Nesting depth (invoke inside invoke inside a composite) | 3 levels | `FANOUT_LIMIT` |
| Operations run under one top-level call | 200 | `FANOUT_LIMIT` |
| Handler deadline | 15 s (`OP_DEADLINE_MS`, or `deadlineMs` per op) | `HANDLER_TIMEOUT` (time still charged) |
| JSON request body (`/api/call`, `/api/ui/relay`, MCP) | 64 KB (`MAX_BODY_BYTES`) | HTTP 413 `PAYLOAD_TOO_LARGE` |
| Sign-in attempts per IP | 10 per 5 min (`LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_S`) | HTTP 429 `TOO_MANY_ATTEMPTS` |

## Storage

On Redis, each caller has one JSON ledger, `webmcp:credits:<env>:l:<principal>`, written by
compare-and-set on a version number. That is a small Lua script, retried on conflict, so
instances never race each other. Idle ledgers expire after a day.

Without Redis, or while it's down, an in-process Map is used. Limits then apply per instance
instead of switching off.

Holding a call is tracked per instance, so with several instances one caller could have
one call held on each.
