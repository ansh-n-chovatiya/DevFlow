/**
 * A patch is a claim that applying it reconstructs the after state.
 *
 * Every test here is that claim, checked. The interesting failures are the ones
 * that do not throw: a removal order that deletes the right number of the wrong
 * array elements, a pointer whose unescaped `/` silently addresses a path the
 * store does not have, and a budget spent by deleting operations rather than
 * coarsening them. All three produce a patch that applies cleanly and yields a
 * state the app never held, which is the one thing a record of what happened
 * must never do.
 */

import { describe, expect, it } from 'vitest';
import { applyPatch, diff, fromPointer, toPointer } from '../src/core/state/patch.js';
import { snapshot } from '../src/core/state/snapshot.js';

const UNBOUNDED = { maxOps: Number.POSITIVE_INFINITY };

/** Diff, apply, and assert the round trip that is the module's whole promise. */
function roundTrip(before: unknown, after: unknown, maxOps = Number.POSITIVE_INFINITY) {
  const result = diff(before, after, { maxOps });
  expect(applyPatch(before, result.ops)).toEqual(after);
  return result;
}

describe('what a diff says', () => {
  it('says nothing about equal documents', () => {
    expect(diff({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }, UNBOUNDED).ops).toEqual([]);
  });

  it('replaces a changed scalar and leaves its siblings alone', () => {
    const result = roundTrip({ a: 1, b: 2 }, { a: 1, b: 3 });

    expect(result.ops).toEqual([{ op: 'replace', path: '/b', value: 3 }]);
  });

  it('adds and removes keys, in sorted order', () => {
    const result = roundTrip({ keep: 1, gone: 2 }, { keep: 1, fresh: 3 });

    expect(result.ops).toEqual([
      { op: 'add', path: '/fresh', value: 3 },
      { op: 'remove', path: '/gone' },
    ]);
    // `value` is absent for `remove`, and only for `remove`.
    expect('value' in result.ops[1]).toBe(false);
  });

  it('replaces rather than reshapes when the kind of value changed', () => {
    expect(roundTrip({ a: { x: 1 } }, { a: [1] }).ops).toEqual([
      { op: 'replace', path: '/a', value: [1] },
    ]);
    expect(roundTrip({ a: [1] }, { a: 'one' }).ops).toEqual([
      { op: 'replace', path: '/a', value: 'one' },
    ]);
  });

  it('treats NaN as unchanged and 0 as -0', () => {
    expect(diff({ n: NaN }, { n: NaN }, UNBOUNDED).ops).toEqual([]);
    expect(diff({ n: 0 }, { n: -0 }, UNBOUNDED).ops).toEqual([]);
  });

  it('reports a null that became a value', () => {
    expect(roundTrip({ user: null }, { user: { id: 1 } }).ops).toEqual([
      { op: 'replace', path: '/user', value: { id: 1 } },
    ]);
  });
});

describe('arrays', () => {
  it('appends with the end-of-array pointer', () => {
    const result = roundTrip([1], [1, 2, 3]);

    expect(result.ops).toEqual([
      { op: 'add', path: '/-', value: 2 },
      { op: 'add', path: '/-', value: 3 },
    ]);
  });

  it('removes from the end backwards, so earlier removes do not renumber later ones', () => {
    // The defect: emitting the removes ascending. `remove /2` renumbers element
    // 3 to 2, so `remove /3` then deletes nothing and the survivor is wrong —
    // and the patch applies without complaint either way.
    const result = roundTrip(['a', 'b', 'c', 'd'], ['a', 'b']);

    expect(result.ops).toEqual([
      { op: 'remove', path: '/3' },
      { op: 'remove', path: '/2' },
    ]);
    expect(applyPatch(['a', 'b', 'c', 'd'], result.ops)).toEqual(['a', 'b']);
  });

  it('removes correctly from a nested array while its neighbours change', () => {
    const before = { rows: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] };
    const after = { rows: [{ n: 9 }, { n: 2 }] };

    expect(roundTrip(before, after).ops).toEqual([
      { op: 'replace', path: '/rows/0/n', value: 9 },
      { op: 'remove', path: '/rows/3' },
      { op: 'remove', path: '/rows/2' },
    ]);
  });

  it('recurses element-wise rather than replacing a whole list for one field', () => {
    const result = roundTrip([{ id: 1, seen: false }], [{ id: 1, seen: true }]);

    expect(result.ops).toEqual([{ op: 'replace', path: '/0/seen', value: true }]);
  });

  it('round-trips a list that both shrank and changed', () => {
    roundTrip([1, 2, 3, 4, 5], [9, 2]);
    roundTrip([1, 2], [1, 2, 3, 4, 5]);
    roundTrip([], [1]);
    roundTrip([1], []);
  });
});

