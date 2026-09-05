/**
 * Two things the flow store promises about a flow it has just written.
 *
 * **An id names one flow, forever.** `saveAsFlow`'s rollback is written on that
 * promise in as many words — it takes the steps back on a failed index write
 * because "no later save overwrites it" — and the id was the millisecond alone,
 * so two archives in one millisecond broke it. The second save's steps land on
 * the first save's key, and the index then lists two rows that open the same
 * recording.
 *
 * **An undo puts back everything the delete took.** `restoreFlow` briefly kept a
 * module-level map of the last few deletes so a caller that passed only the
 * steps and the React table still restored the rest. The map is gone and the
 * argument is mandatory, which is the only version of that promise a call site
 * cannot quietly opt out of.
 *
 * The stub is the plain one from `audit-features-store.test.ts` rather than the
 * refusing one from `flow-store.test.ts`: nothing here is about a write failing.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteFlow,
  readFlow,
  restoreFlow,
  saveAsFlow,
} from '../src/features/flows/store.js';
import {
  savedFlowKey,
  savedFlowRendersKey,
  savedFlowStateKey,
  type FlowMeta,
  type FlowRenders,
  type FlowState,
  type Step,
} from '../src/shared/types.js';

const NOW = 1_700_000_000_000;

let store: Record<string, unknown>;

function installChrome(): void {
  store = {};

  const local = {
    get(keys: string | string[] | null, done: (items: Record<string, unknown>) => void) {
      const list = keys === null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
      const picked: Record<string, unknown> = {};
      for (const key of list) if (key in store) picked[key] = structuredClone(store[key]);
      done(picked);
    },
    set(items: Record<string, unknown>, done: () => void) {
      Object.assign(store, structuredClone(items));
      done();
    },
    remove(keys: string | string[], done: () => void) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      done();
    },
    getBytesInUse(_keys: unknown, done: (bytes: number) => void) {
      done(0);
    },
  };

  const empty = { get: (_keys: unknown, done: (items: unknown) => void) => done({}) };

  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (_request: unknown, done: (response: undefined) => void) => done(undefined),
    },
    storage: {
      local,
      sync: empty,
      managed: empty,
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
  };

  // `describeFlow` draws a thumbnail, which wants both even when no step has a
  // screenshot for it to draw.
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 200;
    naturalHeight = 100;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  (globalThis as { Image?: unknown }).Image = FakeImage;
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => undefined }),
      toDataURL: () => 'data:image/jpeg;base64,THUMB',
    }),
  };
}

/** One step, named so the flow it belongs to is readable off it. */
function step(label: string): Step {
  return {
    type: 'click',
    url: 'https://shop.test/cart',
    timestamp: NOW,
    stepNumber: 1,
    action: `Clicked ${label}`,
    screenshot: null,
    element: { selector: `#${label}` },
  } as unknown as Step;
}

