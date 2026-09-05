/**
 * An archived flow must not be sent carrying the live recording's context.
 *
 * `sendFlow` took its archived arguments with `??`, which reads `null` as "the
 * caller said nothing" and falls through to the live recording's own state,
 * renders and React table. But `null` is what an archived flow says when it
 * genuinely has none — a recording made before state capture existed, or on a
 * page with no React — and the send dialog was collapsing that `null` to
 * `undefined` before the call, so the two could not be told apart at all.
 *
 * What the user then hands to Claude is a week-old flow stamped with this
 * afternoon's stores and this afternoon's component sources: not a gap in the
 * context but a wrong one, which for this product is the worse failure of the
 * two. The distinction is now `=== undefined`, and these are the tests that say
 * which way each argument falls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEND_EVERYTHING, sendFlow } from '../src/features/mcp/send.js';
import type { FlowPayload, FlowState, Step } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;
const RECORDED_AT = 1_600_000_000_000;

let store: Record<string, unknown>;
/** Every body POSTed, parsed, so a test can read what left the machine. */
let posted: FlowPayload[];

/** The live recording's state — the thing an archived flow must never pick up. */
const LIVE_STATE: FlowState = {
  read: true,
  stores: [{ id: 'live-cart', kind: 'context', label: 'LiveCartContext' }],
};

function installChrome(): void {
  store = {
    // What `readCurrentState` and `readCurrentRenders` would find for the
    // recording in progress. Present in every test: the question is only ever
    // whether a send reaches for it.
    stateStores: LIVE_STATE.stores,
    flowRenders: { capped: true },
    recordingSettings: {},
  };

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
}

function step(): Step {
  return {
    type: 'click',
    url: 'https://shop.test/cart',
    timestamp: RECORDED_AT,
    stepNumber: 1,
    action: 'Clicked Buy',
    screenshot: null,
    element: { selector: '#buy' },
  } as unknown as Step;
}

beforeEach(() => {
  installChrome();
  posted = [];
  vi.spyOn(Date, 'now').mockReturnValue(NOW);

  (globalThis as { fetch?: unknown }).fetch = (_url: string, init: { body: string }) => {
    posted.push(JSON.parse(init.body) as FlowPayload);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'stored' }),
    });
  };

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: () => Promise.resolve() } },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sending an archived flow that has no records of its own', () => {
  /**
   * A flow archived before state capture existed. Its `savedFlowState_` key has
   * never existed, `readFlow` answers `null` for it, and that `null` is the
   * flow's own answer — not an absence for `sendFlow` to fill in from whatever
   * is being recorded right now.
   */
  it('sends no state rather than the live recording’s', async () => {
    const sent = await sendFlow(
      'Last week’s checkout',
      [step()],
      'flow-1',
      SEND_EVERYTHING,
      null,
      RECORDED_AT,
      {},
      null,
      null,
      {},
    );
    expect(sent.ok).toBe(true);

    expect(posted).toHaveLength(1);
    expect(posted[0].state).toBeUndefined();
    expect(JSON.stringify(posted[0])).not.toContain('LiveCartContext');
  });

  it('sends no render summary rather than the live recording’s', async () => {
    await sendFlow(
      'Last week’s checkout',
      [step()],
      'flow-1',
      SEND_EVERYTHING,
      null,
      RECORDED_AT,
      {},
      null,
      null,
      {},
    );

    expect(posted[0].renders).toBeUndefined();
  });
});

describe('sending the recording in progress', () => {
  /**
   * The other half of the same distinction, and the reason this cannot simply
   * be "archived flows send nothing": the live recording passes nothing at all,
   * and its state is read back here because there is nowhere else it could come
   * from.
   */
  it('still reads the state and the renders back from storage', async () => {
    const sent = await sendFlow('Current recording', [step()]);
    expect(sent.ok).toBe(true);

    expect(posted[0].state).toEqual(LIVE_STATE);
    expect(posted[0].renders).toEqual({ read: true, capped: true });
  });
});
