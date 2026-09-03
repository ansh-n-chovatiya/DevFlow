---
ctx_schema: 1
adr: 16
title: the living architecture map is a reading with an age, not a feed
status: accepted
date: 2026-09-03
---

# 0016. the living architecture map is a reading with an age, not a feed

## Context
`ROADMAP_AND_PHASES.md` §3.3 asked for a *real-time* component graph that
"updates in real-time as the developer navigates the app", answered by an MCP
tool `get_living_architecture()`. `.ctx/contexts/phase-3-remaining.ctx.md` costed
that and recorded the blocker: every path into the MCP server is the extension
**pushing** over loopback — `POST /flows`, `POST /config`,
`POST /arkg/ingest-component`, `POST /v1/traces` — and there is no channel from
the server back to an open tab. A model calling the tool needs an answer
synchronously from a page the server cannot address.

That framing is correct and it costs the wrong thing, because it assumes the tool
must **pull**. Two facts settle it. First, a model calling a tool asks once, at a
moment, and reads one answer: there is no frame to render a stream into and no
reader watching it arrive, so "real-time" for an MCP tool can only ever mean
*fresh at the moment it was read*. Second, the extension can already push, and
the page agent can already read a fiber tree — `injected/render.ts` walks one
under a node cap twice per interaction without installing anything.

So the channel a feed would need buys nothing a model can use — the answer is
still one snapshot taken at the moment of the call — while charging for a socket
the MV3 service worker must be kept awake to hold, on every page, for a feature
that may never be called. That is the trade `v3.2.0` made with its commit hook
and was reverted for.

## Decision
The Living Architecture Map is **one bounded reading, taken on demand, carrying
its own age**. `takenAt` is a required field of the reading rather than an
optional annotation; the server rejects a reading without one with `400`; the age
and the URL are rendered above anything a reader would act on; and past ten
minutes the wording changes from *this is mounted* to *this was the last reading,
take another* rather than the reading being withheld.

The reading carries **structure and never values** — component names, source
paths where the page knows them, and which contexts each component reads. There
is nowhere in the wire shape for a prop, a hook or a store value to sit.

Readings are held **in memory only**, the most recent eight pages, and are **not
written to the ARKG**.

## Consequences
The roadmap's signature is corrected in the roadmap, in the voice §3.2 and §3.4
already established for `get_full_lineage(domNodeId)` and
`compare_flows_across_deploys(flowId, sha1, sha2)`. A `url?` argument is added,
because readings are per page and the freshest is not always the one being asked
about.

**Active API calls are refused from the reading.** React keeps the mounted tree,
so it is readable in one pass; an in-flight request leaves no trace on that tree,
so recording one means ambient bookkeeping on every page the agent is injected
into. The endpoints an application calls are already in `get_app_architecture`.

**Nothing survives a server restart, and that is the point.** A saved map's only
possible use is to describe a page that is no longer open. This is why the work
stream adds no retention ceiling, no sweep and no config line.

**It does not accumulate.** A census of one moment folded into the graph would
inflate the counts the graph exists to keep honest: a component mounted on a page
nobody interacted with would count as often "seen" as one somebody exercised, and
`get_anomalies` reads those counts.

The live subscriber list inherits [[0005-module-level-zustand-stores-are-refused]]
exactly — a store with no provider leaves no dependency on a consumer's fiber —
and the answer says so rather than printing an empty section.

Superseding this needs an argument for something that needs the tree *between*
tool calls. Nothing in the extension does today.