beforeEach(() => {
  installChrome();
  // Frozen, which is the whole scenario: two archives inside one millisecond.
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('two flows archived in the same millisecond', () => {
  /**
   * `flow_<ms>` gave both saves one id. The second `setLocal` wrote its steps
   * over the first flow's — same key — and the recording the user archived
   * first was gone, with a success toast for it still on screen.
   */
  it('gives each of them an id of its own', async () => {
    const first = await saveAsFlow('Checkout', [step('first')]);
    const second = await saveAsFlow('Search', [step('second')]);
    if (!first.ok || !second.ok) throw new Error('a save was refused');

    expect(first.value.id).not.toBe(second.value.id);
  });

  it('keeps both recordings, and lists each of them once', async () => {
    const first = await saveAsFlow('Checkout', [step('first')]);
    const second = await saveAsFlow('Search', [step('second')]);
    if (!first.ok || !second.ok) throw new Error('a save was refused');

    const kept = await readFlow(first.value.id);
    expect(kept.ok && kept.value?.steps[0].action).toBe('Clicked first');

    const later = await readFlow(second.value.id);
    expect(later.ok && later.value?.steps[0].action).toBe('Clicked second');

    const index = store.savedFlowsMeta as FlowMeta[];
    expect(index.map((flow) => flow.id).sort()).toEqual(
      [first.value.id, second.value.id].sort(),
    );
  });

  /**
   * The id is opaque everywhere it goes — concatenated into a storage key,
   * never parsed — but a save that stopped answering to `savedFlow_<id>` would
   * strand its steps, so the shape is asserted once here rather than assumed at
   * five call sites.
   */
  it('files the steps under the id it hands back', async () => {
    const saved = await saveAsFlow('Checkout', [step('first')]);
    if (!saved.ok) throw new Error('save refused');

    expect(store[savedFlowKey(saved.value.id)]).toHaveLength(1);
  });
});

describe('the undo of a delete', () => {
  const STATE: FlowState = {
    read: true,
    stores: [{ id: 'cart', kind: 'context', label: 'CartContext' }],
  };
  const RENDERS: FlowRenders = { read: true, capped: true };

  beforeEach(() => {
    store[savedFlowStateKey('flow_1')] = STATE;
    store[savedFlowRendersKey('flow_1')] = RENDERS;
    store[savedFlowKey('flow_1')] = [step('kept')];
    store.savedFlowsMeta = [
      {
        id: 'flow_1',
        name: 'Checkout',
        createdAt: NOW,
        stepCount: 1,
        host: 'shop.test',
        bytes: 100,
        thumbnail: null,
        counts: { click: 1 },
        errorCount: 0,
      } satisfies FlowMeta,
    ];
  });

  /**
   * Four arguments, none of them defaulted. The bridge that used to make the
   * fourth optional was a module-level map: not shared with the tab that did
   * not make the delete, never cleared on any path that does not undo, and
   * indistinguishable at the call site from `restoreFlow` knowing something it
   * was never told. Arity is the assertion because the loss it prevents is
   * silent — a flow restored without its state reads exactly like one archived
   * by a build that never captured any.
   */
  it('cannot be called without what the delete took', () => {
    expect(restoreFlow.length).toBe(4);
  });

  it('puts every record back when the delete hands its own result over', async () => {
    const removed = await deleteFlow('flow_1');
    if (!removed.ok) throw new Error('delete refused');

    expect(store[savedFlowStateKey('flow_1')]).toBeUndefined();

    const back = await restoreFlow(
      removed.value.meta,
      removed.value.steps,
      removed.value.react,
      removed.value,
    );
    expect(back.ok).toBe(true);

    const flow = await readFlow('flow_1');
    expect(flow.ok && flow.value?.state).toEqual(STATE);
    expect(flow.ok && flow.value?.renders).toEqual(RENDERS);
  });
});

/**
 * A flow can be deleted from the library row and from the review tab, and the
 * two toasts both offer the way back. Read out of the source rather than driven
 * through the DOM: what is being asserted is not that the undo works — the
 * round-trip above is that — but that *both* call sites hand over the delete's
 * own result, and a surface that quietly assembled a partial one instead would
 * typecheck, render, and lose the same three records the fix was for. One of
 * the two is always the one somebody forgets; this is what remembers.
 */
describe('both surfaces that offer an undo', () => {
  const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

  /** The arguments of the one `restoreFlow` call in a file, trimmed. */
  function undoArguments(file: string): string[] {
    const source = readFileSync(resolvePath(root, file), 'utf8');
    const open = source.indexOf('restoreFlow(');
    if (open < 0) throw new Error(`no restoreFlow call in ${file}`);

    const inner = source.slice(open + 'restoreFlow('.length, source.indexOf(')', open));
    return inner
      .split(',')
      .map((argument) => argument.trim())
      .filter(Boolean);
  }

  it.each(['src/ui/viewer/library.ts', 'src/ui/viewer/review.ts'])(
    '%s restores everything the delete took',
    (file) => {
      const args = undoArguments(file);

      expect(args).toHaveLength(4);
      // `DeletedFlow` is a `RestorableRest`, so the delete's whole result is the
      // fourth argument and there is nothing to pick out of it by hand.
      expect(args[3]).toBe('removed.value');
    },
  );
});
