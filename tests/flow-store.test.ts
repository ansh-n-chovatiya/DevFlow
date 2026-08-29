/**
 * The flow store against a storage area that can be made to fail.
 *
 * Everything covered here is a way the store could lose something and say
 * nothing: a viewer edit written over a capture that arrived while the user was
 * typing, a save whose index write failed leaving megabytes nothing can name, a
 * half-deleted flow that no longer answers to Delete, two index writes based on
 * the same read, and a thumbnail that never catches up with the picture it is
 * supposed to be of.
 *
 * `chrome.*` is not mocked globally, so the stub is hand-rolled here — with the
 * one thing a real storage area has and a happy-path fake does not: the ability
 * to refuse a write.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteFlow,
  listFlows,
  readFlow,
  renameFlow,
  saveAsFlow,
  updateFlowSteps,
  writeCurrent,
} from '../src/features/flows/store.js';
import { withoutImages } from '../src/features/flows/shots.js';
import { bytesInUse, getAllLocal } from '../src/chrome/storage.js';
import { deriveLibraryView } from '../src/ui/viewer/library-view.js';
import { savedFlowKey, savedFlowReactKey, type FlowMeta, type Step } from '../src/shared/types.js';

// ── The stub ─────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

interface Stub {
  store: Record<string, unknown>;
  /** Return a message to refuse the read of these keys. */
  failGet: ((keys: string[]) => string | null) | null;
  /** Return a message to refuse the write that carries these keys. */
  failSet: ((keys: string[]) => string | null) | null;
  failRemove: ((keys: string[]) => string | null) | null;
  /** Return a message to refuse `getBytesInUse`. */
  failBytes: string | null;
  bytes: number;
}

let stub: Stub;

/** Chrome reports failure through `lastError`, readable only in the callback. */
function withError<T>(message: string | null, deliver: () => T): T {
  const runtime = (globalThis as { chrome: { runtime: { lastError?: { message: string } } } }).chrome
    .runtime;
  runtime.lastError = message ? { message } : undefined;
  try {
    return deliver();
  } finally {
    runtime.lastError = undefined;
  }
}

function keyList(keys: string | string[] | null): string[] {
  if (keys === null) return Object.keys(stub.store);
  return Array.isArray(keys) ? keys : [keys];
}

function installChrome(initial: Record<string, unknown> = {}): void {
  stub = {
    store: structuredClone(initial),
    failGet: null,
    failSet: null,
    failRemove: null,
    failBytes: null,
    bytes: 4096,
  };

  const local = {
    get(keys: string | string[] | null, done: (items: Record<string, unknown>) => void) {
      const list = keyList(keys);
      const refusal = stub.failGet?.(list) ?? null;

      const picked: Record<string, unknown> = {};
      if (!refusal) {
        for (const key of list) {
          if (key in stub.store) picked[key] = structuredClone(stub.store[key]);
        }
      }
      withError(refusal, () => done(picked));
    },
    set(items: Record<string, unknown>, done: () => void) {
      const refusal = stub.failSet?.(Object.keys(items)) ?? null;
      if (!refusal) Object.assign(stub.store, structuredClone(items));
      withError(refusal, done);
    },
    remove(keys: string | string[], done: () => void) {
      const list = keyList(keys);
      const refusal = stub.failRemove?.(list) ?? null;
      if (!refusal) for (const key of list) delete stub.store[key];
      withError(refusal, done);
    },
    getBytesInUse(_keys: string | string[] | null, done: (bytes: number) => void) {
      withError(stub.failBytes, () => done(stub.bytes));
    },
  };

  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      // The worker is asleep as far as these tests are concerned, which is the
      // case the store already has to handle.
      sendMessage: (_req: unknown, done: (resp: undefined) => void) => withError(null, () => done(undefined)),
    },
    storage: { local },
  };
}

/**
 * A canvas and an `Image` that resolve without decoding anything.
 *
 * `makeThumbnail` is the slowest thing in an index write and the reason two of
 * them can overlap, so the tests need to hold it open on purpose. `release`
 * is what lets a decode finish.
 */
let pendingImages: (() => void)[] = [];
let holdImages = false;

