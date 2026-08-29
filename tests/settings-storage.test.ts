/**
 * Sparse storage stays sparse.
 *
 * The whole mechanism rests on `chrome.storage.sync` holding *only* what
 * somebody changed. Store the resolved object instead and today's defaults are
 * frozen into every installation forever: a better default in a later version
 * would silently never reach anyone who had opened the Settings screen once.
 *
 * That failure ships without a symptom, which is why it gets a test that reads
 * the storage area directly rather than reading the settings back through
 * `load()` — going back through `load()` would return the right answer either
 * way, and prove nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installChromeSync, type SyncFake } from './helpers/chrome-sync.js';
import { DEFAULTS, FIELDS } from '../src/features/settings/fields.js';
import { load, loadOverrides, passthrough, save, subscribe } from '../src/features/settings/index.js';

let chromeSync: SyncFake;

beforeEach(() => {
  chromeSync = installChromeSync();
});

afterEach(() => {
  chromeSync.restore();
});

describe('sparse storage stays sparse', () => {
  it('writes nothing at all for a fresh profile', async () => {
    expect(await load()).toEqual(DEFAULTS);
    expect(chromeSync.area()).toEqual({});
  });

  it('materialises one key when one setting changes, not sixty', async () => {
    const written = await save({ 'recording.maxSteps': 250 });

    expect(written.ok).toBe(true);
    expect(chromeSync.area()).toEqual({ 'recording.maxSteps': 250 });
  });

  it('removes the key again when the setting goes back to its default', async () => {
    await save({ 'recording.maxSteps': 250 });
    await save({ 'recording.maxSteps': DEFAULTS['recording.maxSteps'] });

    // Not `{ 'recording.maxSteps': 500 }`. A stored default is a frozen default:
    // it would survive a later version changing the shipped value.
    expect(chromeSync.area()).toEqual({});
  });

  it('leaves the other settings alone when one is written', async () => {
    await save({ 'recording.maxSteps': 250 });
    await save({ mcpAutoSend: true });

    expect(chromeSync.area()).toEqual({ 'recording.maxSteps': 250, mcpAutoSend: true });
  });

  it('never stores more keys than settings that were touched', async () => {
    for (const field of FIELDS.slice(0, 5)) {
      const value =
        field.type === 'number'
          ? field.min
          : field.type === 'boolean'
            ? !field.default
            : field.type === 'levels' || field.type === 'enum'
              ? field.options.at(-1)
              : undefined;
      if (value === undefined) continue;
      await save({ [field.key]: value });
    }

    expect(Object.keys(chromeSync.area()).length).toBeLessThanOrEqual(5);
  });
});

describe('what storage holds is clamped on the way in as well as out', () => {
  it('stores the clamped value, not the value the caller passed', async () => {
    await save({ 'screenshots.quality': 4000 });

    expect(chromeSync.area()).toEqual({ 'screenshots.quality': 100 });
  });

  it('refuses a key that is not a setting rather than writing it', async () => {
    const written = await save({ 'video.frameRate': 60 } as never);

    expect(written.ok).toBe(false);
    expect(chromeSync.area()).toEqual({});
  });
});

describe('a value from a newer version', () => {
  beforeEach(() => {
    // What a synced profile from a newer FlowSnap actually looks like.
    chromeSync.seed({ 'recording.maxSteps': 250, 'video.frameRate': 60 });
  });

  it('does not stop this version reading its own settings', async () => {
    expect((await load())['recording.maxSteps']).toBe(250);
  });

  it('survives a save made by this version', async () => {
    await save({ mcpAutoSend: true });

    expect(chromeSync.area()['video.frameRate']).toBe(60);
  });

  it('is still there for an export to find', async () => {
    expect(passthrough(await loadOverrides())).toEqual({ 'video.frameRate': 60 });
  });
});

describe('storage that cannot be read', () => {
  it('resolves to the defaults rather than to nothing', async () => {
    chromeSync.seed({ 'recording.maxSteps': 250 });
    chromeSync.failReads();

    // A storage hiccup must not quietly switch a feature off — every boolean
    // here comes back as whatever the extension shipped with.
    expect(await load()).toEqual(DEFAULTS);
  });
});

describe('subscribe', () => {
  it('reports the whole resolved object when any setting changes', async () => {
    const seen: number[] = [];
    const stop = subscribe((settings) => seen.push(settings['recording.maxSteps']));

    await save({ 'recording.maxSteps': 250 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual([250]);
    stop();
  });

  it('stops when unsubscribed', async () => {
    let calls = 0;
    const stop = subscribe(() => calls++);
    stop();

    await save({ 'recording.maxSteps': 250 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toBe(0);
  });

  it('ignores a change to a key that is not a setting', async () => {
    let calls = 0;
    const stop = subscribe(() => calls++);

    await new Promise<void>((done) => {
      chrome.storage.sync.set({ 'video.frameRate': 60 }, () => done());
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toBe(0);
    stop();
  });
});

describe('every key exists exactly once', () => {
  it('has no duplicate key in the field table', () => {
    const keys = FIELDS.map((field) => field.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has a DEFAULTS entry for every field and no others', () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual(FIELDS.map((field) => field.key).sort());
  });

  it('gives every field a title, a description and at least one consumer', () => {
    for (const field of FIELDS) {
      expect(field.title.length, field.key).toBeGreaterThan(0);
      expect(field.description.length, field.key).toBeGreaterThan(0);
      expect(field.consumers.length, field.key).toBeGreaterThan(0);
    }
  });

  it('gives every numeric field a range that contains its default', () => {
    for (const field of FIELDS) {
      if (field.type !== 'number') continue;
      expect(field.min, field.key).toBeLessThanOrEqual(field.default);
      expect(field.default, field.key).toBeLessThanOrEqual(field.max);
    }
  });

  it('gives every enum a default that is one of its options', () => {
    for (const field of FIELDS) {
      if (field.type === 'enum') expect(field.options, field.key).toContain(field.default);
      if (field.type === 'levels') {
        for (const value of field.default) expect(field.options, field.key).toContain(value);
      }
    }
  });
});
