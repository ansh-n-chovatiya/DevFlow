---
ctx_schema: 1
adr: 6
title: periodic layout snapshots are refused
status: accepted
date: 2026-09-02
---

# 0006. periodic layout snapshots are refused

## Context
Work Stream 2.1's "unified event chronicle" asks for DOM deltas *and* periodic
layout snapshots. The deltas shipped: a `MutationObserver` over the whole document
for the length of each step, folded and budgeted. The snapshots did not, and they
read as the unfinished half of one item rather than as a separate feature that was
weighed. A timer that reads layout forces a synchronous reflow on every tick on
every recorded page whether or not anything moved — which is the cost profile the
`v3.2.0` render attempt was reverted for, moved from the fiber tree to the layout
tree, and it runs against the <2% CPU NFR. There is also nowhere to put the result:
a snapshot taken *between* steps belongs to no step, and the schema has no
flow-level timeline to hold one. Giving it one means building a time-travel player,
which is a different product surface. A snapshot taken *at* a step is already
answered twice over — the screenshot is the layout, and `ElementRef.boundingBox` is
where the interaction landed.

## Decision
Periodic layout snapshots are not built, and their absence is a refusal rather than
a partial delivery of the DOM-delta item.

## Consequences
DevFlow cannot answer "what moved on the page while nothing was interacted with" —
a layout shift with no mutation behind it is invisible to a recording. Building it
later needs two things that are not started: a mechanism that reads layout off the
browser's own pass rather than forcing one (`ResizeObserver`, `IntersectionObserver`)
and a schema decision about where a between-steps observation lives. Neither is a
detail, and doing this with a `setInterval` and `getBoundingClientRect` is the
version that must not ship.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