function installCanvas(): void {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 200;
    naturalHeight = 100;

    set src(_value: string) {
      const finish = () => this.onload?.();
      if (holdImages) pendingImages.push(finish);
      else queueMicrotask(finish);
    }
  }

  (globalThis as { Image?: unknown }).Image = FakeImage;
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => undefined }),
      toDataURL: () => 'data:image/jpeg;base64,REDRAWN',
    }),
  };
}

function releaseImages(): void {
  const waiting = pendingImages;
  pendingImages = [];
  for (const finish of waiting) finish();
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function step(over: Partial<Step> = {}): Step {
  return {
    type: 'click',
    url: 'https://shop.example.com/cart',
    timestamp: NOW,
    action: 'Clicked "Buy"',
    screenshot: null,
    ...over,
  } as Step;
}

/** Steps as the recorder makes them: one per second, each its own moment. */
function recording(count: number, over: (index: number) => Partial<Step> = () => ({})): Step[] {
  return Array.from({ length: count }, (_, index) =>
    step({ timestamp: NOW + index * 1000, stepNumber: index + 1, ...over(index) }),
  );
}

function meta(over: Partial<FlowMeta> = {}): FlowMeta {
  return {
    id: 'flow_1',
    name: 'Checkout',
    createdAt: NOW,
    stepCount: 2,
    host: 'shop.example.com',
    bytes: 1234,
    thumbnail: 'data:image/jpeg;base64,ORIGINAL',
    counts: { click: 2 },
    errorCount: 0,
    ...over,
  };
}

beforeEach(() => {
  installChrome();
  installCanvas();
  holdImages = false;
  pendingImages = [];
});

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
  delete (globalThis as { Image?: unknown }).Image;
  delete (globalThis as { document?: unknown }).document;
});

// ── Bug 1: the viewer and the recorder erasing each other ────────────────────

