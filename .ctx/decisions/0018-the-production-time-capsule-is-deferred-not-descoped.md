---
ctx_schema: 1
adr: 18
title: the production time capsule is deferred, not descoped
status: accepted
date: 2026-09-03
---

# 0018. the production time capsule is deferred, not descoped

## Context
Work Stream 4.1b asks for session-replay ingestion: turn a PostHog, LogRocket or FullStory recording into a headless Playwright reproduction, re-injecting production network responses as mocks from a HAR archive. It sits in the roadmap beside 4.1a's webhook parser, which invites reading it as the same kind of work with more fields. It is not. VISION 7.3 spells out what it actually requires — ingest the session's DOM event sequence, git checkout the exact build SHA from the incident timestamp, build and launch the app in a Docker sandbox, seed it with the session's localStorage and cookies sanitised, and inject the production responses as mocks — and VISION 9 already files it under Moonshot-adjacent Long-Term, not Months 10-12. Every one of those five steps is a mechanism this product does not have: nothing here reads a third-party session format, nothing checks out a commit (core/git only reads), nothing builds or containerises anything, and nothing has ever written to a user's repository. 4.1a shares only the word production with it.

## Decision
4.1b is deferred to Phase 5 as the Production Time Capsule, whole, rather than started. Phase 4 closes with 4.1a — a relayed crash joined to source files — and the roadmap says which half shipped and which was deferred. Nothing else in Phase 4 depends on it.

## Consequences
A user who wanted a production bug reproduced locally does not get one, and the roadmap no longer implies they will in Phase 4. The deferral is whole rather than partial on 3.5's argument, re-applied: starting the HAR half and leaving the sandbox would leave a mechanism with no caller and a roadmap box that reads as progress. It also keeps the sandbox question — building and running somebody's application from a checkout DevFlow performed — with the other decisions of that size, where ADR 0009 already refuses to write to a working tree at all.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
