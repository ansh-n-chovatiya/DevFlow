---
ctx_schema: 1
adr: 17
title: framework adapters are deferred as three work streams, not one
status: accepted
date: 2026-09-03
---

# 0017. framework adapters are deferred as three work streams, not one

## Context
`ROADMAP_AND_PHASES.md` §3.5 carries three bullets as one work stream: a Vue 3 /
Nuxt adapter (reactivity proxy and template AST mapper), a Svelte 5 / SvelteKit
adapter (runes and signals), and Next.js App Router / React Server Components
across the RSC wire protocol. Closing Phase 3 means resolving it.

Vue 3, Svelte 5 and RSC do not share React's fiber tree, and **nothing in
`src/core/react/` transfers**: fifteen modules — `fiber.ts`, `owner.ts`,
`table.ts`, `chains.ts`, `classify.ts`, `needle.ts`, `stamp.ts`, `search.ts` and
the source-map engine — whose every entry point is fiber-shaped. Each adapter is
a Phase-1-sized body of work with its own runtime that has to be *measured*
rather than reasoned about, which is this project's most reliable habit and its
most expensive one in hours.

Three things written before this decision say the same. The Phase 3 preamble:
*"starting one and leaving two would be worse than starting none"*. "What NOT to
Build": *"each adapter is a major investment; deep React beats shallow
multi-framework"*, flagged specifically against doing this before Phase 3. And
Phase 5 §5.4 already carries the same three frameworks at deeper scope.

## Decision
§3.5 is **deferred to Phase 5 §5.4 as three separate work streams**, with the
argument written into the roadmap rather than left as three unticked boxes. Phase
3 is closed as scoped.

The RSC bullet is explicitly separated from the other two in the deferral. A
server component never mounts in the browser, so it is a wire-protocol reader
rather than a runtime-tree adapter — closer to `core/otel`, which now exists,
than to `core/react`. Planning it beside Vue and Svelte would mis-cost all three.

## Consequences
Phase 4 is unblocked and depends on none of this: production telemetry ingestion,
the IDE live link, git forensics, the CI regression watcher and the accessibility
autopilot are framework-agnostic already.

This is a deferral, not a refusal, and the distinction is load-bearing. The
frameworks are wanted; what is refused is starting one of three inside a phase
that is otherwise complete, because two of the three would then read as promised
work in progress rather than as scheduled work.

Overturning this needs an argument for building **all three**, or a measured case
that one of them is materially cheaper than a Phase-1 work stream. The RSC bullet
is the candidate for the second, and `core/otel` is where that case would start.
