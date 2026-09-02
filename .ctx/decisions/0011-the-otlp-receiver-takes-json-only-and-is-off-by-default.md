---
ctx_schema: 1
adr: 11
title: the OTLP receiver takes JSON only and is off by default
status: accepted
date: 2026-09-02
---

# 0011. the OTLP receiver takes JSON only and is off by default

## Context
Tier 2 receives spans from a user's own backend at `POST /v1/traces`. Two questions
had to be settled about that endpoint, and both cut against convenience.

**The wire format.** `application/x-protobuf` is the OTLP exporter *default*, so
refusing it is refusing what most users will send first. But a protobuf decoder is a
second wire format to get exactly right, and the failure mode of a subtly wrong
varint is not an error — it is a plausible number written into somebody's
accumulated graph, which is the shape of the two defects mutation-testing found in
Work Stream 3.4. Ids are also hex in OTLP/JSON and raw bytes in protobuf, so the two
paths diverge before parsing. The mitigating fact is that the user is already
editing exporter configuration to point it at DevFlow at all, so
`OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json` beside the URL they must set anyway
is a word rather than a step.

**The default.** `DEVFLOW_GIT` is on by default and `DEVFLOW_GIT=0` turns it off, on
the argument that it only reads, with a fixed argv, a directory this server already
opens files under. Every one of those three sentences is false for an OTLP receiver:
the input is unsolicited and from off the machine, it *writes* into the ARKG — the
accumulated graph a model is later asked to reason from — and nobody gets it by
accident, since pointing an exporter here is already deliberate work. Every other
write endpoint on this port is guarded by `extensionOrigin`, and this one **cannot**
be: the sender is the user's backend, which has no extension origin and never will.

## Decision
The OTLP endpoint accepts OTLP/JSON only, refusing protobuf with a `415` that names
the one line of exporter configuration which fixes it, and it is inert unless
`DEVFLOW_OTEL=1` is set on the server's own environment.

## Consequences
A user whose exporter defaults to protobuf gets a refusal rather than a feature, and
a user who sets up an exporter without reading gets a listener that ignores them —
discoverability is the price of both. `DEVFLOW_OTEL` is an environment variable and
not a `config.json` key deliberately: `POST /config` is reachable by any page the
browser visits, and a page that could set this would be choosing whether a listener
accepts writes. It is read per call, so a long-lived server picks up nothing stale.
The gate available here is the user having asked for it, and that is stated as what
it is: the store is **not** a security boundary and does not claim to be. A trace id
is 128 random bits, so attaching a fabricated span to a real recording means guessing
one; volume is the reachable nuisance and a cap on rows and on age is the answer,
with retention run off `received_at` — this machine's clock — and never off the
sender's `startUnixNano`, since a skewed clock is common and a lying one is free.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
