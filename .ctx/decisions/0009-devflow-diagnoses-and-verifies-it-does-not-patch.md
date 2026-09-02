---
ctx_schema: 1
adr: 9
title: devflow diagnoses and verifies, it does not patch
status: accepted
date: 2026-09-02
---

# 0009. devflow diagnoses and verifies, it does not patch

## Context
Work Stream 2.4 is a closed-loop repair loop: diagnose, patch, verify. The `v3.2.0`
attempt at the middle bullet was a hardcoded fake diff in a file that did not parse,
which is what a "patch generator" inside this server can actually be — DevFlow is
not a model and cannot write a patch, so anything it emitted would be a template
wearing a generator's name. The caller *is* a model: Claude Code, reading
`diagnose_failure`, `get_source_snippet`, `get_value_provenance` and
`get_causal_chain`, and everything that call needs is in place. "In-memory
application" has no honest form either: the application under test is served by the
user's own dev server, nothing here can substitute a module into it, and a version
that wrote to the working tree while calling itself in-memory would be editing
somebody's repository from a tool call and saying it had not.

## Decision
DevFlow ships the two ends of the repair loop — diagnosis (`diagnose_failure`) and
verification (`replay_flow`) — and refuses patch generation and in-memory patch
application outright.

## Consequences
The loop is not closed by this product, and a user who wanted a one-call fix does
not get one; the patch belongs to whoever can write one. The diagnosis end is
deliberately weakened to match what the evidence supports: `diagnose_failure` names
no cause, because `attributed` is temporal containment and `followed` is ordering,
and nothing in a recording distinguishes a coincidence from a culprit. The
verification end is weak too and says so: `replay_flow` answers with the responses
the recording captured, so a fault living in the server is mocked out of the run by
construction, and what a pass proves is that the journey through the interface
completes.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
