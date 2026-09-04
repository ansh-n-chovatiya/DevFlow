---
ctx_schema: 1
adr: 28
title: VISION.md is removed, and the aspiration behind six refusals is recorded here
status: accepted
date: 2026-09-04
---

# 0028. VISION.md is removed, and the aspiration behind six refusals is recorded here

## Context
VISION.md was the aspirational document — the grand architecture, ten novel capabilities, the eighteen-stage debugging loop, the two-to-three year picture. Seven of its ten section-7 capabilities shipped. Six other sections were decided against and carried ADR pointers added on 2026-09-04: 4.1 counterfactual replay (0024), 5 stages 12-18 (0009, held again in 0020), 7.3 the production time capsule (0018, a deferral), 7.4 prop drilling (0025), 7.9 the team ARKG (0023), and 10 Tier 3 (0021).

The owner asked for the file's removal on 2026-09-04, on the grounds that its contents are now implemented. That is true of seven sections and not of six. The objection was raised with that evidence, together with this repository's own status key — 'a deleted refusal is a question the next reader asks again, and answers worse' — and with the fact that keeping the file rather than cutting it was the owner's own decision earlier the same day. The owner reaffirmed. It is their call, and this ADR is how the cost is paid rather than avoided.

The six ADRs are immutable and unchanged. What a deletion loses is not the arguments — those survive in full — but the thing each argument was weighed against. An ADR reads as a refusal of something; without the aspiration in front of it, the next reader cannot judge whether the refusal was proportionate. So the aspiration is transcribed here.

## Decision
VISION.md is deleted. Its six refused or deferred sections are recorded below in the terms it used, so that the ADRs refusing them keep something to be measured against.

4.1 COUNTERFACTUAL BRANCHING REPLAY. 'Fork the recorded state at any step, inject a different event, and continue replaying in a sandbox.' Answering: what would have happened if the user had clicked Pay Now instead of Save for Later at step 7. Refused by 0024 — the state snapshot is capped at depth 6, 40 keys, 20 array entries, 200-character strings across at most 8 stores, and an application cannot be restored from a summary.

5, STAGES 12-18. The back half of an eighteen-stage autonomous loop: formulate an AST transformation plan, generate a minimal unified diff, apply it in an ephemeral workspace, run the tests, replay the flow, assert the fix, then open a branch and a PR with a before-and-after video. Refused by 0009 and held again by 0020 — DevFlow diagnoses and verifies; the caller is the model.

7.3 PRODUCTION TIME CAPSULE. Ingest a session recording from PostHog, FullStory or LogRocket; git checkout the exact build SHA from the incident timestamp; build and launch in a local Docker sandbox; seed the session's storage and cookies; inject production network responses from a HAR. 'A locally-running, faithful reproduction of a production bug without prod database or infrastructure access.' DEFERRED by 0018 rather than refused — wanted, unscheduled.

7.4 PROP DRILLING ELIMINATOR. Observe at runtime which data flows through drilling chains: props passed four or more levels without transformation, the same data fetched independently by sibling branches, context values read-only at every consumption site — and propose refactors with blast-radius analysis. Refused by 0025 — the problem is syntactic, and the half that would save work is 0009 again.

7.9 MULTI-DEVELOPER SESSION INTELLIGENCE. Detect two developers debugging one broken component at once and surface 'Alice found the root cause 20 minutes ago, here is her trace'; make known-broken flows shared team knowledge rather than siloed recordings. Refused by 0023 — the graph holds observations, never conclusions, and the payload would be the most sensitive thing the system produces.

10, TIER 3. An enterprise DevFlow backend agent giving automatic SQL capture and database column lineage. Refused by 0021 — it breaks Invariant 1, which the tier table's own last line forbids.

## Consequences
Three references are rewritten rather than left dangling: README.md's front-door link, ROADMAP_AND_PHASES.md's Session Replay Ingestion line which cited 'VISION §7.3 in full', and a comment in mcp-server/arkg.js naming 'the DAG in VISION.md'. Each now points at the ADR that carries the argument.

ROADMAP_AND_PHASES.md becomes the only forward-looking document, which is the simplification asked for. It already carries every refusal as a one-line entry with its ADR number, so nothing about what was decided is lost.

What is genuinely lost is the long-range picture: the two-to-three year vision, the competitive moat analysis, the prioritization matrix and the realistic-versus-moonshot assessment. None of those were decisions and none are recorded elsewhere. Recovering them means git history — the file is at VISION.md on any commit up to this one.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
