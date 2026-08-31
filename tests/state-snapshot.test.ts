/**
 * What a snapshot promises, which is less than fidelity and more than best effort.
 *
 * A snapshot is only ever read by being diffed against another one, so the tests
 * that matter are the ones about *stability*: the same store must produce the
 * same structure twice, a cut must fall in the same place both times, and a
 * value that could not be represented must say so in a way no app would say by
 * accident. Fidelity is tested too, but a wrong value here is a wrong value in
 * one step, where an unstable one is a diff full of changes that never happened.
 */

import { describe, expect, it } from 'vitest';
import { diff } from '../src/core/state/patch.js';
import type { SnapshotBudget } from '../src/core/state/snapshot.js';
import { snapshot } from '../src/core/state/snapshot.js';

const WIDE: SnapshotBudget = { maxDepth: 6, maxKeys: 40, maxEntries: 20, stringCap: 200 };

function budget(over: Partial<SnapshotBudget> = {}): SnapshotBudget {
  return { ...WIDE, ...over };
}

describe('the width cut', () => {
  it('keeps the same keys whatever order the app happens to hold them in', () => {
    // The defect: cutting in insertion order. Both objects hold the same three
    // pairs; only their key order differs, which is what a delete-and-reinsert
    // does to a live store.
    const inserted = { zulu: 1, alpha: 2, mike: 3 };
    const rebuilt: Record<string, number> = {};
    rebuilt.mike = 3;
    rebuilt.zulu = 1;
    rebuilt.alpha = 2;

    const before = snapshot(inserted, budget({ maxKeys: 2 }));
    const after = snapshot(rebuilt, budget({ maxKeys: 2 }));

    expect(Object.keys(before.value as object)).toEqual(['alpha', 'mike']);
    expect(after.value).toEqual(before.value);
    // The consequence, stated as the reader sees it: no change is reported for
    // a step in which nothing changed.
    expect(diff(before.value, after.value, { maxOps: 40 }).ops).toEqual([]);
  });

  it('marks an object it cut, and an array it cut', () => {
    const object = snapshot({ a: 1, b: 2, c: 3 }, budget({ maxKeys: 2 }));
    expect(object.value).toEqual({ a: 1, b: 2 });
    expect(object.bounded).toBe(true);

    const array = snapshot([1, 2, 3, 4], budget({ maxEntries: 2 }));
    expect(array.value).toEqual([1, 2]);
    expect(array.bounded).toBe(true);
  });

  it('leaves a value inside the budget unmarked', () => {
    expect(snapshot({ a: [1, 2], b: 'hi' }, budget())).toEqual({
      value: { a: [1, 2], b: 'hi' },
      bounded: false,
    });
  });
});

describe('the cap bit', () => {
  it('travels beside the value, never inside it', () => {
    const result = snapshot({ note: 'x'.repeat(12) }, budget({ stringCap: 5 }));

    // No ellipsis, no marker: a marker inside a value is a value, and gets
    // diffed and re-cut as one.
    expect(result.value).toEqual({ note: 'xxxxx' });
    expect(result.bounded).toBe(true);
  });

  it('surfaces from a cut buried under several levels', () => {
    // The defect: `bounded` computed from the top level only, so a truncated
    // snapshot claims to be complete.
    const deep = { a: { b: { c: { d: 'y'.repeat(300) } } } };

    const result = snapshot(deep, budget({ stringCap: 10 }));

    expect(result.bounded).toBe(true);
    expect(result.value).toEqual({ a: { b: { c: { d: 'y'.repeat(10) } } } });
  });

  it('surfaces from a width cut buried under several levels', () => {
    const result = snapshot({ a: { b: { c: [1, 2, 3] } } }, budget({ maxEntries: 1 }));

    expect(result.value).toEqual({ a: { b: { c: [1] } } });
    expect(result.bounded).toBe(true);
  });
});

describe('depth', () => {
  it('stops at the budget and says where it stopped', () => {
    const result = snapshot({ a: { b: { c: 1 } } }, budget({ maxDepth: 2 }));

    expect(result.value).toEqual({ a: { b: { c: '[depth]' } } });
    expect(result.bounded).toBe(true);
  });
});

describe('cycles', () => {
  it('names a value that contains itself', () => {
    const root: Record<string, unknown> = { name: 'root' };
    root.self = root;

    const result = snapshot(root, budget());

    expect(result.value).toEqual({ name: 'root', self: '[circular]' });
    expect(result.bounded).toBe(true);
  });

  it('does not call a shared child a cycle', () => {
    // The defect: tracking every object ever visited instead of the ancestor
    // path. A store that hands one config object to two slices is a DAG, and
    // calling the second reference circular deletes real state.
    const shared = { flag: true };

    const result = snapshot({ a: shared, b: shared }, budget());

    expect(result.value).toEqual({ a: { flag: true }, b: { flag: true } });
    expect(result.bounded).toBe(false);
  });

  it('does not call a repeated sibling in an array a cycle', () => {
    const shared = { id: 7 };

    expect(snapshot([shared, shared], budget()).value).toEqual([{ id: 7 }, { id: 7 }]);
  });
});