describe('writeCurrent merges instead of overwriting', () => {
  /**
   * The worker's capture queue reads `recordedSteps`, then screenshots and
   * annotates for hundreds of milliseconds before writing its copy back. A
   * viewer that writes its whole in-memory array over the top of that loses
   * whichever landed first — and says "Saved" either way.
   */
  it('keeps a step captured while the user was annotating', async () => {
    const before = recording(5);
    stub.store.recordedSteps = [...before, step({ timestamp: NOW + 5000, stepNumber: 6 })];

    const edited = before.map((entry, index) =>
      index === 2 ? { ...entry, notes: 'the button is mislabelled' } : entry,
    );

    const written = await writeCurrent(edited, before);
    expect(written.ok).toBe(true);

    const stored = stub.store.recordedSteps as Step[];
    expect(stored).toHaveLength(6);
    expect(stored[2].notes).toBe('the button is mislabelled');
    expect(stored[5].timestamp).toBe(NOW + 5000);
    // The step the worker appended is numbered as part of the flow, not left
    // holding whatever number it was pushed with.
    expect(stored.map((entry) => entry.stepNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('matches steps by identity, so an insert does not shift the edit onto its neighbour', async () => {
    const before = recording(3);
    // The worker's capture landed first, in the middle of the array as far as
    // indexes are concerned.
    stub.store.recordedSteps = [...before, step({ timestamp: NOW + 3000, stepNumber: 4 })];

    await writeCurrent(
      before.map((entry, index) => (index === 0 ? { ...entry, notes: 'first' } : entry)),
      before,
    );

    const stored = stub.store.recordedSteps as Step[];
    expect(stored[0].notes).toBe('first');
    expect(stored.filter((entry) => entry.notes).length).toBe(1);
  });

  it('honours a deletion the user made', async () => {
    const before = recording(5);
    stub.store.recordedSteps = before;

    await writeCurrent(before.filter((_, index) => index !== 2), before);

    const stored = stub.store.recordedSteps as Step[];
    expect(stored).toHaveLength(4);
    expect(stored.some((entry) => entry.timestamp === NOW + 2000)).toBe(false);
  });

  /**
   * Discard says "This cannot be undone". A viewer still holding the steps must
   * not put them back on its next write — storage is the truth about what still
   * exists.
   */
  it('does not resurrect a recording discarded from the popup', async () => {
    const before = recording(5);
    stub.store.recordedSteps = [];

    const written = await writeCurrent(
      before.map((entry, index) => (index === 2 ? { ...entry, note: 'typed just now' } : entry)),
      before,
    );

    expect(written.ok && written.value).toEqual([]);
    expect(stub.store.recordedSteps).toEqual([]);
  });

  /**
   * A merge is only as safe as the copy it merges into. Reading `[]` out of a
   * failed read and writing that would empty the recording — the read failing is
   * exactly when the store must refuse to write at all.
   */
  it('refuses to write at all when it cannot read what is there', async () => {
    stub.store.recordedSteps = recording(5);
    stub.failGet = (keys) => (keys.includes('recordedSteps') ? 'Chrome would not read that' : null);

    const written = await writeCurrent([step()], recording(5));

    expect(written.ok).toBe(false);
    expect(stub.store.recordedSteps).toHaveLength(5);
  });

  it('defaults to keeping everything when no pre-edit copy is given', async () => {
    const before = recording(3);
    stub.store.recordedSteps = before;

    await writeCurrent([before[0]]);

    expect(stub.store.recordedSteps).toHaveLength(3);
  });
});

// ── Bug 3 (store side) / Bug 4: a save that fails leaves nothing behind ──────

describe('saveAsFlow', () => {
  it('archives the steps and lists them', async () => {
    const saved = await saveAsFlow('Checkout', recording(2));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(stub.store[savedFlowKey(saved.value.id)]).toHaveLength(2);
    expect((stub.store.savedFlowsMeta as FlowMeta[])[0].name).toBe('Checkout');
  });

  /**
   * Ids are `flow_<ms>` and never repeat, and "Delete all flows" removes only
   * what the index names — so a steps key the index never carried is bytes in a
   * 10 MB store that no screen lists and no button frees.
   */
  it('takes the steps back when the index write fails', async () => {
    stub.failSet = (keys) => (keys.includes('savedFlowsMeta') ? 'QUOTA_BYTES quota exceeded' : null);

    const saved = await saveAsFlow('Checkout', recording(2));
    expect(saved.ok).toBe(false);

    const orphans = Object.keys(stub.store).filter((key) => key.startsWith('savedFlow'));
    expect(orphans).toEqual([]);
  });

  it('refuses to archive nothing', async () => {
    expect((await saveAsFlow('Empty', [])).ok).toBe(false);
  });
});

// ── Bug 5: the ghost row ─────────────────────────────────────────────────────

describe('a flow whose steps are already gone', () => {
  beforeEach(() => {
    // Exactly what a delete that failed on its second write leaves behind.
    stub.store.savedFlowsMeta = [meta()];
  });

  it('reads as missing rather than as an empty flow', async () => {
    const flow = await readFlow('flow_1');
    expect(flow.ok && flow.value).toBeNull();
  });

  it('can still be deleted, which is the only way the row ever goes away', async () => {
    const removed = await deleteFlow('flow_1');

    expect(removed.ok).toBe(true);
    expect(stub.store.savedFlowsMeta).toEqual([]);
    // Nothing to hand back, which is the caller's signal not to offer an undo.
    expect(removed.ok && removed.value.steps).toEqual([]);
  });

  it('still refuses an id the index has never carried', async () => {
    expect((await deleteFlow('flow_nope')).ok).toBe(false);
  });

  /** The whole sequence: delete, index write fails, delete again. */
  it('lets the retry of a half-finished delete finish the job', async () => {
    stub.store[savedFlowKey('flow_1')] = recording(2);
    stub.failSet = (keys) => (keys.includes('savedFlowsMeta') ? 'Chrome said no' : null);

    expect((await deleteFlow('flow_1')).ok).toBe(false);
    expect(stub.store[savedFlowKey('flow_1')]).toBeUndefined();
    expect(stub.store.savedFlowsMeta).toHaveLength(1);

    stub.failSet = null;
    expect((await deleteFlow('flow_1')).ok).toBe(true);
    expect(stub.store.savedFlowsMeta).toEqual([]);
  });
});

// ── Bug 6: two index writes based on one read ────────────────────────────────

describe('concurrent index writes', () => {
  /**
   * `updateFlowSteps` holds its snapshot of the index across a full JPEG decode.
   * A rename that lands inside that window used to be reverted by the copy the
   * first call had been holding all along, with nothing on screen to say so.
   */
  it('does not let a slow step edit revert a rename made while it worked', async () => {
    stub.store.savedFlowsMeta = [meta()];
    stub.store[savedFlowKey('flow_1')] = recording(2);

    // Screenshots, because the window this bug lives in is a JPEG decode.
    const withImages = recording(3, () => ({ screenshot: 'data:image/jpeg;base64,SHOT' }));

    holdImages = true;
    const editing = updateFlowSteps('flow_1', withImages);

    // Let the edit get as far as the thumbnail, which is where it now waits.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingImages).toHaveLength(1);

    const renamed = await renameFlow('flow_1', 'Checkout — mobile');
    expect(renamed.ok).toBe(true);

    releaseImages();
    expect((await editing).ok).toBe(true);

    const flows = await listFlows();
    expect(flows.ok).toBe(true);
    if (!flows.ok) return;

    expect(flows.value[0].name).toBe('Checkout — mobile');
    expect(flows.value[0].stepCount).toBe(3);
  });

  it('keeps both edits when two flows are written at once', async () => {
    stub.store.savedFlowsMeta = [meta(), meta({ id: 'flow_2', name: 'Search' })];
    stub.store[savedFlowKey('flow_1')] = recording(2);
    stub.store[savedFlowKey('flow_2')] = recording(2);

    await Promise.all([updateFlowSteps('flow_1', recording(4)), renameFlow('flow_2', 'Search v2')]);

    const flows = await listFlows();
    expect(flows.ok).toBe(true);
    if (!flows.ok) return;

    expect(flows.value.find((flow) => flow.id === 'flow_1')?.stepCount).toBe(4);
    expect(flows.value.find((flow) => flow.id === 'flow_2')?.name).toBe('Search v2');
  });
});

// ── Bug 7: the thumbnail that never refreshes ────────────────────────────────

describe('when the library thumbnail is redrawn', () => {
  const shot = (mark: string) => `data:image/jpeg;base64,${mark}`;

  beforeEach(() => {
    stub.store.savedFlowsMeta = [meta()];
    stub.store[savedFlowKey('flow_1')] = recording(2, (index) => ({
      screenshot: index === 0 ? shot('BEFORE') : null,
    }));
  });

  function stored(): FlowMeta {
    return (stub.store.savedFlowsMeta as FlowMeta[])[0];
  }

  /**
   * Annotating step 1 replaces the picture the row is of without changing the
   * step count, which is all the old check looked at — so the row kept showing
   * the un-annotated original for the life of the flow.
   */
  it('redraws when the first screenshot was annotated', async () => {
    await updateFlowSteps(
      'flow_1',
      recording(2, (index) => ({ screenshot: index === 0 ? shot('ANNOTATED') : null })),
    );

    expect(stored().thumbnail).toBe('data:image/jpeg;base64,REDRAWN');
  });

  /**
   * A flow recorded with no screenshots saves with `thumbnail: null`. Importing
   * an image onto every step used to hand that same null straight back, so the
   * blank placeholder was permanent.
   */
  it('redraws when a flow that had no images finally gets one', async () => {
    stub.store.savedFlowsMeta = [meta({ thumbnail: null })];
    stub.store[savedFlowKey('flow_1')] = recording(2);

    await updateFlowSteps('flow_1', recording(2, () => ({ screenshot: shot('IMPORTED') })));

    expect(stored().thumbnail).toBe('data:image/jpeg;base64,REDRAWN');
  });

  it('leaves it alone when only a note changed', async () => {
    await updateFlowSteps(
      'flow_1',
      recording(2, (index) => ({
        screenshot: index === 0 ? shot('BEFORE') : null,
        note: 'still the same picture',
      })),
    );

    expect(stored().thumbnail).toBe('data:image/jpeg;base64,ORIGINAL');
  });

  it('still redraws when the shape of the flow changed', async () => {
    await updateFlowSteps('flow_1', recording(3, () => ({ screenshot: shot('BEFORE') })));

    expect(stored().thumbnail).toBe('data:image/jpeg;base64,REDRAWN');
    expect(stored().stepCount).toBe(3);
  });
});

// ── Bug 8: an unmeasurable store is not an empty one ─────────────────────────

describe('bytesInUse', () => {
  it('reports the figure when Chrome gives one', async () => {
    stub.bytes = 8_388_608;
    expect(await bytesInUse()).toBe(8_388_608);
  });

  /**
   * `0` was a figure, and the viewer footer and Settings both print it: "0 B
   * stored" under eight flows reads as room to spare, which is the opposite of
   * what a failed measurement means.
   */
  it('says nothing rather than zero when the measurement is refused', async () => {
    stub.failBytes = 'Storage area is unavailable';
    expect(await bytesInUse()).toBeNull();
  });

  it('hides the library footer for an unknown figure, and shows a real zero', () => {
    const base = { flows: [], current: { steps: [], recording: 'idle' as const }, query: '', sort: 'recent' as const, now: NOW };

    expect(deriveLibraryView({ ...base, usedBytes: null }).storage).toBeNull();
    expect(deriveLibraryView({ ...base, usedBytes: 0 }).storage).toEqual({ usedBytes: 0 });
  });
});

// ── The keys nothing names ───────────────────────────────────────────────────

describe('getAllLocal', () => {
  /**
   * "Delete all flows" derives its removal list from `savedFlowsMeta`, which is
   * exactly the list an orphan is missing from. Reading the whole area is the
   * only way to see a `savedFlow_<id>` key that nothing names — which is what
   * this exists for, and why it is only ever called from that button.
   */
  it('sees keys the index does not name', async () => {
    stub.store.savedFlowsMeta = [];
    stub.store[savedFlowKey('flow_stranded')] = recording(2);
    stub.store[savedFlowReactKey('flow_stranded')] = { components: {} };

    const all = await getAllLocal();
    expect(all.ok).toBe(true);
    if (!all.ok) return;

    expect(Object.keys(all.value).sort()).toEqual(
      [savedFlowKey('flow_stranded'), savedFlowReactKey('flow_stranded'), 'savedFlowsMeta'].sort(),
    );
  });

});

/*
 * The viewer decides whether a storage change is its own echo by fingerprinting
 * what it believes it wrote. `writeCurrent` hands back the steps carrying their
 * screenshots — that is what the screen shows — while what it puts in the key is
 * the same array with the images stripped to `shot_` keys. Marking the returned
 * form recorded a fingerprint the change event could never match, so the viewer
 * read every one of its own writes as somebody else's and repainted: rebuilding
 * the step list under a textarea the user had just left, which is the exact
 * failure that machinery exists to prevent.
 *
 * `withoutImages` is the transform `dehydrate` applies on the way in, so this is
 * the invariant `viewer/main.ts` relies on rather than a restatement of it.
 */
describe('what writeCurrent returns against what it stored', () => {
  const shot = `data:image/jpeg;base64,${'A'.repeat(500)}`;

  it('differ only by the images, so the stored form is recoverable', async () => {
    const before = recording(3, () => ({ screenshot: shot }));
    stub.store.recordedSteps = before.map(withoutImages);
    for (const entry of before) {
      stub.store[`shot_${entry.timestamp}:${entry.type}`] = { s: shot, o: null };
    }

    const edited = before.map((entry, index) =>
      index === 1 ? { ...entry, notes: 'looks wrong here' } : entry,
    );

    const written = await writeCurrent(edited, before);
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    // What the viewer got back still carries the pictures, for the screen.
    expect(written.value[1].screenshot).toBe(shot);
    // What onChanged will deliver does not — and the two agree once the same
    // transform is applied, which is all the marker needs.
    expect(written.value.map(withoutImages)).toEqual(stub.store.recordedSteps);
  });

  it('holds when the worker appended a step mid-edit', async () => {
    const before = recording(2, () => ({ screenshot: shot }));
    stub.store.recordedSteps = [
      ...before.map(withoutImages),
      withoutImages(step({ timestamp: NOW + 5000, stepNumber: 3, screenshot: shot })),
    ];

    const written = await writeCurrent(before, before);
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    expect(written.value).toHaveLength(3);
    expect(written.value.map(withoutImages)).toEqual(stub.store.recordedSteps);
  });

  /*
   * Structural, like tests/react-server-guard.test.ts: the invariant above is
   * only worth anything if the viewer actually applies it, and `main.ts` is a
   * module with top-level side effects that cannot be imported to be asked.
   * What can be checked is that no marker for this key is taken straight from
   * what `writeCurrent` returned — which is the whole of the original bug.
   */
  it('is applied by the viewer, not merely available to it', () => {
    const viewer = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/ui/viewer/main.ts'),
      'utf8',
    );

    expect(viewer).toContain('markSelfWriteSteps');
    expect(viewer).not.toMatch(/markSelfWrite\(\s*'recordedSteps'\s*,\s*\w+\.value\s*\)/);
  });
});
