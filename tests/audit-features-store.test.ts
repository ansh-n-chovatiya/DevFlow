/**
 * Two ways the flow store threw away something the user still had.
 *
 * Both are the same shape: a record that was added to a flow after the store
 * was written, and that the paths which already handled the React table never
 * learned about. `savedFlowFrameworks_`, `savedFlowState_` and
 * `savedFlowRenders_` are deleted with a flow and read back with it, and the
 * two operations in between — editing the steps, and undoing a delete — each
 * knew about only some of them.
 *
 * The stub is hand-rolled rather than borrowed from `flow-store.test.ts`,
 * because these tests want a storage area that answers plainly and that file's
 * one is built to refuse things.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteFlow,
  restoreFlow,
  readFlow,
  updateFlowSteps,
} from '../src/features/flows/store.js';
import {
  savedFlowFrameworksKey,
  savedFlowKey,
  savedFlowRendersKey,
  savedFlowStateKey,
  type FlowComponents,
  type FlowMeta,
  type FlowRenders,
  type FlowState,
  type Step,
} from '../src/shared/types.js';

const NOW = 1_700_000_000_000;
const ID = 'flow_1';

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

  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (_request: unknown, done: (response: undefined) => void) => done(undefined),
    },
    storage: { local, sync: { get: (_k: unknown, done: (i: unknown) => void) => done({}) } },
  };

  // `describeFlow` redraws a thumbnail on a structural edit, which needs both.
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
  (globalThis as { fetch?: unknown }).fetch = () => Promise.reject(new Error('offline'));
}

/** One step, carrying a Vue chain naming one component. */
function step(index: number, componentId: string): Step {
  return {
    type: 'click',
    url: 'https://shop.test/cart',
    timestamp: NOW + index * 1000,
    stepNumber: index + 1,
    action: `Clicked ${componentId}`,
    screenshot: null,
    element: { selector: `#${componentId}`, frameworks: [{ framework: 'vue', chain: [componentId] }] },
  } as unknown as Step;
}

const VUE: FlowComponents = {
  detected: true,
  version: '3.4.0',
  components: {
    kept: { name: 'CartRow', status: 'resolved', source: 'src/CartRow.vue' },
    dropped: { name: 'Coupon', status: 'resolved', source: 'src/Coupon.vue' },
  },
};

const STATE: FlowState = { read: true, stores: [] as FlowState['stores'] };
const RENDERS: FlowRenders = { read: true, capped: true };

function metaFor(stepCount: number): FlowMeta {
  return {
    id: ID,
    name: 'Checkout',
    createdAt: NOW,
    stepCount,
    host: 'shop.test',
    bytes: 100,
    thumbnail: null,
    counts: { click: stepCount },
    errorCount: 0,
  };
}

beforeEach(() => {
  installChrome();
  store.savedFlowsMeta = [metaFor(2)];
  store[savedFlowKey(ID)] = [step(0, 'kept'), step(1, 'dropped')];
  store[savedFlowFrameworksKey(ID)] = { vue: VUE };
  store[savedFlowStateKey(ID)] = STATE;
  store[savedFlowRendersKey(ID)] = RENDERS;
});

describe('editing a saved flow', () => {
  /**
   * The React table has been pruned on an edit since the store was written, and
   * the framework tables never were — so a Vue flow with a step deleted went on
   * shipping the source path of a component nothing in it points at, into every
   * export and every send. `buildFlowFrameworks` states the rule; this is the
   * caller that was not following it.
   */
  it('prunes the framework tables to the steps that survive', async () => {
    const written = await updateFlowSteps(ID, [step(0, 'kept')]);
    expect(written.ok).toBe(true);

    const tables = store[savedFlowFrameworksKey(ID)] as Record<string, FlowComponents>;
    expect(Object.keys(tables.vue.components)).toEqual(['kept']);
    // Everything the table said about itself survives the prune.
    expect(tables.vue.version).toBe('3.4.0');
  });

  it('leaves a table alone when every step it names is still there', async () => {
    await updateFlowSteps(ID, [step(0, 'kept'), step(1, 'dropped')]);

    const tables = store[savedFlowFrameworksKey(ID)] as Record<string, FlowComponents>;
    expect(Object.keys(tables.vue.components).sort()).toEqual(['dropped', 'kept']);
  });
});

describe('undoing a delete', () => {
  /**
   * The delete removed five keys and the undo put back two. Every flow archived
   * by a current build carries a state and a render record, so the flow that
   * came back said "this recording says nothing about state" — which is what a
   * flow recorded by a build that never captured any reads as, and is
   * unrecoverable once the delete has run.
   */
  it('puts back the state, the renders and the framework tables', async () => {
    const removed = await deleteFlow(ID);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;

    expect(store[savedFlowStateKey(ID)]).toBeUndefined();

    // The delete's own result is what goes back: it *is* a `RestorableRest`, so
    // the undo has nothing to assemble and nothing to leave out.
    const back = await restoreFlow(
      removed.value.meta,
      removed.value.steps,
      removed.value.react,
      removed.value,
    );
    expect(back.ok).toBe(true);

    const flow = await readFlow(ID);
    expect(flow.ok && flow.value?.state).toEqual(STATE);
    expect(flow.ok && flow.value?.renders).toEqual(RENDERS);
    expect(flow.ok && flow.value?.frameworks).toEqual({ vue: VUE });
  });

  it('hands the three back on the delete, so a caller can pass them itself', async () => {
    const removed = await deleteFlow(ID);
    if (!removed.ok) throw new Error('delete refused');

    expect(removed.value.state).toEqual(STATE);
    expect(removed.value.renders).toEqual(RENDERS);
    expect(removed.value.frameworks).toEqual({ vue: VUE });
  });

  /** A flow that genuinely had none must not acquire another flow's records. */
  it('writes nothing for a flow that had none', async () => {
    delete store[savedFlowStateKey(ID)];
    delete store[savedFlowRendersKey(ID)];
    delete store[savedFlowFrameworksKey(ID)];

    const removed = await deleteFlow(ID);
    if (!removed.ok) throw new Error('delete refused');
    await restoreFlow(
      removed.value.meta,
      removed.value.steps,
      removed.value.react,
      removed.value,
    );

    expect(store[savedFlowStateKey(ID)]).toBeUndefined();
    expect(store[savedFlowRendersKey(ID)]).toBeUndefined();
    expect(store[savedFlowFrameworksKey(ID)]).toBeUndefined();
  });
});
