---
ctx_schema: 1
adr: 4
title: line numbers are typed, not documented
status: accepted
date: 2026-09-02
---

# 0004. line numbers are typed, not documented

## Context
DevFlow moves line and column numbers between systems that disagree about their
origin. A decoded source map and a V8 stack frame are zero-based; an editor, an
editor URL and a person reading a report are one-based. An off-by-one here does not
crash — it opens the wrong line of the right file, which reads as the product being
slightly bad at its job rather than as a bug, and it is reintroduced every time
someone adds a new edge that carries a number.

## Decision
`Pos0` and `Pos1` are distinct types, `toOneBased()` in
`src/core/react/positions.ts` is the only bridge between them, and there is no
inverse.

## Consequences
Arithmetic on either type is refused, so anything that genuinely needs to widen a
range has to construct it through the assertions at the edge — `pos0()` and `pos1()`
are assertions about where a number came from, not conversions, and using one to
silence a type error is the way this invariant is actually lost. Adding a
`toZeroBased()` would defeat the whole scheme and must not be added. This is the one
invariant with no runtime gate, deliberately: it does not need one, because getting
it wrong is a compile error.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
