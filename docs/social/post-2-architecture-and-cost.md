# Post 2 — ADD Architecture & The Cost of Testing

- **Status:** Ready to publish
- **Series:** ADD (AI-Driven Development) — Part 2 of 6
- **Visuals:**
  - `docs/social/add-architecture-layers.png` (+ source `.html`) — architecture half. Relabeled the good-panel box from `lib/operations/book.ts` to `frontend/operations/book.ts` to match the current repo/deck structure (frontend owns `components/` + `operations/`; backend owns `api/`).
  - `docs/social/add-cost-comparison.png` (+ source `.html`) — new cost/CI half, styled like Post 1's chart. Shows CI runner time for 1,000 `book()` tests: ≈6.5 min (Playwright) vs. ≈1 sec (function call). Indexed/relative framing only — no $/minute figures.

---

## Post copy

**ADD Series — Part 2: Architecture**

You already wrote the business logic. You just wrote it in the wrong place.

Open almost any frontend codebase and you'll find the same pattern: validation, orchestration, and business rules living inside `onClick` handlers, `useEffect` hooks, and API route bodies — scattered across every screen that happens to need them.

That's not a shortcut. It's the same logic, rewritten every time it's needed — and tested the same expensive way every time: through a browser.

**ADD starts with one rule: business logic gets its own layer, separate from the UI that triggers it.**

The button doesn't validate, orchestrate, or call the API directly. It calls one function — `book(...)` — that lives in its own layer, in `operations/`. One place, one set of rules, and (from Part 1) something you can test in milliseconds instead of seconds.

Here's what isn't obvious until you do the math: every Playwright test needs a real browser — spun up, rendered, torn down, on a CI runner you pay for by the minute. A direct function call needs none of that. No browser. No rendering. No DOM.

Run that math on a real suite: 1,000 `book()` tests need about 6.5 minutes of runner time through a browser. The same 1,000 tests, called directly, take about a second. Same coverage, ~390× less runner time.

That difference doesn't just make one test faster — it changes what your CI pipeline can afford to do. A suite that takes an hour of browser time can run in seconds as direct calls. You're no longer choosing between "thorough" and "affordable." You can run every test, on every commit, without your cloud bill or your CI queue noticing.

Fewer runner-minutes. Less machine uptime. A test suite that scales with how much you ship, not how much compute you can justify.

Next: what this same architecture does to how fast your team — and your AI coding agent — can actually ship.

#SoftwareArchitecture #CI #CloudCost #DevEx #ADD

---

## Notes

**No invented cost figures.** Deliberately kept the cloud/CI cost claims qualitative (no fabricated $/minute numbers) — we don't have a controlled benchmark for CI compute cost specifically, only for wall-clock test time (Part 1's numbers). The "1,000 tests, 6.5 min vs. 1 sec" figure in the new visual is *derived* by multiplying Part 1's measured per-test duration (388ms vs. 0.89ms) by 1,000 — runner time only, not a separately measured cost benchmark. Still no $/minute figures anywhere; the caption on the visual says so explicitly.

**Visual gap — resolved.** Added `add-cost-comparison.html`/`.png`, styled like Post 1's chart, showing the 1,000-test runner-time comparison above. The architecture diagram (`add-architecture-layers.png`) now also has its good-panel box relabeled `frontend/operations/book.ts` (was `lib/operations/book.ts`) to match the current repo/deck structure — frontend owns `components/` + `operations/`, backend owns `api/`. The UI/Test/agent-later branching underneath is unchanged; it's still the right shape for "one function, many callers."

**Continuity check:** the "next in this series" line here promises Part 3 = developer/agent shipping speed — matches Post 3 below.
