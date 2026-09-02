---
ctx_schema: 1
adr: 12
title: a span is an event, so services and operations are the node kinds
status: accepted
date: 2026-09-02
---

# 0012. a span is an event, so services and operations are the node kinds

## Context
Ingesting OTel spans meant deciding what a span may *become* in a graph that
outlives the recording. The obvious modelling — a node per span — fails the rule the
whole ARKG is built on: a span has a random 64-bit id, happens once and is never
seen again, so a node per span is a node per request, and the graph stops being an
accumulation and becomes a log. That is the `caused_by` rule (a link reaches the
graph only when *both* ends project onto something it already keys stably) biting
harder here than anywhere else. What is stable across recordings is the **service**
(`service.name`, chosen by whoever deployed it) and the **operation** (that service
plus the span's name), and a span is an observation *of* an operation exactly as a
network call is an observation of an endpoint.

The same rule then disqualifies a span whose trace id matches no recorded call: it
has one end only. But dropping it on arrival was measured to be wrong. Against a
real exporter, **spans arrive before the recording does** — a backend exports within
seconds of serving the request, while the person driving the browser reviews the flow
and presses Send whenever they are ready — so a receiver that dropped everything it
could not immediately join would drop very nearly all of them and the feature would
look broken.

## Decision
Spans are projected onto `service` and `operation` nodes and never onto a node of
their own; unjoined spans are held in a capped, expiring store — a separate database
from `arkg.db`, because a waiting room is not graph data — and the join runs at flow
ingest as well as at span ingest.

## Consequences
Nothing in the graph can answer a question about one particular span, and per-request
backend detail lives only in the waiting store until it joins and then only as an
observation of an operation. Because the join runs at flow ingest, **re-sending a
recording is how a late trace gets joined at all** — the same property `changed_in`
has, and the same surprise. Operation names collapse opaque path segments through
`normaliseUrl`, reusing the endpoint rule rather than writing a second one that
disagrees, and collapsing *only* path-shaped runs so DevFlow's graph does not
disagree with the user's own tracing UI about what a thing is called. Two wiring
consequences were worth going back for: backend nodes age out on the ordinary
retention sweep, because every other node kind is created at the rate a person
records while these are created by an endpoint nothing on this machine paces, and
they count towards a graph being non-empty, because "services and no recordings" is
the *ordinary* intermediate state and previously read as a fresh install. One gap is
named rather than refused: `explain_feature` has no `service` or `operation` entity
kind, so a backend node cannot be found by name even though `get_app_architecture`
lists it and `getNeighbours` walks onto it correctly.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
