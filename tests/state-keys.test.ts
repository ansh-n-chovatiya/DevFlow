/**
 * The two lists a reader sees before they see a patch.
 *
 * `cart, session` on a step is what makes a state delta scannable; the forty
 * pointers behind it are what makes it checkable. Both are derived from what was
 * actually recorded, so the tests here are mostly about what these functions
 * refuse to guess.
 */

import { describe, expect, it } from 'vitest';
import type { PatchOp } from '../src/shared/types.js';
import { storeKeys, touchedKeys } from '../src/core/state/keys.js';
import { diff } from '../src/core/state/patch.js';

describe('storeKeys', () => {
  it('names the slices, sorted', () => {
    expect(storeKeys({ session: {}, cart: {}, auth: {} })).toEqual(['auth', 'cart', 'session']);
  });

  it('names nothing for a value that has no slices', () => {
    expect(storeKeys([1, 2, 3])).toEqual([]);
    expect(storeKeys('a string')).toEqual([]);
    expect(storeKeys(null)).toEqual([]);
    expect(storeKeys(undefined)).toEqual([]);
    expect(storeKeys(42)).toEqual([]);
  });

  it('is empty for an empty store rather than absent', () => {
    expect(storeKeys({})).toEqual([]);
  });
});

describe('touchedKeys', () => {
  it('names the top-level key of each operation, deduplicated and sorted', () => {
    const ops = diff(
      { cart: { items: [1] }, session: { id: 'a' }, theme: 'dark' },
      { cart: { items: [1, 2] }, session: { id: 'b' }, theme: 'dark' },
      { maxOps: 40 },
    ).ops;

    expect(touchedKeys(ops)).toEqual(['cart', 'session']);
  });

  it('unescapes the pointer rather than reporting the encoded form', () => {
    const ops: PatchOp[] = [
      { op: 'replace', path: '/a~1b/deep', value: 1 },
      { op: 'remove', path: '/m~0n' },
    ];

    expect(touchedKeys(ops)).toEqual(['a/b', 'm~n']);
  });

  it('names no key for a whole-store replace', () => {
    // It has no after-document, and a list of slices read off a pointer that
    // does not mention them would be a guess wearing the same clothes as an
    // observation.
    expect(touchedKeys([{ op: 'replace', path: '', value: { a: 1, b: 2 } }])).toEqual([]);
  });

  it('still names the keys of the operations beside a whole-store replace', () => {
    const ops: PatchOp[] = [
      { op: 'replace', path: '', value: {} },
      { op: 'add', path: '/cart', value: 1 },
    ];

    expect(touchedKeys(ops)).toEqual(['cart']);
  });

  it('is empty for an empty patch', () => {
    expect(touchedKeys([])).toEqual([]);
  });
});
