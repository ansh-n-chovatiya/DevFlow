---
ctx_schema: 1
adr: 10
title: trace headers are off by default and allow-listed per origin
status: accepted
date: 2026-09-02
---

# 0010. trace headers are off by default and allow-listed per origin

## Context
Header injection is the first thing DevFlow does that is not observation:
everything else reads `fetch`, `XMLHttpRequest`, fibers and the graph, while this
changes what a recorded application sends to its own backend. The hazard is exact.
A *simple request* may carry only CORS-safelisted headers; adding any other header
makes a **cross-origin** request non-simple, so the browser sends an `OPTIONS`
preflight where it sent none, and if the backend does not name the header in
`Access-Control-Allow-Headers` the browser **fails the request** and the page's own
`fetch` rejects. That is a working application broken by DevFlow being installed —
Invariant 1, and the same class of failure that got `v3.2.0` reverted in another
subsystem. There is no falling back, because by the time the browser reports it the
request the page was waiting on has already rejected.

**This was measured, not reasoned from the specification.** It had been checked from
the spec and from the server side with `curl`, and neither of those watches a
browser decide, so it was run against real Chromium (Playwright 1.62.1, Chromium
build 1234): a page on `http://localhost:4311` fetching an API on
`http://localhost:4312` that allows the origin and the method on **both** paths and
differs only in whether `Access-Control-Allow-Headers` names the header. With no
custom header, no `OPTIONS` at all and the request resolves. Against `/allowed`, a
preflight then the real request, header received. Against `/notallowed`,
`TypeError: Failed to fetch` and the real request **never sent** — *"Request header
field x-devflow-trace-id is not allowed by Access-Control-Allow-Headers in preflight
response"*. `traceparent` failed identically with the identical message: being a W3C
standard buys no exemption from the mechanism. The same-origin control resolved with
both headers and no preflight against a server sending no `Access-Control-*` headers
at all.

Two findings from that run sharpen the rules rather than confirm them. A failed
preflight leaves **no server-side evidence** — the API logged the `OPTIONS` and never
a `GET` — so a developer whose app breaks this way sees a failed fetch and nothing
whatsoever in their backend logs. And **DevFlow cannot observe the preflight**:
page-level instrumentation saw an outbound `GET` and then `net::ERR_FAILED`, because
Chromium makes the preflight in the network service and never surfaces it as a page
request, so any future "did our header break this?" diagnostic has the rejection
alone to work from.

## Decision
Trace headers are off by default, added only while a flow is recording, sent freely
same-origin and cross-origin only to an origin the user has explicitly named, never
over a `traceparent` the page already set — and the rule lives in a pure module,
`src/core/trace/index.ts`, where three inputs and an answer can reach it.

## Consequences
"Automatically add to all outbound requests" is the phrase that did not survive, and
the cost is real: the common SPA-on-:3000-calling-API-on-:8000 case is cross-origin,
so it works only after the user adds that origin to an allow-list. Informed consent
per backend is the only honest form this can take, because DevFlow cannot discover
whether a server allows a header without sending the request that might fail. Two
further costs are carried deliberately. `traceparent` and `X-DevFlow-Trace-Id` are
**two switches, not one**, because they differ in both directions — a W3C header is
likelier to be allowed already and likelier to *matter* if the page has its own
tracing, while the bespoke header is never accepted by accident, which makes it
strictly likelier to preflight-fail and strictly easier to grep for in a log, and
that greppability is the whole of its Tier 1 value. And the `traceparent` flags byte
is `01`, sampled, because an unsampled trace header has no purpose — a backend
running OpenTelemetry honours the incoming flag, so `00` would ask it to record
nothing and Tier 2 would have nothing to ingest. Said out loud rather than left in a
constant: **turning this on makes the user's backend record traces it would
otherwise have sampled away**, which is a line on somebody's observability bill and
a second reason for the default being off that has nothing to do with CORS. An id is
minted **per request**, never per flow or per step, because a W3C trace identifies
one distributed operation and a per-flow id would tell somebody's tracing system that
forty unrelated operations were one. A `Request` carrying a body is also left alone —
measured, not assumed: `new Request(req, { headers })` marks the original as
`bodyUsed`, which is why the ordinary `fetch(url, { body })` form is traced and the
`new Request(url, { body })` form is not.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
