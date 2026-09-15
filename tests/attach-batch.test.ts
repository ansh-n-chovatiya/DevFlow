/**
 * The batching that replaced five `getLocal`+`setLocal` round trips with one.
 *
 * `captureAndSave`, `attachDomDelta`, `attachDomChanges`, `attachStateDelta`,
 * `attachRenders` and `attachA11y` each used to own their own read-modify-write
 * of the whole `recordedSteps` array — up to six full round trips for one
 * user step. `AttachBatch` collects the five non-`captureAndSave` patches into
 * one flush; these tests are the two claims that matter: a burst of patches
 * costs exactly one read and one write, and a capture that lands mid-burst for
 * a step that does not exist yet cannot be swept into a flush scheduled before
 * it — `background/index.ts` cannot be imported to prove this end to end (it
 * registers listeners at import), so this proves it at the seam that can be:
 * the batch primitive and the flush function it drives, both pure and both
 * exported from `features/flows/attach-batch.ts`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ok, err } from '../src/shared/result.js';
import { flowError } from '../src/shared/errors.js';
import { stepKey } from '../src/core/flow/index.js';
import {
  applyA11y,
  applyDomChanges,
  applyDomDelta,
  applyRenders,
  applyStateDelta,
  createAttachBatch,
  runAttachFlush,
  type AttachOp,
  type LocalRead,
  type LocalWrite,
} from '../src/features/flows/attach-batch.js';
import type { LocalStorageShape, Step } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;

function step(over: Partial<Step> = {}): Step {
  return {
    type: 'click',
    url: 'https://app.example.com',
    timestamp: NOW,
    action: 'Clicked "Save"',
    stepNumber: 1,
    element: { tag: 'button', cssSelector: 'button', xpath: '//button', boundingBox: null },
    ...over,
  } as Step;
}

/** A counting fake of `getLocal`/`setLocal`, backed by one in-memory record. */
function fakeStorage(initial: Partial<LocalStorageShape>) {
  let value: Partial<LocalStorageShape> = { ...initial };
  let reads = 0;
  let writes = 0;

  const getLocal: LocalRead = (keys) => {
    reads++;
    const answer: Partial<LocalStorageShape> & Record<string, unknown> = {};
    for (const key of keys) (answer as Record<string, unknown>)[key] = (value as Record<string, unknown>)[key];
    return Promise.resolve(ok(answer));
  };

  const setLocal: LocalWrite = (items) => {
    writes++;
    value = { ...value, ...items };
    return Promise.resolve(ok());
  };

  return {
    getLocal,
    setLocal,
    get reads() {
      return reads;
    },
    get writes() {
      return writes;
    },
    get value() {
      return value;
    },
  };
}

describe('AttachBatch: push/take/seal', () => {
  it('tells the caller to arm a flush only on the first push since the last take', () => {
    const batch = createAttachBatch();
    const noop: AttachOp = () => {};

    expect(batch.push(noop)).toBe(true);
    expect(batch.push(noop)).toBe(false);
    expect(batch.push(noop)).toBe(false);
  });

  it('take clears the batch and re-arms the next push', () => {
    const batch = createAttachBatch();
    const noop: AttachOp = () => {};

    batch.push(noop);
    batch.push(noop);
    expect(batch.take()).toHaveLength(2);
    expect(batch.take()).toHaveLength(0);

    // A fresh batch after take — the next push is a first push again.
    expect(batch.push(noop)).toBe(true);
  });

  it('seal clears the batch without returning it, and re-arms the next push', () => {
    const batch = createAttachBatch();
    const noop: AttachOp = () => {};

    batch.push(noop);
    batch.seal();
    expect(batch.take()).toHaveLength(0);
    expect(batch.push(noop)).toBe(true);
  });
});

describe('the seal ordering a capture message relies on', () => {
  /**
   * Reproduces the exact hazard `AttachBatch.seal` exists to prevent, using
   * the same wiring `background/index.ts` does: a queue of "flush link"
   * markers standing in for `captureQueue`, an `AttachBatch` standing in for
   * `attachBatch`, and a `seal()` call standing in for the one
   * `CAPTURE_AND_SAVE_STEP` makes before queuing its own write.
   *
   * Without the seal, step B's own `STEP_RENDERS` message — arriving after
   * B's capture but while step A's patches are still un-flushed — would be
   * pushed into A's still-open batch and run in the link armed *before* B's
   * capture, finding no step B to attach to yet.
   */
  it('keeps a later step’s patches out of an earlier flush armed before the later step existed', () => {
    const chain: Array<'flush-A' | 'create-B' | 'flush-B'> = [];
    const batch = createAttachBatch();

    function queueAttach(op: AttachOp, tag: 'flush-A' | 'flush-B'): void {
      const first = batch.push(op);
      if (first) chain.push(tag);
    }

    // STEP_DOM_DELTA(A) — arms the first flush.
    queueAttach(() => {}, 'flush-A');

    // CAPTURE_AND_SAVE_STEP(B) — seals A's batch before queuing B's own write.
    batch.seal();
    chain.push('create-B');

    // STEP_RENDERS(B) — arrives after the seal, so it starts a fresh batch.
    queueAttach(() => {}, 'flush-B');

    expect(chain).toEqual(['flush-A', 'create-B', 'flush-B']);
  });

  it('is what background/index.ts actually calls before queuing a capture', () => {
    // `background/index.ts` registers `chrome.runtime` listeners at import and
    // cannot be loaded here — see `tests/background-toolbar.test.ts` — so this
    // is the same source-seam check that file already uses for wiring that
    // cannot be exercised directly.
    const source = readFileSync(new URL('../src/background/index.ts', import.meta.url), 'utf8');
    const caseStart = source.indexOf("case 'CAPTURE_AND_SAVE_STEP':");
    expect(caseStart).toBeGreaterThan(-1);

    const sealAt = source.indexOf('attachBatch.seal()', caseStart);
    const queueAt = source.indexOf('captureQueue = captureQueue.then(', caseStart);
    expect(sealAt).toBeGreaterThan(-1);
    expect(queueAt).toBeGreaterThan(-1);
    expect(sealAt).toBeLessThan(queueAt);
  });
});