describe('values JSON has no room for', () => {
  it('gives each one a sentinel an app would not have stored', () => {
    const result = snapshot(
      {
        fn: () => 1,
        sym: Symbol('s'),
        big: 90071992547409910n,
        nan: NaN,
        inf: Infinity,
        ninf: -Infinity,
        negZero: -0,
        node: { nodeType: 1, tagName: 'DIV' },
        promise: { then: () => undefined },
        when: new Date('2026-08-31T00:00:00.000Z'),
        re: /ab+c/gi,
        err: new TypeError('nope'),
      },
      budget(),
    );

    expect(result.value).toEqual({
      fn: '[function]',
      sym: '[symbol]',
      big: '90071992547409910',
      nan: null,
      inf: null,
      ninf: null,
      negZero: 0,
      node: '[dom]',
      promise: '[promise]',
      when: '2026-08-31T00:00:00.000Z',
      re: '/ab+c/gi',
      err: { name: 'TypeError', message: 'nope' },
    });
    // None of these are cuts: the value is fully represented, just not as itself.
    expect(result.bounded).toBe(false);
  });

  it('keeps the sign off zero so a diff of 0 and -0 is empty', () => {
    expect(Object.is((snapshot({ n: -0 }, budget()).value as { n: number }).n, 0)).toBe(true);
  });

  it('drops an undefined property and nulls an undefined element', () => {
    // The defect: keeping `b: null`, which is a value the app never held and a
    // spurious operation the first time the key is really added.
    const before = snapshot({ a: 1, b: undefined }, budget());
    const after = snapshot({ a: 1 }, budget());

    expect(before.value).toEqual({ a: 1 });
    expect(Object.keys(before.value as object)).toEqual(['a']);
    expect(diff(before.value, after.value, { maxOps: 40 }).ops).toEqual([]);

    // An array element has a position that cannot be dropped without moving its
    // neighbours, so it becomes null — as `JSON.stringify` does.
    expect(snapshot([1, undefined, 3], budget()).value).toEqual([1, null, 3]);
  });

  it('turns a bare undefined root into null', () => {
    expect(snapshot(undefined, budget())).toEqual({ value: null, bounded: false });
  });

  it('reads an invalid Date as null rather than throwing', () => {
    expect(snapshot({ when: new Date(NaN) }, budget()).value).toEqual({ when: null });
  });
});

describe('collections', () => {
  it('carries a Map as its entries, bounded like an array', () => {
    const map = new Map<unknown, unknown>([
      ['a', 1],
      ['b', { deep: true }],
      ['c', 3],
    ]);

    const result = snapshot(map, budget({ maxEntries: 2 }));

    expect(result.value).toEqual({ '[Map]': [['a', 1], ['b', { deep: true }]] });
    expect(result.bounded).toBe(true);
  });

  it('carries a Set as its members', () => {
    expect(snapshot(new Set([1, 'two']), budget()).value).toEqual({ '[Set]': [1, 'two'] });
  });

  it('walks a class instance as the plain object its fields make', () => {
    class Cart {
      items = ['a'];
      total = 12;
      label(): string {
        return 'cart';
      }
    }

    expect(snapshot(new Cart(), budget()).value).toEqual({ items: ['a'], total: 12 });
  });
});

describe('hostile properties', () => {
  it('names a getter that throws instead of losing the snapshot', () => {
    const store = {
      safe: 1,
      get angry(): never {
        throw new Error('revoked');
      },
    };

    const result = snapshot(store, budget());

    expect(result.value).toEqual({ angry: '[unreadable]', safe: 1 });
    expect(result.bounded).toBe(true);
  });
});

describe('secrets', () => {
  const secret = budget({ secretKey: (key: string) => /token|password/i.test(key) });

  it('keeps the key and replaces the value', () => {
    expect(snapshot({ user: 'ada', authToken: 'abc.def.ghi' }, secret).value).toEqual({
      authToken: '[redacted]',
      user: 'ada',
    });
  });

  it('does not descend into what it masked', () => {
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) huge[`k${i}`] = i;

    const result = snapshot({ password: huge, other: 1 }, { ...secret, maxKeys: 40 });

    expect(result.value).toEqual({ other: 1, password: '[redacted]' });
    // The masked object cost no width budget and no depth, so nothing was cut.
    expect(result.bounded).toBe(false);
  });

  it('does not mark a snapshot bounded', () => {
    // The defect: routing the mask through the truncation path. `bounded` means
    // a value may have moved without the snapshot showing it, and a mask is
    // stable — it shows the same thing whether or not the secret changed.
    expect(snapshot({ password: 'hunter2' }, secret).bounded).toBe(false);
  });

  it('masks a rotated secret identically, so it diffs as unchanged', () => {
    const before = snapshot({ sessionToken: 'one', cart: 1 }, secret);
    const after = snapshot({ sessionToken: 'two', cart: 1 }, secret);

    expect(diff(before.value, after.value, { maxOps: 40 }).ops).toEqual([]);
  });

  it('leaves a value alone however secret it looks', () => {
    // Only names are consulted: an array element has none, and a predicate over
    // contents would redact the app's own copy of the word "token".
    const result = snapshot({ list: ['password', 'token'] }, secret);

    expect(result.value).toEqual({ list: ['password', 'token'] });
  });

  it('treats a predicate that throws as masking nothing', () => {
    const throwing = budget({
      secretKey: () => {
        throw new Error('bad predicate');
      },
    });

    expect(snapshot({ a: 1 }, throwing)).toEqual({ value: { a: 1 }, bounded: false });
  });

  it('masks nothing when no predicate is given', () => {
    expect(snapshot({ password: 'hunter2' }, budget()).value).toEqual({ password: 'hunter2' });
  });
});
