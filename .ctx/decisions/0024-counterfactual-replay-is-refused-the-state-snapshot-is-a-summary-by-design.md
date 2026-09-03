---
ctx_schema: 1
adr: 24
title: counterfactual replay is refused: the state snapshot is a summary by design
status: accepted
date: 2026-09-04
---

# 0024. counterfactual replay is refused: the state snapshot is a summary by design

## Context
ROADMAP_AND_PHASES.md $5.2 carries the Counterfactual Replay Engine as a moonshot: fork the recorded state at any step, inject a different event, and continue replaying in a sandbox — "what would have happened if the user had clicked Pay Now instead of Save for Later at step 7?". Two things decide it, and the first is the cheaper one. The question is usually answerable by recording it: click Pay Now, and DevFlow produces a complete, correct flow rather than a simulated one. Counterfactual replay only earns its keep where the branch point cannot be reached again — rare state, a race, a server response that will not recur — and that is exactly where the second thing bites. The proposed mechanism is to "re-seed a headless Playwright session with the logical state snapshot at the fork point", and DevFlow's state snapshot cannot re-seed anything. It is capped, deliberately, at depth 6, 40 keys per object, 20 array entries and 200-character strings, across at most 8 stores. Those caps are not a budget to be raised: they are what makes reading a page's state safe to do on every interaction, and `src/injected/state.ts` refuses to install, patch or subscribe to anything precisely so the reading stays a reading. What they produce is a summary. An application cannot be restored from a summary that truncated its strings at 200 characters and stopped at depth 6, and one restored from a partial summary would be a different application answering a different question — while looking, in the report, exactly like the real one.

## Decision
$5.2 is refused and removed from the roadmap. The moonshot is blocked by an invariant the project chose on purpose, and the cheap path — record the other branch — already ships.

## Consequences
DevFlow answers what happened, not what would have happened, and says so. The state caps stay a shape decision rather than a budget, which is what keeps state capture cheap enough to leave on. What would overturn this is not a bigger cap but a fundamentally different capture — a complete, restorable state image — and that is a different product with different costs, which would have to argue its way past the reason `state.ts` reads rather than subscribes.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
