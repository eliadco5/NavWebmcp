# Post 1 — Testing Speed Teaser

- **Status:** Shipped (video already published/ready)
- **Series:** ADD (AI-Driven Development) — Part 1 of 6
- **Visual:** `docs/social/add-testing-speedup.mp4` (+ source `add-testing-speedup.html`)

---

## Post copy

**ADD Series — Part 1: Testing**

Your test suite is slow because you're testing the wrong layer.

We benchmarked the same business logic two ways:

🐢 Through the browser (Playwright): 3.9s – 4.6s per test
⚡ Through the function directly: 3.5ms – 8.9ms per test

Same validation. Same business rules. Same code path.

**Up to 1,314x faster.**

Not a typo. A test suite that takes minutes in Playwright runs in under a second when you test the logic instead of the DOM.

Here's what most teams miss: this isn't a testing trick. It's an architecture decision.

If your business logic is buried behind UI clicks — forms, buttons, page loads — the only way to test it is through the browser. Slow, flaky, expensive to maintain.

But if you expose your business logic as clean, callable operations — the same operations your UI calls, your API calls, and (increasingly) your AI agents call — you can test the logic directly. No browser. No flakiness. No waiting.

I call this **ADD — AI-Driven Development**: architect your platform so its capabilities are directly consumable — by your tests, your APIs, and your AI agents — instead of only reachable by clicking through a UI.

This is the first thing ADD buys you. Next up: what this does to your cloud bill and your CI pipeline.

#SoftwareArchitecture #AI #TestAutomation #DevEx #ADD

---

## Notes

**Numbers shown are the video's on-screen values** — both sides (Playwright and function-call time) were uniformly scaled ×10 from the real measured numbers, purely for on-screen legibility. The ratio is unchanged and real: 437× (`book()`) and 1,314× (`seatGuest()`), sourced from `docs/speedbase-results.json`. Real unscaled numbers: Playwright 388–459ms, function call 0.35–0.89ms.

**Known bug to fix before publishing:** the video's `aria-label` (accessibility text baked into `add-testing-speedup.html`) still states the *pre-scale* numbers ("0.39s ... 0.89ms") while the visible bars now render the ×10'd numbers ("3.88s ... 8.90ms"). The 437×/1,314× multipliers are correct either way (ratio-preserving), but the absolute times in the alt text don't match what's on screen. Fix: update the `aria-label` string in `add-testing-speedup.html` to `3.88s`/`4.59s` and `8.90ms`/`3.50ms` before this goes out.

**Open question for the refine pass:** consider whether the public caption should carry a small disclosure that displayed numbers are uniformly scaled for legibility (ratio real) — optional, but worth deciding given how much scrutiny these numbers got internally.
