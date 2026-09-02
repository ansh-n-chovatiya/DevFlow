---
ctx_schema: 1
adr: 7
title: causality is derived at read time, not stamped
status: accepted
date: 2026-09-02
---

# 0007. causality is derived at read time, not stamped

## Context
`src/core/causal/index.ts` builds the causal DAG from facts a flow already carries:
the recorder's attribution of a call to a step, the text of a log line, the body of
a response, the values a patch wrote. Work Stream 2.1 separately asks that "all
events carry `causedBy` references", which is a request to stamp that derivation
onto the events at capture time. `src/shared/types.ts` has no `causedBy` field and
its absence reads like a gap, so this is a recurring temptation to close.

## Decision
Causal links are derived from a recording when it is read, and are never stamped
onto events at capture; there is no `causedBy` field in `src/shared/types.ts`.

## Consequences
Every read pays the derivation, and a caller that wanted the chain without asking
the analysis for it cannot have it. What that buys is threefold: there is no second
copy of those facts to keep in sync, every recording already on somebody's disk gets
the analysis, and a sharpened rule reaches every flow ever made instead of only
flows recorded after it landed. Stamping would freeze today's rules into recordings
that tomorrow's rules should reach. The item stays open rather than struck out
because there is one thing that would justify a stamp — something inside the
extension needing a chain *before* the flow reaches a reader — and nothing does
today. New evidence, such as the DOM-change summary, is an argument for a better
derivation, not for a stamp.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
