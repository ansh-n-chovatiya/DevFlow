/**
 * Two ways a recording could lie about what happened, from the audit's §3.3.
 *
 * A step is not written when the user clicks it — it is written after a settle
 * delay, a serialising queue and a screenshot, several seconds later. Both
 * findings live in that window:
 *
 * 1. Chrome kills an idle MV3 worker whenever it likes. Everything the capture
 *    was holding lived in memory, so the step vanished and the *next* step was
 *    numbered `recordedSteps.length + 1` from storage — the flow renumbered
 *    contiguously and nothing said a step was lost. A flow that quietly drops
 *    the interaction that broke the app is worse than no flow: it is believed.
 * 2. `captureVisibleTab` photographs a *window*, and the tab was checked once,
 *    when the message arrived. Switch tabs during the wait and step N is filed
 *    with a photograph of a page it never touched, at full confidence.
 *
 * Both are behavioural claims about the worker, so they are tested against the
 * worker rather than against its source text: a fake `chrome` is installed, the
 * module is imported (which registers its listeners, as it does in Chrome), and
 * the real `CAPTURE_AND_SAVE_STEP` listener is driven. A worker restart is
 * `vi.resetModules()` and a second import against the *same* `chrome` — a fresh
 * module instance over storage that survived, which is exactly what Chrome does
 * and exactly what makes `chrome.storage.session` the right place for the
 * marker.
 *
 * Fake timers throughout, for one reason beyond speed: the restart test has to
 * leave the first capture parked *inside* its settle delay forever. With real
 * timers that capture would wake up mid-suite and write into whatever `chrome`
 * was global by then.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftStep, Step } from '../src/shared/types.js';

type Listener = (...args: unknown[]) => unknown;

interface WorkerChrome {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  /** The tab the fake Chrome reports as visible; the test moves it mid-flight. */
  activeTabId: number;
  /** Every `captureVisibleTab` that actually reached the API. */
  captures: number;
  listeners: Record<string, Listener[]>;
}

let world: WorkerChrome;

/** A storage area with Chrome's callback signatures, over a plain object. */
function area(store: Record<string, unknown>): Record<string, unknown> {
  return {
    get(keys: unknown, callback: (items: Record<string, unknown>) => void): void {
      const names =
        keys == null
          ? Object.keys(store)
          : Array.isArray(keys)
            ? (keys as string[])
            : typeof keys === 'string'
              ? [keys]
              : Object.keys(keys);
      const out: Record<string, unknown> = {};
      for (const key of names) if (key in store) out[key] = store[key];
      callback(out);
    },
    set(items: Record<string, unknown>, callback?: () => void): void {
      Object.assign(store, items);
      callback?.();
    },
    remove(keys: unknown, callback?: () => void): void {
      for (const key of Array.isArray(keys) ? (keys as string[]) : [String(keys)]) delete store[key];
      callback?.();
    },
  };
}

function installChrome(): WorkerChrome {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const listeners: Record<string, Listener[]> = {};
  const on = (name: string) => ({
    addListener: (fn: Listener): void => {
      (listeners[name] ??= []).push(fn);
    },
    removeListener: (): void => {},
  });

  const handle: WorkerChrome = { local, session, activeTabId: 1, captures: 0, listeners };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      onMessage: on('message'),
      onConnect: on('connect'),
      onStartup: on('startup'),
      onInstalled: on('installed'),
      getURL: (path: string) => `chrome-extension://devflow/${path}`,
    },
    commands: { onCommand: on('command') },
    storage: {
      local: area(local),
      session: area(session),
      sync: area({}),
      onChanged: on('changed'),
    },
    tabs: {
      onRemoved: on('removed'),
      /** Promise form for the capture's re-check, callback form for the trailing flush. */
      query(query: { active?: boolean }, callback?: (tabs: unknown[]) => void) {
        const tabs = query.active === true ? [{ id: handle.activeTabId, windowId: 10 }] : [];
        if (callback) {
          callback(tabs);
          return undefined;
        }
        return Promise.resolve(tabs);
      },
      get: (_id: number, callback: () => void) => callback(),
      captureVisibleTab: () => {
        handle.captures += 1;
        return Promise.resolve('data:image/jpeg;base64,SHOT');
      },
    },
    action: {
      setBadgeText: (_a: unknown, cb?: () => void) => cb?.(),
      setBadgeBackgroundColor: (_a: unknown, cb?: () => void) => cb?.(),
      setTitle: (_a: unknown, cb?: () => void) => cb?.(),
    },
  };

  return handle;
}

/** Let every promise chain that is not waiting on a timer run to a standstill. */
async function settle(turns = 200): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

/** Start (or restart) the worker over the storage that is already there. */
async function startWorker(): Promise<void> {
  vi.resetModules();
  await import('../src/background/index.js');
  await settle();
}

function steps(): Step[] {
  return (world.local.recordedSteps ?? []) as Step[];
}

function draft(timestamp: number, action: string): DraftStep {
  return {
    type: 'click',
    url: 'https://app.example.com/orders',
    timestamp,
    action,
    element: { tag: 'button', cssSelector: 'button', xpath: '//button', boundingBox: null },
  };
}

/**
 * Deliver a capture message the way the content script does, from tab 1.
 *
 * The *last* listener registered, which is the live worker's: a restart leaves
 * the killed instance's listener in the fake behind it, and Chrome would have
 * torn that one down with the worker it belonged to.
 */
