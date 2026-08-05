# Post 2 — ADD Architecture & The Cost of Testing

- **Status:** Draft (diagram exists, copy needs the cost angle folded in)
- **Series:** ADD (AI-Driven Development) — Part 2 of 6
- **Visual:** `docs/social/add-architecture-layers.png` (+ source `add-architecture-layers.html`) — existing diagram supports the architecture half of this post; may want a second visual for the cost/CI half (see Notes).

---

## Post copy

**ADD Series — Part 2: Architecture**

You already wrote the business logic. You just wrote it in the wrong place.

Open almost any frontend codebase and you'll find the same pattern: validation, orchestration, and business rules living inside `onClick` handlers, `useEffect` hooks, and API route bodies — scattered across every screen that happens to need them.

That's not a shortcut. It's the same logic, rewritten every time it's needed — and tested the same expensive way every time: through a browser.

**ADD starts with one rule: business logic gets its own layer, separate from the UI that triggers it.**

The button doesn't validate, orchestrate, or call the API directly. It calls one function — `book(...)` — that lives in its own layer. One place, one set of rules, and (from Part 1) something you can test in milliseconds instead of seconds.

Here's what isn't obvious until you do the math: every Playwright test needs a real browser — spun up, rendered, torn down, on a CI runner you pay for by the minute. A direct function call needs none of that. No browser. No rendering. No DOM.

That difference doesn't just make one test faster — it changes what your CI pipeline can afford to do. A suite that takes an hour of browser time can run in seconds as direct calls. You're no longer choosing between "thorough" and "affordable." You can run every test, on every commit, without your cloud bill or your CI queue noticing.

Fewer runner-minutes. Less machine uptime. A test suite that scales with how much you ship, not how much compute you can justify.

Next: what this same architecture does to how fast your team — and your AI coding agent — can actually ship.

#SoftwareArchitecture #CI #CloudCost #DevEx #ADD

---

## Notes

**No invented cost figures.** Deliberately kept the cloud/CI cost claims qualitative (no fabricated $/minute numbers) — we don't have a controlled benchmark for CI compute cost specifically, only for wall-clock test time (Part 1's numbers). The cost argument is a legitimate *inference* from the speed numbers (less wall-clock time on a paid-by-the-minute runner = less cost), not a separately measured claim — worth being careful not to overstate this into a specific dollar figure we can't back up.

**Visual gap:** the existing diagram (`add-architecture-layers.png`) makes the architecture point (logic in its own layer, UI/Test/agent-later as consumers) but doesn't visually carry the new cost/CI framing added to this post's copy. Options when refining: (a) ship as-is, let the text carry the cost angle; (b) add a second small graphic — e.g., a runner-minutes/cost comparison bar, styled like Post 1's chart — showing "browser-based CI job" vs "direct-call CI job" cost proxies (still needs to avoid fabricated absolute $ values — could use relative/indexed cost instead).

**Continuity check:** the "next in this series" line here promises Part 3 = developer/agent shipping speed — matches Post 3 below.
