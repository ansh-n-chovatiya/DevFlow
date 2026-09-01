/**
 * `readStamp`, and the rule that nothing may depend on it.
 *
 * The stamp is a property on an object out of a page DevFlow does not control,
 * and there is no marker that could distinguish "our plugin wrote this" from
 * "an application happened to pick this name". So the shape is the whole of the
 * check, and every malformed shape has to come back `null` rather than reach a
 * `ComponentSource` as a path a person would then try to open.
 *
 * The last block is `ROADMAP_AND_PHASES.md` §1.1 rule 2, asserted on purpose:
 * no feature may require the plugin. The rest of the suite is the standing
 * proof — it runs without the plugin and always has — but a standing proof goes
 * quiet the day someone makes the stamp load-bearing, so this says it out loud.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readStamp } from '../src/core/react/stamp.js';
import { mergeComponents } from '../src/core/react/table.js';
import type { CapturedComponent } from '../src/shared/messages.js';
import type { ComponentNeedle, ComponentSource } from '../src/shared/types.js';

/** A component function carrying whatever the argument says. */
function stamped(value: unknown): () => null {
  const fn = () => null;
  Object.defineProperty(fn, '__devflow', { value, enumerable: false, configurable: true });
  return fn;
}

describe('readStamp', () => {
  it('reads a well-formed stamp off a component function', () => {
    expect(readStamp(stamped({ f: 'src/Cart.tsx', l: 12 }))).toEqual({
      source: 'src/Cart.tsx',
      line: 12,
    });
  });

  /*
   * `forwardRef` and `memo` return an object, not a function, and that object is
   * what the const binds — so it is what the plugin stamps. A reader that only
   * accepted functions would silently skip every wrapped component in the app.
   */
  it('reads a stamp off a plain object, which is what a forwardRef wrapper is', () => {
    const wrapper = { $$typeof: Symbol.for('react.forward_ref'), render: () => null };
    Object.defineProperty(wrapper, '__devflow', { value: { f: 'src/Row.tsx', l: 4 } });

    expect(readStamp(wrapper)).toEqual({ source: 'src/Row.tsx', line: 4 });
  });

  it('returns null for anything that cannot hold a property', () => {
    for (const value of [null, undefined, 0, 12, '', 'src/Cart.tsx', true, Symbol('x')]) {
      expect(readStamp(value)).toBeNull();
    }
  });

  it('returns null for a function with no stamp at all', () => {
    expect(readStamp(() => null)).toBeNull();
    expect(readStamp({})).toBeNull();
  });

  /*
   * Own property only. A page that puts `__devflow` on `Function.prototype`
   * would otherwise make every function in the app claim one file.
   */
  it('ignores an inherited stamp', () => {
    const base = { __devflow: { f: 'src/Everything.tsx', l: 1 } };
    const derived = Object.create(base) as object;

    expect(readStamp(derived)).toBeNull();
  });

  it('returns null for every malformed shape rather than throwing', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      'src/Cart.tsx:12',
      12,
      [],
      {},
      { f: 'src/Cart.tsx' }, // no line
      { l: 12 }, // no file
      { f: '', l: 12 }, // empty file
      { f: 'src/Cart.tsx', l: 0 }, // 0 is not a 1-based line
      { f: 'src/Cart.tsx', l: -3 },
      { f: 'src/Cart.tsx', l: 1.5 },
      { f: 'src/Cart.tsx', l: NaN },
      { f: 'src/Cart.tsx', l: Infinity },
      { f: 'src/Cart.tsx', l: '12' }, // a string that looks like a line
      { f: 12, l: 12 },
      { f: null, l: 12 },
      { f: ['src/Cart.tsx'], l: 12 },
    ];

    for (const value of malformed) {
      expect(readStamp(stamped(value)), JSON.stringify(value ?? String(value))).toBeNull();
    }
  });

  /*
   * A path is bounded by a filesystem; a string on a page object is bounded by
   * nothing, and this value travels into a stored flow and out to the MCP
   * server. A megabyte of text is not a path however it is spelled.
   */
  it('rejects a source longer than any real path, and accepts one at the limit', () => {
    expect(readStamp(stamped({ f: 'a'.repeat(1025), l: 1 }))).toBeNull();
    expect(readStamp(stamped({ f: 'a'.repeat(1024), l: 1 }))).toEqual({
      source: 'a'.repeat(1024),
      line: 1,
    });
  });

  /*
   * Three places a page can throw at this, and the third is the one that was
   * outside the guard: `f` and `l` are two more property reads on an object
   * off somebody's page. A throw there does not lose a stamp — it escapes
   * `describeEntry`, which the agent's interaction listener calls, so the step
   * is emitted with no component chain at all, silently, for the life of the
   * page. The first two cases passed against exactly that bug.
   */
  it('does not throw, wherever on the object the page put the trap', () => {
    const onProperty = {};
    Object.defineProperty(onProperty, '__devflow', {
      get() {
        throw new Error('no');
      },
      configurable: true,
    });

    const onField = stamped({
      get f(): string {
        throw new Error('no');
      },
      l: 12,
    });

    const onLine = stamped({
      f: 'src/Cart.tsx',
      get l(): number {
        throw new Error('no');
      },
    });

    const onEverything = stamped(
      new Proxy(
        {},
        {
          get() {
            throw new Error('no');
          },
        },
      ),
    );

    for (const hostile of [onProperty, onField, onLine, onEverything]) {
      expect(readStamp(hostile)).toBeNull();
    }
  });
});

