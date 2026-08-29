/**
 * `resolve()` is the only validator, so this is where it gets tested against
 * everything storage can actually contain.
 *
 * The form validates for a good message. `resolve` validates because
 * `chrome.storage.sync` outlives the code that wrote it: a value synced down
 * from a newer version, a profile someone hand-edited, a write that was cut off
 * halfway. Every case below is one of those, not a hypothetical.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULTS, FIELDS, type SettingKey } from '../src/features/settings/fields.js';
import { isModified, passthrough, resolve } from '../src/features/settings/index.js';

/** A value guaranteed to be outside the field's range, in the right direction. */
function beyond(field: (typeof FIELDS)[number], direction: 'over' | 'under'): number {
  if (field.type !== 'number') throw new Error('numbers only');
  return direction === 'over' ? field.max + 1000 : field.min - 1000;
}

describe('resolve is total', () => {
  it('answers with the defaults for nothing at all', () => {
    expect(resolve({})).toEqual(DEFAULTS);
  });

  it('answers with the defaults for null and undefined', () => {
    expect(resolve(null)).toEqual(DEFAULTS);
    expect(resolve(undefined)).toEqual(DEFAULTS);
  });

  it('answers with the defaults for a key set to null', () => {
    // A cleared key reads back as undefined; a hand-edited file can hold null.
    for (const field of FIELDS) {
      expect(resolve({ [field.key]: null })[field.key]).toEqual(
        DEFAULTS[field.key],
      );
    }
  });

  it('answers with the defaults for a value of entirely the wrong type', () => {
    for (const field of FIELDS) {
      const wrong = field.type === 'boolean' ? { nope: 1 } : Symbol('nope');
      expect(
        resolve({ [field.key]: wrong })[field.key],
        field.key,
      ).toEqual(DEFAULTS[field.key]);
    }
  });
});

describe('every setting clamps', () => {
  const numbers = FIELDS.filter((field) => field.type === 'number');

  it('has numeric settings to clamp at all', () => {
    expect(numbers.length).toBeGreaterThan(20);
  });

  it.each(numbers.map((field) => [field.key, field] as const))(
    '%s clamps to its range',
    (key, field) => {
      const settings = resolve({ [key]: beyond(field, 'over') });
      expect(settings[key as SettingKey]).toBe(field.max);

      const low = resolve({ [key]: beyond(field, 'under') });
      expect(low[key as SettingKey]).toBe(field.min);
    },
  );

  it.each(numbers.map((field) => [field.key, field] as const))(
    '%s rejects a value that is not a number',
    (key) => {
      expect(resolve({ [key]: 'soon' })[key as SettingKey]).toEqual(DEFAULTS[key as SettingKey]);
      expect(resolve({ [key]: NaN })[key as SettingKey]).toEqual(DEFAULTS[key as SettingKey]);
      expect(resolve({ [key]: Infinity })[key as SettingKey]).toEqual(DEFAULTS[key as SettingKey]);
      // `''` coerces to 0 in JavaScript, which is not what an empty field means.
      expect(resolve({ [key]: '' })[key as SettingKey]).toEqual(DEFAULTS[key as SettingKey]);
    },
  );

  it('reads a number written as a string, because a settings file holds text', () => {
    expect(resolve({ 'recording.maxSteps': '250' })['recording.maxSteps']).toBe(250);
  });

  it('rounds a fractional value for a field that counts things', () => {
    expect(resolve({ 'recording.maxSteps': 250.6 })['recording.maxSteps']).toBe(251);
  });

  it('keeps the fraction where the field is a fraction', () => {
    expect(resolve({ 'thumbnails.quality': 0.35 })['thumbnails.quality']).toBe(0.35);
  });
});

