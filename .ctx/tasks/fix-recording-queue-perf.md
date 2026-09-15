---
ctx_schema: 1
task: fix-recording-queue-perf
level: 1
status: done
created: 2026-09-15
closed: 2026-09-15
verify:
  - kind: cmd
    run: npm run verify
---

## Objective
The five step-attachment messages (`STEP_DOM_DELTA`, `STEP_DOM_CHANGES`, `STEP_STATE_DELTA`, `STEP_RENDERS`, `STEP_A11Y`) coalesce into a single `chrome.storage.local` read+write per burst instead of one each, and `finishRecording()` can never hang indefinitely regardless of incoming capture traffic.

## Acceptance criteria
1. ✅ `attachDomDelta`, `attachDomChanges`, `attachStateDelta`, `attachRenders`, and `attachA11y` no longer each independently `getLocal`+`setLocal` — their per-step fields (domDelta, domChanges, stateDelta, renders, a11y) and the two top-level accumulators they touch (`stateStores`, `flowRenders`) are applied to an in-memory snapshot and flushed with one read + one write per burst, not one read+write per message. Landed as `src/features/flows/attach-batch.ts` (`applyDomDelta`/`applyDomChanges`/`applyStateDelta`/`applyRenders`/`applyA11y`, `createAttachBatch`, `runAttachFlush`), wired thin into `src/background/index.ts` (`queueAttach`, `flushAttachBatch`).
2. ✅ Verified directly: `tests/attach-batch.test.ts` › "does exactly one read and one write for all five attachment kinds on one step" calls `runAttachFlush` with all five patch kinds against a call-counting fake storage and asserts `reads === 1`, `writes === 1`.
3. ✅ Verified via `AttachBatch.seal()`: `tests/attach-batch.test.ts` › "keeps a later step's patches out of an earlier flush armed before the later step existed" reproduces the exact ordering hazard against the primitive; a second test reads `src/background/index.ts` and asserts `attachBatch.seal()` textually precedes the `captureQueue = captureQueue.then(...)` inside the `CAPTURE_AND_SAVE_STEP` case (the module can't be imported to test this end-to-end — same constraint `tests/background-toolbar.test.ts` documents).
4. ✅ `src/features/flows/drain.ts`'s `waitForStable` (bounded by `DRAIN_MAX_WAIT_MS`=8000/`DRAIN_MAX_ITERATIONS`=200 in `src/shared/constants.ts`), wired into `finishRecording()`. `tests/drain.test.ts` covers: settles like the original loop for an already-idle queue, drains a finite backlog, gives up on iteration bound, gives up on wall-clock bound, and — the regression that matters — a runaway queue that never stops growing still returns inside a tight 2000ms test timeout instead of hanging the test.
5. ✅ Preserved by construction: `applyStateDelta`/`applyRenders` in `attach-batch.ts` are the same merge logic (dedup-by-id, sticky `capped`/`note`) moved verbatim off `background/index.ts`, now unit-tested directly (`tests/attach-batch.test.ts`, plus the rewritten `tests/dom-changes.test.ts`/`tests/render-sampling.test.ts` cases that used to regex-match the old inline functions).
6. ✅ `npm run verify` — exit 0, checked directly (not through `tail`): 207 test files / 4134 tests passed, typecheck/lint/all lint gates/build clean. `CHANGELOG.md` `## Unreleased` entry added and `npm run lint:changelog` passes (separate CI gate, not part of `verify`).

## Notes
Root cause identified in prior conversation (not yet in `report.md`, which covers security/durability/fidelity/docs, not this class of bug).

**Correction after reading `src/features/flows/shots.ts` and `src/shared/constants.ts:11-25`:** screenshots are *not* inline in `recordedSteps` — that exact O(n²) failure mode (measured in `shots.ts`'s own header comment: 0.3GB written by step 30, 12.5GB by step 200, worker OOM-killed before step 500) was already fixed by moving images to their own `shot_<key>` storage keys, and `constants.ts` carries the *after* measurement too: "with them in a key each... step 500 is 0.8 ms against 150 KB." That means a single `recordedSteps` write, even at the step cap, is sub-millisecond today — **not** the "hang the whole PC" magnitude the earlier root-cause writeup in this conversation claimed. That framing was wrong; flagging it here rather than quietly fixing the number, since the original diagnosis is what the user asked to act on.

What's still true and still worth fixing, at a corrected, smaller scale:

- Every capture-related message chains onto a single module-level `captureQueue` promise (`src/background/index.ts:1717-1788`, message types `STEP_DOM_DELTA`, `STEP_DOM_CHANGES`, `STEP_STATE_DELTA`, `STEP_RENDERS`, `STEP_A11Y`, `CAPTURE_AND_SAVE_STEP`).
- `attachDomDelta` (~L568), `attachDomChanges` (~L596), `attachStateDelta` (~L630), `attachRenders` (~L680), `attachA11y` (~L728) each independently do `getLocal(['recordedSteps', ...])` → mutate one entry → `setLocal({ recordedSteps })`, rewriting the whole array every time — up to 5 extra full-array round trips on top of `captureAndSave`'s own write, for one user step. `attachStateDelta`/`attachRenders` also read-modify-write the top-level `stateStores`/`flowRenders` keys with real merge logic (dedup by store id; sticky `capped`/`note`) that any batching has to preserve.
- Fix shape landed: a shared in-memory "attach batch" — `attachDomDelta`/`attachDomChanges`/`attachStateDelta`/`attachRenders`/`attachA11y` become synchronous functions that push a patch closure into a pending-ops list and arm (once) a single `captureQueue.then(flushAttachOps)` link; the flush does one `getLocal`, replays every queued patch against the in-memory snapshot, and one `setLocal`. `captureAndSave` calls `sealAttachBatch()` before queuing its own work, swapping in a fresh pending-ops array so a batch armed *before* it can't absorb attachment messages that logically belong *after* it (see criterion 3) — without this a batch's flush could run before the step it's patching exists.
- `captureAndSave` itself is left as its own immediate write (not merged into the batch) — see criterion 3's parenthetical for why.
- `finishRecording()` (`src/background/index.ts:762-791`) drains the queue with `do { drained = captureQueue; await drained } while (drained !== captureQueue)` — if new work keeps arriving faster than the queue drains, this never stabilizes, which is why Stop can hang. Needs a bounded cutoff (iteration count or wall-clock timeout) that still flushes pending work once, rather than looping forever.
- `src/chrome/storage.ts` is the only file allowed to call `chrome.storage.*` per this repo's conventions — the batching primitive lives in `src/background/index.ts` and still routes through `getLocal`/`setLocal`.
