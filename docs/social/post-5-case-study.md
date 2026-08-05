# Post 5 — Case Study: What ADD + NavWebMcp Actually Save You

- **Status:** Draft — no visual yet
- **Series:** ADD (AI-Driven Development) — Part 5 of 6
- **Visual:** TBD — see Notes for a concept

---

## Post copy

**ADD Series — Part 5: The Case Study**

Here's what Parts 2–4 add up to, measured — not estimated.

Booking a table, the "raw MCP" way — the agent orchestrates 3 calls itself:
→ 366–418 tokens, 49–59ms, per booking

The same booking, as one composite operation over MCP:
→ 91 tokens, 16ms

The same composite operation, called from inside the browser over WebMCP:
→ 75 tokens, 39ms — the savings hold even when the "agent" is a script running on the page

And the browser-automation alternative — driving the same action through a real UI:
→ 422ms, and ~5,710 tokens of accessibility-tree the agent would have to read just to know what to click

Net effect of the composite operation, both surfaces: **78–80% fewer tokens, and 67–73% lower latency than raw multi-call MCP** (a smaller but real 20–34% latency win over the browser, since WebMCP is still running inside an actual page).

None of this required bending the platform to fit MCP. The composite operation — `book(date, time, partySize, name)` — is the same function the UI calls and the same function the tests call from Parts 1–3. The protocol from Part 4 just... exposed it.

That's the actual claim of this series: architecture first, protocol second. Get the operations layer right, and the agent integration — and the savings — come almost for free.

Next: pulling it all together.

#AI #Benchmarking #MCP #ADD #CaseStudy

---

## Notes

**Every number here is a direct quote from `README.md`'s "Composite calls vs. multi-call orchestration — booking flow" table** — not recomputed. Deliberately used the README's own top-line percentage claims ("−78 to −80% tokens... −67 to −73% latency over MCP... WebMCP composite −20 to −34%") rather than re-deriving percentages from the raw ms/token figures, since a naive recompute (e.g. 91 vs 366/418) lands close but not identical to the README's stated range, and quoting the source doc's own summary avoids any drift.

**Reproduce command**, for the "full methodology" link if we add one: `node scripts/bench.mjs --n=5` (writes `docs/bench-results.json`) — see README's "Reproduce" section.

**Visual concept:** a grouped bar chart, same visual system as Post 1 — four lanes (raw MCP load+native, raw MCP invoke, composite MCP, composite WebMCP) plus a fifth "Playwright" lane shown separately/de-emphasized since its token axis (DOM reads) isn't directly comparable — matches the caveat already used in the README table (marked with a dagger footnote there).