describe('the non-numeric types', () => {
  it('takes a boolean and nothing that merely looks like one', () => {
    expect(resolve({ mcpAutoSend: true }).mcpAutoSend).toBe(true);
    // The expensive one: every truthiness test in JavaScript reads `'false'` as
    // true, and this is a setting that sends recordings off the machine.
    expect(resolve({ mcpAutoSend: 'false' }).mcpAutoSend).toBe(false);
    expect(resolve({ mcpAutoSend: 1 }).mcpAutoSend).toBe(false);
  });

  it('falls back rather than guessing a nearest legal string', () => {
    expect(resolve({ theme: 'dark' }).theme).toBe('dark');
    expect(resolve({ theme: 'darkk' }).theme).toBe('system');
    expect(resolve({ editor: 'emacs-via-telepathy' }).editor).toBe('vscode');
  });

  it('rejects a colour that is not one', () => {
    expect(resolve({ 'annotation.stroke': '#00FF00' })['annotation.stroke']).toBe('#00FF00');
    expect(resolve({ 'annotation.stroke': 'red' })['annotation.stroke']).toBe('#FF3B30');
    expect(resolve({ 'annotation.stroke': 'javascript:x' })['annotation.stroke']).toBe('#FF3B30');
  });

  it('rejects an address that is not an http(s) URL', () => {
    expect(resolve({ mcpServerUrl: 'http://localhost:9000/flows' }).mcpServerUrl).toBe(
      'http://localhost:9000/flows',
    );
    expect(resolve({ mcpServerUrl: '' }).mcpServerUrl).toBe(DEFAULTS.mcpServerUrl);
    expect(resolve({ mcpServerUrl: 'javascript:alert(1)' }).mcpServerUrl).toBe(
      DEFAULTS.mcpServerUrl,
    );
  });

  it('truncates an over-long string rather than discarding it', () => {
    const long = 'a'.repeat(9000);
    expect(resolve({ projectRoot: long }).projectRoot).toHaveLength(4096);
  });

  it('keeps only the console levels it knows, in the table’s order', () => {
    expect(resolve({ 'console.levels': ['error', 'warn'] })['console.levels']).toEqual([
      'warn',
      'error',
    ]);
    // A level from a newer version is dropped rather than passed to `console[…]`.
    expect(resolve({ 'console.levels': ['error', 'trace'] })['console.levels']).toEqual(['error']);
    // Empty is a legal answer: capture no console at all.
    expect(resolve({ 'console.levels': [] })['console.levels']).toEqual([]);
    expect(resolve({ 'console.levels': 'error' })['console.levels']).toEqual(DEFAULTS['console.levels']);
  });
});

describe('keys from a hypothetical newer version', () => {
  const future = { 'recording.maxSteps': 250, 'video.frameRate': 60, 'a.b.c': { deep: true } };

  it('do not stop the settings this version knows from resolving', () => {
    expect(resolve(future)['recording.maxSteps']).toBe(250);
  });

  it('are not in the resolved object, because nothing here can clamp them', () => {
    expect(resolve(future)).not.toHaveProperty('video.frameRate');
  });

  it('are preserved verbatim, so an export round-trips them', () => {
    expect(passthrough(future)).toEqual({ 'video.frameRate': 60, 'a.b.c': { deep: true } });
  });

  it('are not confused with the settings this version does know', () => {
    expect(passthrough({ 'recording.maxSteps': 250 })).toEqual({});
  });
});

describe('resolve is pure', () => {
  it('does not mutate what it was given', () => {
    const overrides = { 'recording.maxSteps': 99_999, 'console.levels': ['error'] };
    const snapshot = JSON.parse(JSON.stringify(overrides));
    resolve(overrides);
    expect(overrides).toEqual(snapshot);
  });

  it('does not let a caller mutate the shipped defaults through the result', () => {
    const settings = resolve({});
    expect(() => {
      (settings['console.levels'] as string[]).push('trace');
    }).toThrow();
    expect(DEFAULTS['console.levels']).toEqual(['log', 'warn', 'error', 'info', 'debug']);
  });
});

describe('isModified marks the gutter', () => {
  it('is false for every shipped default', () => {
    for (const field of FIELDS) {
      expect(isModified(field.key, DEFAULTS[field.key]), field.key)
        .toBe(false);
    }
  });

  it('is true for a changed scalar and a changed list', () => {
    expect(isModified('recording.maxSteps', 250)).toBe(true);
    expect(isModified('console.levels', ['error'])).toBe(true);
    expect(isModified('console.levels', ['log', 'warn', 'error', 'info', 'debug'])).toBe(false);
  });
});
