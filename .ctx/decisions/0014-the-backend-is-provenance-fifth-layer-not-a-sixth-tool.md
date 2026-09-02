---
ctx_schema: 1
adr: 14
title: the backend is provenance's fifth layer, not a sixth tool
status: accepted
date: 2026-09-02
---

# 0014. the backend is provenance's fifth layer, not a sixth tool

## Context
Work Stream 3.2 asks for wire-to-database lineage and specifies the tool as
`get_full_lineage(domNodeId)`. Two tools already answered halves of that question:
`get_value_provenance` traced a value across four observations of one recording, and
`get_backend_trace` said what the server did under a recorded request. The gap was
the join, not a missing renderer — and a third tool over one question is the mistake
this repository has already made once with its two markdown renderers, which is why
`src/core/mcp-bundle.ts` exists and why Work Stream 3.4 was deliberately built as a
join onto `compare_flows` rather than a second comparison. The signature does not
survive contact either: a recording **describes** an element — tag, text, label,
selector — and addresses none, so there is no `domNodeId` for anything to name.

## Decision
The backend became `traceValue`'s fifth layer, ordered first because a controller and
a query are upstream of the response body, and `get_full_lineage` is not built;
`value` plus the existing `step` argument (`valueOfStep`) are the handles that exist.

## Consequences
The tool gets larger and its reply has to hold two claims of different strengths
apart, permanently. Which call a span belongs to is **known** — the two are joined by
128 random bits DevFlow minted and the backend echoed, not by a string comparison,
and that is a stronger link than anything else in the module. But a span carries no
response body, so `£42.00` in a `db.query.text` and `£42.00` in a response body
remain two sightings and not a lineage. That is why `backend.paths` is a different
thing in the result from `hits`: a path says "this is the server-side work behind
that call" and a hit says "this text appeared in it". One span is one hit however
many of its fields matched, so the count stays a count of places. The value is
usually *not* in the query, and that was measured rather than assumed — a live
capture records `SELECT total_amount FROM invoices WHERE id = $1`, so a design that
made query text the mechanism would have shipped a feature answering almost nothing;
the chain is therefore printed whenever the value turned up at *either* end of the
call, and the query is shown exactly as the user's tracer recorded it and never
rewritten. Anyone who wants a `get_full_lineage` has to supersede this ADR, and any
new element addressing scheme would be an id nothing else in the product uses.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
