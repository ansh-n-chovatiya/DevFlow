---
ctx_schema: 1
adr: 15
title: one definition of which calls are traced
status: accepted
date: 2026-09-02
---

# 0015. one definition of which calls are traced

## Context
"Which calls in this recording carried a trace id" had two implementations: one in
`mcp-server`, one beside the renderers. They disagreed about something invisible —
the server's copy numbered steps **by position** in the array, while every renderer
beside it prefers the step's own `stepNumber`. So `get_backend_trace({ step })`
filtered on one number and printed the other. Nobody had seen it because DevFlow's
own sender renumbers flows on the way out, which makes the two agree for every
recording DevFlow itself produces; `POST /flows` accepts a flow from any page the
browser visits, so that was a reason the bug was hidden and not a reason to keep two
definitions. A wrong answer that reads exactly like a common right one is the failure
mode this repository has been bitten by more than once.

## Decision
`tracedCallsOf` lives in `src/core/otel` as the single definition, and all three
callers — two of them on the far side of the MCP bundle — read it from there.

## Consequences
The definition has to be pure and bundle-safe, which is why it sits in `core/` at
all, and any future caller on the server side must reach it through
`mcp-server/core.js` rather than reimplementing four lines that look trivial. The
general rule this is an instance of: when a question is asked in two places, the
second implementation is not a duplicate but a disagreement waiting to be found, and
the ones that hurt are the ones whose divergence is masked by DevFlow's own
well-behaved inputs.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