function sendStep(step: DraftStep): void {
  const listener = world.listeners.message?.at(-1);
  if (!listener) throw new Error('the worker registered no message listener');

  listener(
    { type: 'CAPTURE_AND_SAVE_STEP', step, elementBox: null, dpr: 1 },
    { tab: { id: 1, windowId: 10, active: true } },
    () => {},
  );
}

/**
 * A live recording with one step already saved, frozen at the given settings.
 *
 * `screenshots.settleDelayMs` is what each test drives: a long one parks the
 * capture inside the window both findings live in.
 */
function seedRecording(settleDelayMs: number): void {
  world.local.recordingActive = true;
  world.local.recordingTabId = 1;
  world.local.recordedSteps = [
    { ...draft(1_000, 'Clicked "Orders"'), stepNumber: 1, screenshot: null },
  ];
  world.local.recordingSettings = {
    'screenshots.settleDelayMs': settleDelayMs,
    'screenshots.minIntervalMs': 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  world = installChrome();
});

afterEach(() => {
  // Discards the parked settle delay of any capture the restart tests abandoned.
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the capture-pending marker', () => {
  it('is in session storage before the settle delay has elapsed', async () => {
    seedRecording(5_000);
    await startWorker();

    sendStep(draft(2_000, 'Clicked "Refund"'));
    await settle();

    // Still inside the delay: nothing is written to the flow yet, which is the
    // whole window the worker used to be able to die in silently.
    expect(steps()).toHaveLength(1);
    expect(world.session.capturePending).toMatchObject({
      key: '2000:click',
      url: 'https://app.example.com/orders',
      at: 2_000,
    });
  });

  it('is gone once the step itself is written', async () => {
    seedRecording(0);
    await startWorker();

    sendStep(draft(2_000, 'Clicked "Refund"'));
    await vi.advanceTimersByTimeAsync(10);
    await settle();

    expect(steps()).toHaveLength(2);
    expect(steps()[1]).toMatchObject({ stepNumber: 2, action: 'Clicked "Refund"' });
    expect('capturePending' in world.session).toBe(false);
  });
});

describe('a worker killed between the marker and the step', () => {
  it('leaves a visible gap in the flow, not a contiguous renumbering', async () => {
    seedRecording(5_000);
    await startWorker();

    sendStep(draft(2_000, 'Clicked "Refund"'));
    await settle();
    expect(world.session.capturePending).toBeTruthy();
    expect(steps()).toHaveLength(1);

    // Chrome kills the worker here: the marker and `recordedSteps` survive in
    // storage, everything the capture was holding does not.
    await startWorker();
    await settle();

    const afterRestart = steps();
    expect(afterRestart).toHaveLength(2);
    expect(afterRestart[1]).toMatchObject({
      type: 'note',
      action: 'step-lost',
      stepNumber: 2,
      screenshot: null,
    });
    expect(afterRestart[1].value).toMatch(/lost/i);
    expect(afterRestart[1].screenshotOmitted).toBeTruthy();

    // And the recording carries on *after* the gap rather than closing over it:
    // the next real step is 3, so nothing claims steps 1 and 3 were consecutive.
    world.local.recordingSettings = {
      'screenshots.settleDelayMs': 0,
      'screenshots.minIntervalMs': 0,
    };
    sendStep(draft(3_000, 'Clicked "Confirm"'));
    await vi.advanceTimersByTimeAsync(10);
    await settle();

    expect(steps().map((step) => step.action)).toEqual([
      'Clicked "Orders"',
      'step-lost',
      'Clicked "Confirm"',
    ]);
    expect(steps()[2]).toMatchObject({ stepNumber: 3 });
    expect('capturePending' in world.session).toBe(false);
  });

  it('says nothing when the step it names did land after all', async () => {
    // The one interleaving that is not a loss: the worker died between the
    // terminal write and the marker's removal. Reporting a gap here would be
    // the same lie in the other direction.
    seedRecording(0);
    await startWorker();

    sendStep(draft(2_000, 'Clicked "Refund"'));
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(steps()).toHaveLength(2);

    world.session.capturePending = {
      key: '2000:click',
      url: 'https://app.example.com/orders',
      at: 2_000,
    };

    await startWorker();
    await settle();

    expect(steps()).toHaveLength(2);
    expect(steps().some((step) => step.type === 'note')).toBe(false);
    expect('capturePending' in world.session).toBe(false);
  });
});

describe('the tab a screenshot is actually of', () => {
  it('omits the screenshot when the visible tab changed after the message arrived', async () => {
    seedRecording(200);
    await startWorker();

    // Tab 1 is the sender and is on screen: the message-time check passes, as
    // it did before this fix, and the screenshot used to be attached.
    sendStep(draft(2_000, 'Clicked "Refund"'));
    await settle();

    // The user switches tabs while the capture is still waiting out the settle
    // delay — the window the old code could not see into.
    world.activeTabId = 2;
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    const saved = steps()[1];
    expect(saved).toBeTruthy();
    expect(saved.screenshotOmitted).toMatch(/another tab/i);
    // No image stored under the step's own key either — the step is saved with
    // everything else it recorded, and nothing that would read as evidence.
    expect(Object.keys(world.local).some((key) => key.startsWith('shot_'))).toBe(false);
    // Refused before the shutter, not thrown away after it.
    expect(world.captures).toBe(0);
  });

  it('keeps the screenshot when the same tab is still on screen at capture time', async () => {
    seedRecording(200);
    await startWorker();

    sendStep(draft(2_000, 'Clicked "Refund"'));
    await settle();
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    const saved = steps()[1];
    expect(saved).toBeTruthy();
    expect(saved.screenshotOmitted).toBeUndefined();
    expect(world.captures).toBe(1);
  });
});
