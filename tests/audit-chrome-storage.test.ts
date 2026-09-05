/**
 * The settings mechanism reaches storage only through `src/chrome/`.
 *
 * That layer exists to do one thing every raw call forgets: read
 * `chrome.runtime.lastError` inside the callback, where it is readable at all,
 * and turn it into a `FlowError` the caller has to decide about. A `remove` made
 * directly against `chrome.storage.sync` looked identical and was not — and
 * `remove` is not an incidental call here, it is *how settings stay sparse*, so
 * the one storage write with no wrapper was the write the whole design rests on.
 *
 * Two claims, and they need different kinds of test. That the calls go through
 * the layer is structural — a behavioural test passes just as happily against a
 * raw call, since both work when Chrome is in a good mood. That the wrappers
 * report failure is behavioural, and is checked against a Chrome that refuses.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installChromeSync, type SyncFake } from './helpers/chrome-sync.js';
import { getManaged, onStorageChanged, removeSync } from '../src/chrome/storage.js';
import { DEFAULTS } from '../src/features/settings/fields.js';
import { load, save, subscribe } from '../src/features/settings/index.js';

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const settingsSource = readFileSync(resolvePath(root, 'src/features/settings/index.ts'), 'utf8');

let chromeSync: SyncFake;

beforeEach(() => {
  chromeSync = installChromeSync();
});

afterEach(() => {
  chromeSync.restore();
});

/** The fake's `chrome`, typed loosely enough to break on purpose. */
function fakeChrome(): {
  runtime: { lastError?: { message: string } };
  storage: Record<string, Record<string, unknown>>;
} {
  return (globalThis as unknown as { chrome: ReturnType<typeof fakeChrome> }).chrome;
}

describe('settings makes no chrome call of its own', () => {
  it('names no `chrome.` anywhere outside a comment', () => {
    const offenders = settingsSource
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .filter((line) => /(^|[^.\w])chrome\./.test(line));

    // `chrome.storage.StorageChange` in a type position is the one shape that
    // is not a call, and `subscribe` needs it to describe its own listener.
    expect(offenders.filter((line) => !line.includes('chrome.storage.StorageChange'))).toEqual([]);
  });

  it('imports the wrappers it used to inline', () => {
    for (const wrapper of ['getManaged', 'onStorageChanged', 'removeSync']) {
      expect(settingsSource).toContain(wrapper);
    }
  });
});

describe('removeSync reports what Chrome refused', () => {
  /** Chrome's write-rate limit, which is the realistic way `remove` fails. */
  function refuseRemoves(message = 'MAX_WRITE_OPERATIONS_PER_HOUR quota exceeded'): void {
    fakeChrome().storage.sync.remove = (_keys: unknown, callback: () => void): void => {
      fakeChrome().runtime.lastError = { message };
      callback();
      fakeChrome().runtime.lastError = undefined;
    };
  }

  it('turns a lastError into a STORAGE_WRITE FlowError', async () => {
    refuseRemoves();

    const result = await removeSync(['recording.maxSteps']);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_WRITE');
    expect(result.error.detail).toContain('MAX_WRITE_OPERATIONS_PER_HOUR');
  });

  it('still hands `save` the failure its callers are written against', async () => {
    await save({ 'recording.maxSteps': 250 });
    refuseRemoves();

    // Back to the shipped default, which is a removal rather than a write. The
    // caller has to see this fail, or the Settings screen says "Saved" over a
    // value the area still holds.
    const result = await save({ 'recording.maxSteps': DEFAULTS['recording.maxSteps'] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_WRITE');
  });

  it('removes the key when Chrome is willing', async () => {
    await save({ 'recording.maxSteps': 250 });
    await save({ 'recording.maxSteps': DEFAULTS['recording.maxSteps'] });

    expect(chromeSync.area()).toEqual({});
  });
});

describe('the managed area is absent, not broken', () => {
  it('answers a failed Result rather than throwing when there is no policy', async () => {
    // The fake defines no `managed` at all, which is what Chrome does outside
    // an enterprise deployment.
    const result = await getManaged();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_READ');
  });

  it('leaves `load` on the defaults when the area throws from `get`', async () => {
    fakeChrome().storage.managed = {
      get: () => {
        throw new Error('managed storage is not available');
      },
    };

    // No policy is the ordinary case, so this is a settings object, not a throw.
    await expect(load()).resolves.toEqual(DEFAULTS);
  });

  it('reports a rejection as no policy rather than letting it escape', async () => {
    fakeChrome().storage.managed = {
      get: () => Promise.reject(new Error('policy service unavailable')),
    };

    await expect(load()).resolves.toEqual(DEFAULTS);
  });

  it('applies a policy the area does hand over', async () => {
    fakeChrome().storage.managed = {
      get: () => Promise.resolve({ 'recording.maxSteps': 42 }),
    };

    expect((await load())['recording.maxSteps']).toBe(42);
  });
});

describe('onStorageChanged pairs its own removal', () => {
  it('stops calling back once the unsubscribe runs', async () => {
    const seen: string[] = [];
    const stop = onStorageChanged((changes) => seen.push(...Object.keys(changes)));

    await save({ 'recording.maxSteps': 250 });
    expect(seen).toEqual(['recording.maxSteps']);

    stop();
    await save({ mcpAutoSend: true });
    expect(seen).toEqual(['recording.maxSteps']);
  });

  it('is what `subscribe` returns, so a surface that unmounts leaves nothing', async () => {
    let calls = 0;
    const stop = subscribe(() => {
      calls += 1;
    });

    await save({ 'recording.maxSteps': 250 });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBeGreaterThan(0);

    const before = calls;
    stop();
    await save({ mcpAutoSend: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(before);
  });
});