describe('runAttachFlush: one round trip for a burst', () => {
  it('does exactly one read and one write for all five attachment kinds on one step', async () => {
    const target = step();
    const storage = fakeStorage({ recordedSteps: [target], recordingActive: true });

    const ops: AttachOp[] = [
      (state) => applyDomDelta(state, stepKey(target), 'before', 'after'),
      (state) => applyDomChanges(state, stepKey(target), [{ kind: 'text', where: 'p', what: 'hi' }], undefined, undefined),
      (state) => applyStateDelta(state, stepKey(target), [{ store: 's1', patch: [] }], [{ id: 's1', kind: 'zustand', label: 'cart' }]),
      (state) => applyRenders(state, stepKey(target), [{ component: 'Button', props: [] }], true, 'walk was cut'),
      (state) =>
        applyA11y(
          state,
          stepKey(target),
          [{ check: 'contrast', wcag: '1.4.3', level: 'AA', label: 'Save button', detail: '2.1:1, needs 4.5:1' }],
          undefined,
        ),
    ];

    const result = await runAttachFlush(ops, storage.getLocal, storage.setLocal);

    expect(result?.ok).toBe(true);
    expect(storage.reads).toBe(1);
    expect(storage.writes).toBe(1);

    const written = storage.value.recordedSteps?.[0];
    expect(written?.domDelta).toEqual({ before: 'before', after: 'after' });
    expect(written?.domChanges?.changes).toEqual([{ kind: 'text', where: 'p', what: 'hi' }]);
    expect(written?.state).toEqual([{ store: 's1', patch: [] }]);
    expect(written?.renders).toEqual([{ component: 'Button', props: [] }]);
    expect(storage.value.stateStores).toEqual([{ id: 's1', kind: 'zustand', label: 'cart' }]);
    expect(storage.value.flowRenders).toEqual({ read: true, capped: true, note: 'walk was cut' });
  });

  it('does no write at all when nothing in the batch changed anything', async () => {
    const target = step();
    const storage = fakeStorage({ recordedSteps: [target], recordingActive: true });

    // A domChanges patch for a step that is not in the array — the only thing
    // an un-batched `attachDomChanges` would have done here is the same no-op
    // read this does.
    const ops: AttachOp[] = [
      (state) => applyDomChanges(state, 'no such step', [], undefined, undefined),
    ];

    const result = await runAttachFlush(ops, storage.getLocal, storage.setLocal);

    expect(result).toBeNull();
    expect(storage.reads).toBe(1);
    expect(storage.writes).toBe(0);
  });

  it('does nothing at all, not even a read, for an empty batch', async () => {
    const storage = fakeStorage({ recordedSteps: [], recordingActive: true });
    const result = await runAttachFlush([], storage.getLocal, storage.setLocal);

    expect(result).toBeNull();
    expect(storage.reads).toBe(0);
    expect(storage.writes).toBe(0);
  });

  it('drops the whole batch, not just the step write, once the recording has stopped', async () => {
    const target = step();
    const storage = fakeStorage({ recordedSteps: [target], recordingActive: false });

    const ops: AttachOp[] = [(state) => applyDomDelta(state, stepKey(target), 'before', 'after')];
    const result = await runAttachFlush(ops, storage.getLocal, storage.setLocal);

    expect(result).toBeNull();
    expect(storage.writes).toBe(0);
  });

  it('surfaces a failed write as a failed Result, not a thrown error', async () => {
    const target = step();
    const reading: LocalRead = () => Promise.resolve(ok({ recordedSteps: [target], recordingActive: true }));
    const rejected: LocalWrite = () => Promise.resolve(err(flowError('STORAGE_QUOTA', 'full')));

    const ops: AttachOp[] = [(state) => applyDomDelta(state, stepKey(target), 'before', 'after')];
    const result = await runAttachFlush(ops, reading, rejected);

    expect(result?.ok).toBe(false);
  });

  it('threads flowRenders stickiness across every op in the batch, not just the last', async () => {
    const a = step({ timestamp: NOW, type: 'click' });
    const b = step({ timestamp: NOW + 1, type: 'click' });
    const storage = fakeStorage({ recordedSteps: [a, b], recordingActive: true });

    const ops: AttachOp[] = [
      (state) => applyRenders(state, stepKey(a), [], true, 'first cut'),
      (state) => applyRenders(state, stepKey(b), [], undefined, undefined),
    ];

    await runAttachFlush(ops, storage.getLocal, storage.setLocal);

    // The second call's `known` is the first call's result — capped and the
    // note both survive, exactly as three separate un-batched writes would
    // have produced by each reading the previous one's write back.
    expect(storage.value.flowRenders).toEqual({ read: true, capped: true, note: 'first cut' });
  });
});
