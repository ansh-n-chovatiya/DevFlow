---
ctx_schema: 1
adr: 23
title: the team ARKG is refused: the graph holds observations, not conclusions
status: accepted
date: 2026-09-04
---

# 0023. the team ARKG is refused: the graph holds observations, not conclusions

## Context
ROADMAP_AND_PHASES.md $5.1 asks for a Team ARKG — merge graph data across developers, detect two people debugging the same broken component, and surface shared institutional knowledge: "Alice found the root cause of this 20 minutes ago". The problem is real; duplicated debugging costs teams hours. The instrument is wrong, and the reason is in the schema rather than in the effort. The ARKG holds components, endpoints, source files, state keys, flows and commits, with frequencies, timings and failure rates. It has never held a conclusion. Nothing in it records that somebody understood something, because nothing DevFlow observes is a person's understanding — it observes what a browser did. Merge ten developers' graphs and the result is aggregate statistics about which components are seen most often, which is not the sentence the roadmap promises and cannot be derived from it. Delivering that sentence needs people to write findings down, which is a wiki with a different data model, a different UI and a different failure mode. Beside that, the payload is the most sensitive thing the system produces: recordings taken by developers against their own local environments and real data, which today never leave the machine. Syncing them needs a service, an identity model, an authorisation model and a privacy review, none of which exists, in order to ship a feature the data cannot support.

## Decision
$5.1 is refused, not deferred, and removed from the roadmap. DevFlow's graph accumulates observations; it does not accumulate conclusions, and a cross-developer merge of observations does not become a conclusion by being larger.

## Consequences
The roadmap stops promising team intelligence, and DevFlow stays a single-developer local tool with no service behind it — which is also what keeps every recording on the machine that made it. What would overturn this is not scale but a new node kind: something that records a person's finding, deliberately entered, with the same care about identity the graph already demands of every other node. That is a different product decision and should be argued as one, not arrived at by turning on sync.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
