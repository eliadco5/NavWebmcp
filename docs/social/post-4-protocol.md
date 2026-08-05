# Post 4 — The NavWebMcp Protocol, Explained

- **Status:** Draft — no visual yet
- **Series:** ADD (AI-Driven Development) — Part 4 of 6
- **Visual:** TBD — see Notes for a concept

---

## Post copy

**ADD Series — Part 4: The Protocol**

If your business logic already lives in its own layer (Part 2), exposing it to an AI agent should be the easy part. Usually, it isn't.

Most "add an MCP server" integrations take a human-shaped API and wrap it in tool definitions — one tool per endpoint. The agent still has to orchestrate multiple calls, still re-reads growing context on every step, and still has to be told, in the prompt, how your domain actually works.

**NavWebMcp is a thin protocol layered on top of MCP** — MCP is just the wire; this is the part that actually changes what an agent has to do:

→ **Composite operations.** One call does what used to take three or seven. The orchestration — sequencing, validation, rollback on failure — lives in your operations layer, not in the agent's context.

→ **Progressive disclosure.** An agent connects and sees a handful of tools, not fifty. It discovers the rest on demand, so token cost per request doesn't grow with the size of your platform.

→ **RBAC and confirmation, enforced once.** The same permission checks your UI already respects apply automatically to every agent call — no separate policy layer to keep in sync.

→ **One registry, two surfaces.** The exact operations your UI and your tests call are what gets exposed over MCP — nothing translated, nothing re-implemented as "the agent version."

If you did Part 2 right, this layer is nearly mechanical to add. That's the point.

Next: what this actually looks like end-to-end, with real numbers.

#AI #MCP #ProtocolDesign #ADD #AgentArchitecture

---

## Notes

**Grounded in the actual protocol**, not aspirational — matches this repo's real implementation: 8 always-on meta-tools at connect (not "fifty," deliberately kept vague/generic here since this post is meant to read as a transferable idea, not a repo writeup — see Post 5 for the concrete numbers), composite operations (`book`, `seatGuest`, `hostVipGuest`), RBAC via a `roles` array checked per-call, and one operation registry exposed identically over MCP HTTP and in-page WebMCP.

**Deliberately no repo/product names** in the post body (no "NavWebMcp" implementation details like file paths) — keeps it a transferable architecture lesson, matching how Posts 1–2 avoided naming this repo. The one exception is naming "NavWebMcp" itself as the protocol, since that's the concept this post exists to introduce.

**Visual concept:** extend the Post 2 diagram — same `lib/operations/book.ts` box, but now with a new adapter layer drawn on top labeled "MCP / NavWebMcp," fanning out to "8 always-on tools" and a "the rest, on demand" bucket, plus a small RBAC gate icon. Reuse the dark palette from `add-architecture-layers.html` for series consistency.
