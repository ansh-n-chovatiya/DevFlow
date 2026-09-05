// @vitest-environment jsdom

/**
 * Two contexts, one name, and the reading that was reported against the wrong
 * one.
 *
 * `readContexts` keyed a context by its `displayName`, and `changesBetween`
 * resolves a key by the *first* match in the other reading. React neither
 * guarantees a `displayName` is unique nor requires one to be set, and two
 * contexts sharing a name is ordinary — a library's `Theme` and an app's, or
 * two of the same library's. Under one name the second context was compared
 * against the first's value, so a context that did not change was reported as
 * changed, and it was reported carrying the other one's before and after.
 *
 * That is the failure this feature can least afford: not a missing row but a
 * plausible one, on a screen whose whole purpose is telling somebody why a
 * component re-rendered. A reader chasing `Theme` would find nothing wrong with
 * it, because nothing was.
 *
 * The fixtures are React's internals written out by hand, for the reason
 * `render-sampling.test.ts` gives over its own: there is no React here to
 * produce fibers, and every comparison commits the way React commits, by
 * swapping the halves of the pair.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { isSecretStateKey } from '../src/core/redact/index.js';
import type { SnapshotBudget } from '../src/core/state/snapshot.js';
import { compareRenders, sampleRenders, type RenderSample } from '../src/injected/render.js';

const BUDGET: SnapshotBudget = {
  maxDepth: 6,
  maxKeys: 40,
  maxEntries: 20,
  stringCap: 200,
  secretKey: isSecretStateKey,
};

const NODE_CAP = 500;

/** Component ids, as the recorder would mint them — one per component fn. */
const identify = (_fn: unknown, name: string): string => name;

interface Dep {
  context?: { displayName?: string } | null;
  memoizedValue?: unknown;
  next?: Dep | null;
}

interface FakeFiber {
  type?: unknown;
  stateNode?: unknown;
  memoizedProps?: Record<string, unknown> | null;
  dependencies?: { firstContext?: Dep | null } | null;
  child?: FakeFiber | null;
  sibling?: FakeFiber | null;
  return?: FakeFiber | null;
  alternate?: FakeFiber | null;
}

/**
 * One component as React keeps it: two fibers that are each other's alternate.
 *
 * The props object differs between the halves because that reference *is* the
 * evidence a render happened — a pair sharing one props object is reported as
 * not having rendered and never reaches the comparison under test.
 */
function pairOf(contexts: { before: Dep; after: Dep }): { current: FakeFiber; next: FakeFiber } {
  const type = Object.defineProperty(() => 'Header', 'name', { value: 'Header' });
  const half = (deps: Dep): FakeFiber => ({
    type,
    memoizedProps: { a: 1 },
    dependencies: { firstContext: deps },
    child: null,
  });
  const current = half(contexts.before);
  const next = half(contexts.after);
  current.alternate = next;
  next.alternate = current;
  return { current, next };
}

/** Mount a tree under a container the sampler will find. */
function mount(child: FakeFiber): FakeFiber {
  const el = document.createElement('div');
  el.id = 'root';
  document.body.append(el);

  const fiberRoot = { current: null as unknown as FakeFiber };
  const hostRoot: FakeFiber = { type: null, child, stateNode: fiberRoot };
  fiberRoot.current = hostRoot;
  child.return = hostRoot;

  (el as unknown as Record<string, unknown>)['__reactContainer$abc'] = hostRoot;
  return hostRoot;
}

function sample(): RenderSample {
  return sampleRenders(NODE_CAP);
}

/** The two readings either side of a commit, as the recorder takes them. */
function across(contexts: { before: Dep; after: Dep }) {
  const { current, next } = pairOf(contexts);
  const root = mount(current);
  const before = sample();
  root.child = next;
  return compareRenders(before, sample(), BUDGET, identify).observed[0];
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a component reading two contexts that declare the same name', () => {
  /** Two distinct context objects, both called `Theme`, read in a fixed order. */
  const theme = { displayName: 'Theme' };
  const otherTheme = { displayName: 'Theme' };
  const deps = (first: string, second: string): Dep => ({
    context: theme,
    memoizedValue: first,
    next: { context: otherTheme, memoizedValue: second },
  });

  it('reports the one that changed, with its own values', () => {
    const observed = across({ before: deps('light', 'en'), after: deps('light', 'fr') });

    expect(observed?.contexts).toEqual([
      { key: 'Theme (context 2)', before: 'en', after: 'fr' },
    ]);
  });

  it('does not report the one that did not', () => {
    // The first context changed and the second held. Resolved by name, the
    // second was compared against the first's value and reported as changed
    // too — a second row, about a context nothing had happened to.
    const observed = across({ before: deps('light', 'en'), after: deps('dark', 'en') });

    expect(observed?.contexts).toEqual([
      { key: 'Theme (context 1)', before: 'light', after: 'dark' },
    ]);
  });

  it('gives the reader two keys, so the two rows are not one row twice', () => {
    const observed = across({ before: deps('light', 'en'), after: deps('dark', 'fr') });

    expect(observed?.contexts.map((change) => change.key)).toEqual([
      'Theme (context 1)',
      'Theme (context 2)',
    ]);
  });
});

describe('the common case pays nothing for the rare one', () => {
  it('leaves a name that does not repeat exactly as the context declares it', () => {
    const theme = { displayName: 'Theme' };
    const locale = { displayName: 'Locale' };
    const deps = (mode: string): Dep => ({
      context: theme,
      memoizedValue: mode,
      next: { context: locale, memoizedValue: 'en' },
    });
    const observed = across({ before: deps('light'), after: deps('dark') });

    expect(observed?.contexts).toEqual([{ key: 'Theme', before: 'light', after: 'dark' }]);
  });

  it('still numbers a context that declares no name at all', () => {
    const named = { displayName: 'Theme' };
    const deps = (mode: string): Dep => ({
      context: named,
      memoizedValue: 'light',
      next: { context: {}, memoizedValue: mode },
    });
    const observed = across({ before: deps('en'), after: deps('fr') });

    expect(observed?.contexts).toEqual([{ key: 'context 2', before: 'en', after: 'fr' }]);
  });
});