describe('pointers', () => {
  it('escapes the two characters RFC 6901 reserves, and reads them back', () => {
    // The defect: writing the key raw. `/a/b` addresses a nested path the store
    // does not have, so the patch applies to nothing and the round trip is lost.
    const before = { 'a/b': 1, 'm~n': 2, plain: 3 };
    const after = { 'a/b': 2, 'm~n': 3, plain: 3 };

    const result = roundTrip(before, after);

    expect(result.ops.map((op) => op.path)).toEqual(['/a~1b', '/m~0n']);
    expect(applyPatch(before, result.ops)).toEqual(after);
  });

  it('escapes in an order that survives a key containing the escape itself', () => {
    // `~1` written literally must not come back as `/`.
    expect(toPointer(['a~1b'])).toBe('/a~01b');
    expect(fromPointer('/a~01b')).toEqual(['a~1b']);
    expect(fromPointer(toPointer(['a/b', 'm~n', '~/']))).toEqual(['a/b', 'm~n', '~/']);
  });

  it('reads the empty pointer as the whole document', () => {
    expect(fromPointer('')).toEqual([]);
    expect(toPointer([])).toBe('');
    expect(applyPatch({ a: 1 }, [{ op: 'replace', path: '', value: { b: 2 } }])).toEqual({ b: 2 });
  });

  it('round-trips a key that looks like an array index', () => {
    roundTrip({ '0': 'a', '1': 'b' }, { '0': 'z', '1': 'b' });
  });
});

describe('the budget', () => {
  it('is spent by coarsening, and the patch still applies exactly', () => {
    // The defect: `ops.slice(0, maxOps)`. Ten keys moved and three operations
    // are allowed; a truncated patch reconstructs a state the app never had.
    const before = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 };
    const after = { a: 2, b: 3, c: 4, d: 5, e: 6, f: 7, g: 8, h: 9, i: 10, j: 11 };

    const result = diff(before, after, { maxOps: 3 });

    expect(result.ops.length).toBeLessThanOrEqual(3);
    expect(result.collapsed).toBe(10 - result.ops.length);
    expect(applyPatch(before, result.ops)).toEqual(after);
  });

  it('folds the deepest operations first, keeping the shallow ones detailed', () => {
    const before = { flags: { a: 1, b: 2, c: 3 }, name: 'x' };
    const after = { flags: { a: 9, b: 8, c: 7 }, name: 'y' };

    const result = diff(before, after, { maxOps: 2 });

    expect(result.ops).toEqual([
      { op: 'replace', path: '/flags', value: { a: 9, b: 8, c: 7 } },
      { op: 'replace', path: '/name', value: 'y' },
    ]);
    expect(result.collapsed).toBe(2);
    expect(applyPatch(before, result.ops)).toEqual(after);
  });

  it('ends at a single replace of the whole document when it must', () => {
    const before = { a: 1, b: 2, c: 3 };
    const after = { a: 4, b: 5, c: 6 };

    const result = diff(before, after, { maxOps: 1 });

    expect(result.ops).toEqual([{ op: 'replace', path: '', value: after }]);
    expect(result.collapsed).toBe(2);
    expect(applyPatch(before, result.ops)).toEqual(after);
  });

  it('counts nothing collapsed when the patch already fits', () => {
    const result = diff({ a: 1 }, { a: 2 }, { maxOps: 40 });

    expect(result.collapsed).toBe(0);
  });

  it('still applies when appends and removals are folded alongside each other', () => {
    roundTrip({ list: [{ n: 1 }, { n: 2 }, { n: 3 }] }, { list: [{ n: 9 }] }, 2);
    roundTrip({ list: [{ n: 1 }] }, { list: [{ n: 9 }, { n: 2 }, { n: 3 }] }, 2);
    roundTrip({ a: { b: { c: { d: 1, e: 2 } } }, z: [1, 2, 3] }, { a: { b: { c: { d: 2, e: 3 } } }, z: [1] }, 2);
  });

  it('treats a budget below one operation as one, since zero describes nothing', () => {
    const before = { a: 1, b: 2 };
    const after = { a: 2, b: 3 };

    const result = diff(before, after, { maxOps: 0 });

    expect(result.ops).toEqual([{ op: 'replace', path: '', value: after }]);
    expect(applyPatch(before, result.ops)).toEqual(after);
  });
});

