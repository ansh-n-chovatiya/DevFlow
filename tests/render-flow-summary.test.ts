/**
 * The flow-level render summary, from storage to the payload that leaves.
 *
 * The steps carry which components re-rendered; this carries whether anything
 * *looked*. Without it every one of the four answers the reader is offered —
 * never sampled, switched off, the walk was cut, nothing re-rendered — collapses
 * into the first, and a recording that sampled hard and found nothing is
 * indistinguishable from one that never sampled at all.
 *
 * It is tested here rather than one layer down because this is the layer that
 * can lose it. `readCurrentRenders` reads two storage keys and the frozen
 * settings; `buildPayload` lists flow-level fields **by name**, which is the
 * exact copy that dropped `state` last session while every fixture kept it. A
 * test that handed `buildPayload` a `FlowRenders` directly would pass against
 * the bug, so this one starts where the data actually starts: in storage.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readCurrentRenders } from '../src/features/flows/store.js';
import { buildPayload } from '../src/features/mcp/send.js';
import type { Step } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;

let store: Record<string, unknown>;

function installChrome(initial: Record<string, unknown>): void {
  store = structuredClone(initial);
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
    remove(_keys: string | string[], done: () => void) {
      done();
    },
  };
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { lastError: undefined },
    storage: { local },
  };
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

const step = (): Step => ({
  type: 'click',
  url: 'https://app.example.com',
  timestamp: NOW,
  action: 'Clicked "Save"',
  stepNumber: 1,
  element: { tag: 'button', cssSelector: 'button.save', xpath: '//button', boundingBox: null },
  consoleLogs: [],
  networkCalls: [],
});

const INCLUDE = { images: true, network: true, logs: true, react: true };

describe('what the recording says it saw of renders', () => {
  it('says sampling ran when the frozen settings had it on', async () => {
    installChrome({ recordingSettings: {}, flowRenders: { read: true } });
    expect(await readCurrentRenders()).toEqual({ read: true });
  });

  /**
   * Read from the settings *frozen for this recording*, not from live settings.
   * A flow recorded with sampling off still says so after the user turns it
   * back on, which is the whole point of freezing a stamp.
   */
  it('says sampling was off, in words a reader can act on', async () => {
    installChrome({ recordingSettings: { 'recording.renders': false } });
    const renders = await readCurrentRenders();
    expect(renders?.read).toBe(false);
    expect(renders?.note).toContain('was off for this recording');
  });

  it('carries the cap forward, so an empty list is not read as a healthy one', async () => {
    installChrome({
      recordingSettings: {},
      flowRenders: { read: true, capped: true, note: 'the walk stopped short' },
    });
    expect(await readCurrentRenders()).toEqual({
      read: true,
      capped: true,
      note: 'the walk stopped short',
    });
  });

  /**
   * Sampling ran, nothing was ever cut, and nothing re-rendered. The plainest
   * answer, and the one that must not carry a `capped` or a note it did not
   * earn — a caveat printed on every recording is a caveat nobody reads.
   */
  it('claims neither a cap nor a note it did not earn', async () => {
    installChrome({ recordingSettings: {} });
    expect(await readCurrentRenders()).toEqual({ read: true });
  });
});

describe('the payload that leaves', () => {
  it('carries the summary, which the by-name copy is where it would be lost', async () => {
    installChrome({ recordingSettings: {}, flowRenders: { read: true, capped: true } });
    const renders = await readCurrentRenders();

    const payload = buildPayload(
      'flow-1',
      'Flow',
      [step()],
      NOW,
      null,
      INCLUDE,
      undefined,
      null,
      renders,
    );
    expect(payload.renders).toEqual({ read: true, capped: true });
  });

  /**
   * "Sampling was off" is an answer and has to travel. Absent, the server reads
   * the flow as one recorded before render sampling existed — which is a claim
   * about the build, not about the choice this user made.
   */
  it('carries a read:false summary rather than dropping it as empty', async () => {
    installChrome({ recordingSettings: { 'recording.renders': false } });
    const renders = await readCurrentRenders();

    const payload = buildPayload(
      'flow-1',
      'Flow',
      [step()],
      NOW,
      null,
      INCLUDE,
      undefined,
      null,
      renders,
    );
    expect(payload.renders?.read).toBe(false);
    expect(payload.renders?.note).toContain('was off for this recording');
  });

  /** A flow from before any of this existed says nothing either way. */
  it('says nothing at all when there is no summary to carry', () => {
    const payload = buildPayload('flow-1', 'Flow', [step()], NOW, null, INCLUDE);
    expect('renders' in payload).toBe(false);
  });
});