// ── Rule 2: no feature may require the plugin ────────────────────────────────

function empty(): {
  table: Record<string, ComponentSource>;
  needles: Record<string, ComponentNeedle>;
} {
  return { table: {}, needles: {} };
}

describe('the standalone path with no plugin installed', () => {
  /*
   * §1.1 rule 2. Everything must work with the stamp absent, and this is the
   * assertion that goes red if a refactor ever makes it load-bearing — an
   * `undefined` stamp must reach the bundle-search queue exactly as it did
   * before the field existed, not fall into a new "no stamp" status.
   */
  it('queues a component with no stamp for bundle search, as it always has', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = {
      id: 'abc123',
      name: 'Cart',
      needle: { head: 'function Cart(){return null}' },
    };

    const result = mergeComponents([component], 'https://app.test', table, needles);

    expect(result.table.abc123).toEqual({ name: 'Cart', status: 'pending' });
    expect(result.needles.abc123).toMatchObject({ head: 'function Cart(){return null}' });
  });

  it('still explains a component it cannot search for, rather than blaming the missing plugin', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = {
      id: 'n_native',
      name: 'Bound',
      needleRejection: 'native',
      stamp: null,
    };

    const result = mergeComponents([component], 'https://app.test', table, needles);

    expect(result.table.n_native.status).toBe('skipped');
    expect(result.table.n_native.detail).toBe(
      'A bound or native function — its source exists in no bundle to search.',
    );
    expect(result.table.n_native.via).toBeUndefined();
  });
});

// ── The recorder's half, which cannot be imported ────────────────────────────

/*
 * `src/injected/agent.ts` registers listeners at import and cannot be loaded in
 * a test, so this is a source-text assertion — the weakest kind, and here the
 * only kind. It asserts the *exact expressions* rather than a nearby phrase,
 * because a grep for a comment passes against the deletion of the line under it.
 *
 * The equivalent for the picker is behavioural: `describePicked` is exported and
 * `picker.test.ts` drives it with real fibers.
 */
describe('describeEntry, asserted through its source', () => {
  const agent = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/injected/agent.ts'),
    'utf8',
  );

  it('reads the component function’s stamp before the wrapper’s', () => {
    expect(agent).toContain('return readStamp(entry.fn) ?? readStamp(entry.type);');
  });

  /*
   * Four shapes leave `describeEntry` — an unsettled lazy, a function whose
   * `toString()` threw, a needle that built, and a needle that was rejected —
   * and a stamp dropped from any one of them is a component the plugin silently
   * did not help. The count is the assertion: adding a fifth return without a
   * stamp on it fails here.
   */
  it('puts the stamp on every shape that leaves it', () => {
    // Comments stripped first, or the prose explaining the rule counts as an
    // instance of it — this test caught exactly that on its own comment.
    const body = agent
      .slice(agent.indexOf('function describeEntry('), agent.indexOf('// ── Script inventory'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(body).not.toBe('');
    expect(body).toContain('const stamp = describeStamp(entry);');

    // Counted against `debugSource` rather than against a number, because the
    // number is the thing that changes when a shape is added and the invariant
    // is not: `debugSource` already travels on every shape that leaves here, so
    // a stamp that travels on fewer is a stamp being dropped somewhere.
    const shorthand = (name: string) => (body.match(new RegExp(`\\b${name}(?:,|\\s*\\})`, 'g')) ?? []).length;

    expect(shorthand('stamp')).toBe(shorthand('debugSource'));
    expect(shorthand('stamp')).toBeGreaterThanOrEqual(4);
  });

  /*
   * A cache hit is the fifth shape, and the one that can be wrong in a way no
   * other can: the cache is keyed by the component function, but a stamp may
   * sit on the wrapper around it, and `identifyComponent` builds an entry whose
   * `type` is the function itself. So a `forwardRef` component seen first as a
   * context subscriber caches a null stamp, and every later sighting through
   * its wrapper would return that null — the same component's file present or
   * absent depending on which of two samples ran first in one step.
   */
  it('fills a stamp into a cache entry that was made without one', () => {
    expect(agent).toContain('const fillStamp = stamp && !cached.stamp;');
    expect(agent).toContain('...(fillStamp ? { stamp } : {}),');
    expect(agent).toContain('if (!fillDebug && !fillStamp) return cached;');
  });
});
