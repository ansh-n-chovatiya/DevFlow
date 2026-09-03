---
ctx_schema: 1
adr: 22
title: the living map reads the mounted tree, and in-flight requests are not on it
status: accepted
date: 2026-09-04
---

# 0022. the living map reads the mounted tree, and in-flight requests are not on it

## Context
ROADMAP_AND_PHASES.md $3.3 asks the Living Architecture Map to show "active API calls" beside the mounted component tree. The two look like one feature and are not. A mounted tree is readable in a single pass because React keeps it — `src/injected/architecture.ts` walks it breadth-first under the recorder's own node cap, installs nothing, patches nothing, subscribes to nothing, and takes one reading rather than two. An in-flight request leaves no trace on that tree. There is nothing to walk. Recording one means ambient bookkeeping — a wrapper or an observer live on every page the agent is injected into, which is every page — kept running for a feature the user may never have switched on. That is precisely the trade `v3.2.0` made with its commit hook, and it is what that release was reverted for.

## Decision
Active API calls are not in the living reading, and this is a refusal rather than an omission. The reading is what React already holds. The endpoints an application calls are answered by `get_app_architecture` from the accumulated graph, labelled as accumulated, and the living answer points there rather than printing an empty section that reads as "this application calls nothing".

## Consequences
The map answers "what is mounted right now" and not "what is in flight right now", and the difference is stated in the answer. It keeps ADR 0016's rule intact — the map is a reading with an age, not a feed — because a feed is exactly what ambient bookkeeping would turn it into. Overturning this needs a way to observe in-flight requests that costs nothing on a page where the feature is off; the recorder's own network capture is not one, because it runs only while somebody has pressed Start.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
