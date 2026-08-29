import { describe, expect, it } from 'vitest';
import {
  defaultFilename,
  formatDelta,
  pad2,
  renumber,
  sanitizeFilename,
  startUrl,
} from '../src/core/flow/index.js';
import type { Step } from '../src/shared/types.js';

const step = (over: Partial<Step> = {}): Step =>
  ({
    type: 'navigate',
    url: 'https://example.com/',
    title: 'Example',
    timestamp: 0,
    action: 'Navigated',
    ...over,
  }) as Step;

describe('renumber', () => {
  it('closes the gap a deletion leaves behind', () => {
    const afterDelete = [step({ stepNumber: 1 }), step({ stepNumber: 3 })];
    expect(renumber(afterDelete).map((s) => s.stepNumber)).toEqual([1, 2]);
  });

  it('does not mutate the input', () => {
    const original = [step({ stepNumber: 7 })];
    renumber(original);
    expect(original[0].stepNumber).toBe(7);
  });
});

describe('sanitizeFilename', () => {
  it('strips characters that are illegal in a filename', () => {
    expect(sanitizeFilename('my/flow:name?')).toBe('myflowname');
  });

  it('trims leading and trailing dots', () => {
    expect(sanitizeFilename('..hidden..')).toBe('hidden');
  });

  it('falls back rather than returning an empty name', () => {
    expect(sanitizeFilename('///')).toBe('flowsnap-flow');
    expect(sanitizeFilename('   ')).toBe('flowsnap-flow');
  });
});

describe('defaultFilename', () => {
  it('zero-pads the date', () => {
    expect(defaultFilename(new Date(2026, 0, 5))).toBe('flowsnap-flow-2026-01-05');
  });
});

describe('formatDelta', () => {
  it('shows seconds under a minute', () => {
    expect(formatDelta(1234)).toBe('+1.2s');
  });

  it('switches to minutes and seconds past one minute', () => {
    expect(formatDelta(63_000)).toBe('+1m 3s');
  });

  it('is empty for a negative delta rather than showing nonsense', () => {
    expect(formatDelta(-1)).toBe('');
  });
});

describe('pad2', () => {
  it('pads single digits only', () => {
    expect(pad2(1)).toBe('01');
    expect(pad2(12)).toBe('12');
  });
});

describe('startUrl', () => {
  it('is the first step’s URL', () => {
    expect(startUrl([step({ url: 'https://a.test/' }), step()])).toBe('https://a.test/');
  });

  it('is undefined for an empty flow', () => {
    expect(startUrl([])).toBeUndefined();
  });
});
