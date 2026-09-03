---
ctx_schema: 1
adr: 20
title: devflow still does not patch, so the self-healing ci bot is refused
status: accepted
date: 2026-09-03
---

# 0020. devflow still does not patch, so the self-healing ci bot is refused

## Context
Work Stream 4.5 asks for a CI fix bot: when CI fails, capture the runtime trace, isolate the root cause via the causal graph, apply a candidate fix, verify it in a sandbox, and comment the patch on the pull request. ADR 0009 refused patch generation and in-memory patch application for the whole product, and 4.5 is that refusal restated as a workflow rather than as a tool. Phase 4 made the case stronger rather than weaker in two places. 4.3's forensics tool names no cause on any answer, because the mechanism compares where commits sit in a history against one observation date and cannot tell a coincidence from a culprit — so the isolate the root cause step has nothing behind it that would justify acting. And 4.4's regression check found that what CI can observe of a replay is the journey and the wire; re-render counts and state need the extension, which does not load in Playwright's headless Chromium. So verify it in a sandbox would verify against a narrower observation than the one that found the bug.

## Decision
ADR 0009 is held, not superseded. Work Stream 4.5 is closed in the roadmap as a refusal pointing at it, in the roadmap's own voice. DevFlow ships the two ends — diagnosis and verification — and the patch belongs to whoever can write one, which is the model reading these tools.

## Consequences
The loop is still not closed by this product and the roadmap now says so at 4.5 as well as at 2.4, so a reader does not find the same promise made twice and answered once. A user who wanted a one-call fix does not get one. The user was asked and chose to hold the refusal on 2026-09-03. Overturning it later needs a new ADR that beats 0009's actual argument — that DevFlow is not a model, and that writing to a working tree from a tool call is editing somebody's repository while saying it has not — rather than one that outvotes it.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