describe('applying', () => {
  it('leaves the document it was given untouched', () => {
    const before = { list: [1, 2], nested: { a: 1 } };
    const frozen = JSON.stringify(before);

    applyPatch(before, [
      { op: 'replace', path: '/nested/a', value: 9 },
      { op: 'remove', path: '/list/1' },
      { op: 'add', path: '/list/-', value: 5 },
    ]);

    expect(JSON.stringify(before)).toBe(frozen);
  });

  it('does not alias the values carried by the patch', () => {
    const value = { deep: 1 };
    const applied = applyPatch({}, [{ op: 'add', path: '/x', value }]) as { x: { deep: number } };

    applied.x.deep = 2;

    expect(value.deep).toBe(1);
  });

  it('skips an operation whose path is not there rather than throwing', () => {
    expect(applyPatch({ a: 1 }, [{ op: 'replace', path: '/gone/deep', value: 2 }])).toEqual({ a: 1 });
    expect(applyPatch({ a: 1 }, [{ op: 'remove', path: '/nope' }])).toEqual({ a: 1 });
    expect(applyPatch([1], [{ op: 'remove', path: '/7' }])).toEqual([1]);
  });

  it('inserts at an index when a patch names one', () => {
    expect(applyPatch([1, 3], [{ op: 'add', path: '/1', value: 2 }])).toEqual([1, 2, 3]);
  });
});

describe('a hostile store', () => {
  it('snapshots, diffs and re-applies at a tight budget', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) wide[`key${i}`] = i;

    function build(mutation: number): Record<string, unknown> {
      const root: Record<string, unknown> = {
        rows: [
          { id: 1, tags: ['a', 'b'], meta: { seen: false } },
          { id: 2, tags: [], meta: { seen: true, at: new Date('2026-01-02T03:04:05.000Z') } },
        ],
        cache: new Map<unknown, unknown>([
          ['users', [{ id: 1 }]],
          ['count', mutation],
        ]),
        blob: 'z'.repeat(5000),
        wide,
        mutation,
      };
      root.self = root;
      return root;
    }

    const budget = { maxDepth: 4, maxKeys: 40, maxEntries: 20, stringCap: 200 };
    const before = snapshot(build(1), budget);
    const after = snapshot(build(2), budget);

    expect(before.bounded).toBe(true);
    expect(JSON.parse(JSON.stringify(before.value))).toEqual(before.value);

    // The snapshot is stable, so the only difference is the one that moved.
    const exact = diff(before.value, after.value, UNBOUNDED);
    expect(exact.ops.map((op) => op.path).sort()).toEqual(['/cache/[Map]/1/1', '/mutation']);
    expect(applyPatch(before.value, exact.ops)).toEqual(after.value);

    const tight = diff(before.value, after.value, { maxOps: 1 });
    expect(tight.ops).toHaveLength(1);
    expect(applyPatch(before.value, tight.ops)).toEqual(after.value);
  });
});
