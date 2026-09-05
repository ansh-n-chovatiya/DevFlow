// @vitest-environment jsdom
/**
 * Two things the content script has to stop doing, and could not be told to.
 *
 * Both are about a switch being flipped *after* something was already in
 * flight, which is the shape of every bug in this file: the recorder is a set
 * of timers and page listeners, and the surfaces that turn them on and off are
 * in other processes.
 *
 *  1. **A panel that closes leaves its highlight drawn on the page.** The box
 *     is armed by hovering a row in the panel's tree and cleared by leaving the
 *     row — and a panel that closes never leaves the row. Page context cannot
 *     observe DevTools closing, so `CANCEL_PICK`, which the worker sends from
 *     `closePanel`, is the only signal that ever arrives.
 *  2. **A debounced keystroke commits after the recording is paused.** The
 *     value is read from the live element when the timer fires, not when the
 *     key was pressed, so it is whatever the field holds at that moment.
 *
 * The script is imported for its side effects, so the `chrome` fake has to be
 * installed before the import — which is also why this file drives the recorder
 * through real runtime messages rather than by reaching into it.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { AGENT_MESSAGE_SOURCE, CONTROL_MESSAGE_SOURCE } from '../src/shared/constants.js';

type MessageListener = (
  message: { type: string } & Record<string, unknown>,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

interface ControlPost {
  __devflow_control__?: string;
  query?: { kind: string; group?: string; index?: number | null };
}

const localStore: Record<string, unknown> = {
  // Clamped to the field's own minimum, which is what keeps this test at a
  // tenth of a second rather than at the shipped 800 ms.
  recordingSettings: { 'recording.inputDebounceMs': 100 },
};

const listeners: MessageListener[] = [];
const sent: ({ type: string } & Record<string, unknown>)[] = [];
const posted: ControlPost[] = [];

/** Hands a message to the content script's own `onMessage` listener. */
function deliver(message: { type: string } & Record<string, unknown>): unknown {
  let answer: unknown;
  for (const listener of listeners) listener(message, {}, (response) => (answer = response));
  return answer;
}

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  const area = (store: Record<string, unknown>): Record<string, unknown> => ({
    get(keys: unknown, callback: (items: Record<string, unknown>) => void) {
      if (keys === null || keys === undefined) {
        callback({ ...store });
        return;
      }
      const wanted = Array.isArray(keys) ? (keys as string[]) : [keys as string];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (key in store) out[key] = store[key];
      callback(out);
    },
    set(items: Record<string, unknown>, callback: () => void) {
      Object.assign(store, items);
      callback();
    },
    remove(keys: string | string[], callback: () => void) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      callback();
    },
  });

  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getManifest: () => ({ version: '0.0.0-test' }),
      onMessage: { addListener: (fn: MessageListener) => listeners.push(fn) },
      sendMessage: (
        message: { type: string } & Record<string, unknown>,
        callback?: (response?: unknown) => void,
      ) => {
        sent.push(message);
        callback?.({ ok: true });
      },
    },
    storage: {
      local: area(localStore),
      sync: area({}),
      managed: { get: () => Promise.reject(new Error('no policy here')) },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
  };

  // Everything the agent would answer is irrelevant here; what is asserted is
  // what the content script *asks*, which is a `postMessage` on this window.
  window.addEventListener('message', (event: MessageEvent<ControlPost>) => {
    if (event.data?.__devflow_control__ === CONTROL_MESSAGE_SOURCE) posted.push(event.data);
  });

  await import('../src/content/index.js');
  await settle();
});

describe('a locate surface going away', () => {
  it('asks the page to drop any highlight it left drawn there', async () => {
    posted.length = 0;
    deliver({ type: 'CANCEL_PICK' });
    await settle(5);

    const clear = posted.find((message) => message.query?.kind === 'highlight');
    expect(clear, 'CANCEL_PICK sent no highlight query').toBeDefined();
    // `index: null` is the same clear the panel sends on mouseleave — the one
    // shape `answerQuery` routes to `hideHighlight`.
    expect(clear?.query?.index).toBeNull();
  });

  it('does the same when a new pick supersedes the last one', async () => {
    posted.length = 0;
    deliver({ type: 'START_PICK' });
    await settle(5);

    expect(posted.find((message) => message.query?.kind === 'highlight')?.query?.index).toBeNull();
    deliver({ type: 'CANCEL_PICK' });
  });
});

describe('a keystroke still inside its debounce', () => {
  /** Types into a fresh field and returns it, without waiting for the commit. */
  function type(value: string): HTMLInputElement {
    document.body.innerHTML = '<input id="q">';
    const field = document.getElementById('q') as HTMLInputElement;
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return field;
  }

  const steps = (): Record<string, unknown>[] =>
    sent
      .filter((message) => message.type === 'CAPTURE_AND_SAVE_STEP')
      .map((message) => message.step as Record<string, unknown>);

  it('becomes a step while the recording is live', async () => {
    deliver({ type: 'START_RECORDING' });
    await settle();

    sent.length = 0;
    type('hello');
    await settle(400);

    expect(steps().map((step) => step.value)).toContain('hello');
    deliver({ type: 'STOP_RECORDING' });
    await settle();
  });

  it('is dropped when the recording is paused before it commits', async () => {
    deliver({ type: 'START_RECORDING' });
    await settle();

    sent.length = 0;
    const field = type('a');
    deliver({ type: 'PAUSE_RECORDING' });
    await settle();

    // The pause is what the user reached for before typing this. The commit
    // reads `el.value` when the timer fires, so without the guard the whole
    // string — not the 'a' that armed the debounce — was written into the flow.
    field.value = 'a-private-thing';
    await settle(400);

    expect(steps()).toEqual([]);
    deliver({ type: 'STOP_RECORDING' });
    await settle();
  });

  it('is dropped when the recording has stopped before it commits', async () => {
    deliver({ type: 'START_RECORDING' });
    await settle();

    sent.length = 0;
    type('b');
    deliver({ type: 'STOP_RECORDING' });
    await settle(400);

    expect(steps()).toEqual([]);
  });
});

/**
 * The agent's own envelope is checked here only to prove the two channels have
 * not been confused: a control message is what the content script *sends*, and
 * anything wearing the agent's marker is what it *receives*.
 */
it('sends control messages, never agent messages', () => {
  expect(posted.every((message) => message.__devflow_control__ === CONTROL_MESSAGE_SOURCE)).toBe(
    true,
  );
  expect(CONTROL_MESSAGE_SOURCE).not.toBe(AGENT_MESSAGE_SOURCE);
});
