---
ctx_schema: 1
adr: 21
title: tier 3 database instrumentation is refused, and a span carrying SQL is not it
status: accepted
date: 2026-09-04
---

# 0021. tier 3 database instrumentation is refused, and a span carrying SQL is not it

## Context
ROADMAP_AND_PHASES.md $3.1 carries a three-tier backend model. Tiers 1 and 2 shipped. Tier 3 is described as "automatic SQL query capture (never prioritized over Tiers 1 & 2)", and the roadmap has carried it as a partial tick because a span carrying `db.query.text` is rendered and stored today. That is the confusion worth ending: what ships is Tier 2 data that happens to describe a query. The user's own tracer chose to record that text, under their own configuration, and DevFlow read it off an OTLP payload like every other span attribute. Tier 3 is DevFlow instrumenting the database itself — a mechanism nothing here has and nothing here is a step towards. Invariant 1 is the reason: a database agent is a dependency installed into somebody's infrastructure, which is the opposite of zero-app-dependency, and "What NOT to Build" already names custom DB agents as a distraction with OTel as the right answer.

## Decision
Tier 3 is refused rather than deferred. DevFlow does not instrument databases. SQL that arrives as a span attribute is displayed as what it is — the user's instrumentation, read — and is never rewritten, never parameterised, never tidied. Showing somebody a cleaned-up query their database never saw would be the wrong kind of helpful, and it would be indistinguishable in the answer from one that was really executed.

## Consequences
A user who wants query-level attribution gets it only as far as their own tracer records it, and DevFlow's answer says so. The roadmap stops carrying Tier 3 as an unfinished box, which it was never going to finish. Overturning this needs an argument that survives Invariant 1 — that is, a mechanism that attributes a query without anything being installed in the user's infrastructure.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
