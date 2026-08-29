// @vitest-environment jsdom
/**
 * The push channel is the only path a setting can take into the MAIN world.
 *
 * The injected agent has no `chrome.*` at all, so nothing it reads can come from
 * storage — the content script has to hand it over, and it arrives as a
 * `postMessage` on the same control channel that already says whether to watch
 * for interactions. That is one message type, three files apart, in two
 * JavaScript realms, and there is no type error and no runtime failure if it
 * stops arriving: the agent simply carries on with the compiled-in defaults, and
 * the user's setting silently does nothing. It is "the one most likely to
 * rot", which is exactly right.
 *
 * The agent is loaded for its side effects — it patches `console` and `fetch` at
 * import time — so the stubs have to be in place before the import.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  BODY_CAP,
  CONSOLE_LEVELS,
  CONTROL_MESSAGE_SOURCE,
  LOG_ARG_CAP,
  MAX_COMPONENT_CHAIN,
  MAX_FIBER_WALK,
  REACT_PREWARM_TTL_MS,
} from '../src/shared/constants.js';
import { DEFAULTS } from '../src/features/settings/fields.js';
import { toAgentConfig } from '../src/features/settings/agent.js';
import type { AgentConfig } from '../src/shared/messages.js';

interface Emitted {
  __flowsnap_source__?: string;
  kind?: string;
  level?: string;
  args?: string[];
}

const seen: Emitted[] = [];

/**
 * Deliver a control message the way the content script does, and let the
 * `message` listener run.
 *
 * `window.postMessage` under jsdom does not set `event.source`, and the agent
 * checks it — same-window, same-origin is what stops any page script forging
 * this. So the event is dispatched with `source` set, which is what a real
 * same-window post produces.
 */
async function pushControl(recording: boolean, config?: Partial<AgentConfig>): Promise<void> {
  const event = new MessageEvent('message', {
    data: { __flowsnap_control__: CONTROL_MESSAGE_SOURCE, recording, config },
    origin: window.location.origin,
    source: window,
  });
  window.dispatchEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function drain(): Promise<Emitted[]> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return seen.splice(0, seen.length);
}

beforeAll(async () => {
  window.addEventListener('message', (event: MessageEvent<Emitted>) => {
    if (event.data?.__flowsnap_source__) seen.push(event.data);
  });
  await import('../src/injected/agent.js');
  await drain();
});

describe('what the content script sends', () => {
  it('is the agent-relevant subset and nothing else', () => {
    expect(toAgentConfig(DEFAULTS)).toEqual({
      captureBodies: true,
      bodyCap: BODY_CAP,
      consoleLevels: CONSOLE_LEVELS,
      logArgCap: LOG_ARG_CAP,
      stackFrames: 12,
      captureUncaught: true,
      // Phase 6's three: the fiber walk runs in the MAIN world, so its limits
      // have to cross the same boundary the body cap does.
      maxComponentChain: MAX_COMPONENT_CHAIN,
      maxFiberWalk: MAX_FIBER_WALK,
      prewarmTtlMs: REACT_PREWARM_TTL_MS,
    });
  });

  it('carries every field the agent declares, so a new one cannot be forgotten', () => {
    const sent = Object.keys(toAgentConfig(DEFAULTS)).sort();
    // `AgentConfig` is the contract; this is the runtime half of it. A field
    // added to the interface but not to `toAgentConfig` compiles fine and
    // arrives as `undefined`, which `applyConfig` then ignores forever.
    expect(sent).toEqual([
      'bodyCap',
      'captureBodies',
      'captureUncaught',
      'consoleLevels',
      'logArgCap',
      'maxComponentChain',
      'maxFiberWalk',
      'prewarmTtlMs',
      'stackFrames',
    ]);
  });

  it('reflects a changed setting', () => {
    const changed = toAgentConfig({ ...DEFAULTS, 'console.levels': ['error'], 'network.bodyCap': 10 });

    expect(changed.consoleLevels).toEqual(['error']);
    expect(changed.bodyCap).toBe(10);
  });
});

// Calling `console.info` is the subject of these tests, not a stray debug line:
// the whole point is which levels the agent forwards and which it drops.
/* eslint-disable no-console */

describe('the agent receives what it is sent', () => {
  it('starts on the compiled-in defaults, before any message arrives', async () => {
    // The window between injection at `document_start` and the first control
    // message is real, and a page can log in it.
    console.info('before any control message');

    expect((await drain()).map((entry) => entry.level)).toContain('info');
  });

  it('stops emitting a level that has been switched off', async () => {
    await pushControl(true, { ...toAgentConfig(DEFAULTS), consoleLevels: ['error'] });

    console.info('dropped');
    console.warn('also dropped');
    console.error('kept');

    const levels = (await drain()).map((entry) => entry.level);
    expect(levels).toEqual(['error']);
  });

  it('emits it again when it is switched back on, mid-page', async () => {
    await pushControl(true, { ...toAgentConfig(DEFAULTS), consoleLevels: ['error'] });
    await pushControl(true, toAgentConfig(DEFAULTS));

    console.info('kept again');

    expect((await drain()).map((entry) => entry.level)).toContain('info');
  });

  it('applies a config even when the recording flag has not changed', async () => {
    // The agent early-returns when `recording` matches what it already thinks.
    // A settings change during a recording arrives with the same flag, so the
    // config has to be applied before that return or it never lands.
    await pushControl(true, toAgentConfig(DEFAULTS));
    await pushControl(true, { ...toAgentConfig(DEFAULTS), logArgCap: 8 });

    console.error('0123456789abcdef');

    const [entry] = await drain();
    expect(entry.args?.[0]).toMatch(/^01234567… \[16 chars total\]$/);
  });

  it('honours a per-argument cap sent after import', async () => {
    await pushControl(true, { ...toAgentConfig(DEFAULTS), logArgCap: 4 });

    console.error('abcdefgh');

    expect((await drain())[0]?.args?.[0]).toBe('abcd… [8 chars total]');
    await pushControl(true, toAgentConfig(DEFAULTS));
  });

  it('ignores a forged message whose config is the wrong shape', async () => {
    await pushControl(true, { logArgCap: 'tiny', consoleLevels: 'error' } as never);

    console.error('still capped at the previous value');

    // Nothing threw, and the level that was on is still on.
    expect((await drain()).map((entry) => entry.level)).toEqual(['error']);
  });

  it('drops a console level it has never heard of', async () => {
    await pushControl(true, { ...toAgentConfig(DEFAULTS), consoleLevels: ['error', 'trace'] });

    console.error('kept');

    expect((await drain()).map((entry) => entry.level)).toEqual(['error']);
    await pushControl(true, toAgentConfig(DEFAULTS));
  });

  it('stops recording uncaught errors when told to', async () => {
    await pushControl(true, { ...toAgentConfig(DEFAULTS), captureUncaught: false });

    window.dispatchEvent(
      new ErrorEvent('error', { message: 'boom', error: new Error('boom'), filename: 'a.js' }),
    );

    expect(await drain()).toEqual([]);
  });

  it('records them again when told to', async () => {
    await pushControl(true, toAgentConfig(DEFAULTS));

    window.dispatchEvent(
      new ErrorEvent('error', { message: 'boom', error: new Error('boom'), filename: 'a.js' }),
    );

    const entries = await drain();
    expect(entries[0]?.level).toBe('error');
    expect(entries[0]?.args?.[0]).toContain('[uncaught]');
  });
});

/* eslint-enable no-console */
