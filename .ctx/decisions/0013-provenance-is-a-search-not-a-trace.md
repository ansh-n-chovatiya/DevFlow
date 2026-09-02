---
ctx_schema: 1
adr: 13
title: provenance is a search, not a trace
status: accepted
date: 2026-09-02
---

# 0013. provenance is a search, not a trace

## Context
The feature is called provenance and the mechanism is narrower than the name:
**DevFlow did not watch the value move.** It holds independent observations of one
recording — the bodies the server sent, the operations the stores took, the values
components were handed, the text the page showed — and looks for the same value in
all of them. `£42.00` in a response body, a store write and a cell is overwhelmingly
one value moving through an app; `2` in all four is a coincidence four times over.
The reader is the risk: an answer laid out in the direction data flows reads as a
journey, and a caveat placed underneath a four-layer answer arrives after the
conclusion has been drawn. The `v3.2.0` attempt at this was unreachable dead code
behind a tool that was never declared, which is why `tests/mcp-provenance.test.ts`
asserts it against `tools/list` and not only by calling it.

## Decision
`get_value_provenance` reports sightings of a value rather than a data-flow trace,
and says so in the tool description and at the top of every reply rather than in a
closing caveat.

## Consequences
The tool refuses to make the claim its users most want it to make, and that refusal
has to be re-stated in every renderer, which costs prose in the answer. Concretely:
layer order (backend, response, store, render, DOM) is presentation and never
causation, so two hits in adjacent layers are two sightings and not a link —
`get_causal_chain` is the tool that makes causal claims, out of evidence about events
rather than the equality of two strings. A value short enough to collide is called
out **above** the findings, not below them. A layer the recording never captured is
named as `unsearched` with the reason, in the words `FlowState` and `FlowRenders`
already use, because "the value is not in a response" and "this flow has no
responses" look identical as a missing section and a reader who cannot tell them
apart takes the first — which is a claim about the server made out of a setting.
Hits carry RFC 6901 pointers with `~0`/`~1` escaped, because an unescaped pointer
still looks like a pointer and addresses nothing.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
