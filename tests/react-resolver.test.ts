import { beforeEach, describe, expect, it } from 'vitest';
import { pos1 } from '../src/core/react/positions.js';
import { bundleBudget, createWorkerProvider } from '../src/features/react/providers/worker.js';
import { clearResolverCaches, resolvePending, type ResolveDeps } from '../src/features/react/resolver.js';
import { resolve as resolveSettings } from '../src/features/settings/resolve.js';
import { flowError } from '../src/shared/errors.js';
import type { ComponentNeedle, ComponentSource } from '../src/shared/types.js';
import { sourceMapJson } from './helpers/sourcemap-fixture.js';
import { pos1 } from '../src/core/react/positions.js';

/**
 * The shipped budget, derived from the field table rather than retyped.
 *
 * `docs/CONTRACTS.md` §3.2 is explicit that these five numbers have exactly one
 * source; a test that spelled them out again would be a second one, and the
 * first thing it would stop catching is a default that moved.
 */
const BUDGET = bundleBudget(resolveSettings({}));

const PAGE = 'https://shop.test/products/42';
const BUNDLE_URL = 'https://shop.test/assets/app.js';
const MAP_URL = 'https://shop.test/assets/app.js.map';

const CART_SOURCE = 'function Cart(){return null}';

/** `var x=1;\n` is 9 characters, so the function starts at line 1, column 0. */
const BUNDLE = `var x=1;\n${CART_SOURCE}\n//# sourceMappingURL=app.js.map`;

/** Line 1 of the bundle maps to Cart.tsx line 33, column 2 — both 0-based. */
const MAP = sourceMapJson(
  ['webpack://shop/./src/cart/Cart.tsx'],
  [[], [{ generatedColumn: 0, sourceIndex: 0, originalLine: 33, originalColumn: 2 }]],
);

function needle(overrides: Partial<ComponentNeedle> = {}): ComponentNeedle {
  return { head: CART_SOURCE, pageUrl: PAGE, ...overrides };
}

function pending(name = 'Cart'): ComponentSource {
  return { name, status: 'pending' };
}

interface Harness {
  deps: ResolveDeps;
  fetched: string[];
}

/**
 * A real `WorkerProvider` over a fake web.
 *
 * The stub is at `fetchText`, not at the provider, so every one of these tests
 * runs through the actual bundle cache, the actual in-flight dedupe and the
 * actual size caps — which is the point of the seam. Stubbing `BundleProvider`
 * itself would leave the thing that now owns all three untested from here.
 *
 * The inventory is empty because a resolve pass never asks for it: it works
 * from the snapshot on `ResolveInput`, so that the answers it writes down stay
 * pinned to the inventory size they were reached with.
 */
function harness(files: Record<string, string>): Harness {
  const fetched: string[] = [];

  const provider = createWorkerProvider(BUDGET, {
    scripts: {},
    fetchText: (url) => {
      fetched.push(url);
      const text = files[url];
      return Promise.resolve(
        text === undefined
          ? { ok: false as const, error: flowError('RESOURCE_UNFETCHABLE', url) }
          : { ok: true as const, value: text },
      );
    },
  });

  return { fetched, deps: { provider, now: () => 0 } };
}

/**
 * A clock that sets the deadline on its first reading and is past it on the
 * next. A fixed clock cannot exhaust a budget it is used to compute.
 */
function exhaustedClock(): () => number {
  let t = 0;
  return () => {
    const now = t;
    t += 60_000;
    return now;
  };
}

function input(overrides: Partial<Parameters<typeof resolvePending>[0]> = {}) {
  return {
    components: { cart: pending() },
    needles: { cart: needle() },
    scripts: { 'https://shop.test': [BUNDLE_URL] },
    final: false,
    ...overrides,
  };
}

beforeEach(() => clearResolverCaches());

describe('resolvePending', () => {
  it('resolves a component to its original file, 1-based — and its compiled one 0-based', () => {
    const { deps } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP });

    return resolvePending(input(), deps).then((result) => {
      expect(result.changed).toBe(true);
      // D1, both halves of it in one assertion. The fixture's mapping is
      // 0-based `33:2`, and what a person reads is `34:3` — converted once,
      // here, by `toOneBased`. `compiled` does not convert: it is an offset
      // into the minified bundle and DevTools' Sources panel wants it 0-based.
      expect(result.components.cart).toEqual({
        name: 'Cart',
        status: 'resolved',
        via: 'bundle-search',
        source: 'src/cart/Cart.tsx',
        line: 34,
        column: 3,
        compiled: { url: BUNDLE_URL, line: 1, column: 0 },
      });
    });
  });

  it('drops the needle once a component has a terminal answer', async () => {
    const { deps } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP });
    const result = await resolvePending(input(), deps);

    // A needle is 200 characters of the site's own source. Once it has done its
    // one job it should not still be sitting in storage.
    expect(result.needles).toEqual({});
  });

  it('marks a resolved dependency so owner selection can skip it', async () => {
    const map = sourceMapJson(
      ['webpack://shop/./node_modules/@mui/material/Button.js'],
      [[], [{ generatedColumn: 0, sourceIndex: 0, originalLine: 4, originalColumn: 0 }]],
    );
    const { deps } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: map });

    const result = await resolvePending(input(), deps);
    expect(result.components.cart).toMatchObject({
      status: 'resolved',
      source: 'node_modules/@mui/material/Button.js',
      dependency: true,
    });
  });

  it('keeps an absolute path in both fields, so a dev-server path stays openable', async () => {
    const map = sourceMapJson(
      ['/Users/me/shop/src/cart/Cart.tsx'],
      [[], [{ generatedColumn: 0, sourceIndex: 0, originalLine: 0, originalColumn: 0 }]],
    );
    const { deps } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: map });

    const result = await resolvePending(input(), deps);
    expect(result.components.cart).toMatchObject({
      source: '/Users/me/shop/src/cart/Cart.tsx',
      absolutePath: '/Users/me/shop/src/cart/Cart.tsx',
    });
  });

  it('reads a source map inlined as a data URL without another request', async () => {
    const base64 = Buffer.from(MAP, 'utf-8').toString('base64');
    const bundle = `var x=1;\n${CART_SOURCE}\n//# sourceMappingURL=data:application/json;base64,${base64}`;
    const { deps, fetched } = harness({ [BUNDLE_URL]: bundle });

    const result = await resolvePending(input(), deps);
    expect(result.components.cart).toMatchObject({ status: 'resolved', line: 34 });
    expect(fetched).toEqual([BUNDLE_URL]);
  });

  it('reports compiled-only, with a sentence, when the bundle ships no map', async () => {
    const { deps } = harness({ [BUNDLE_URL]: `var x=1;\n${CART_SOURCE}\n` });

    const result = await resolvePending(input(), deps);
    expect(result.components.cart).toMatchObject({
      status: 'compiled-only',
      compiled: { url: BUNDLE_URL, line: 1, column: 0 },
    });
    expect(result.components.cart.detail).toMatch(/no source map/);
    expect(result.components.cart.source).toBeUndefined();
  });

  it('keeps the compiled position when the map is missing or broken', async () => {
    const missing = harness({ [BUNDLE_URL]: BUNDLE });
    const broken = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: 'not json' });

    const noMap = await resolvePending(input(), missing.deps);
    expect(noMap.components.cart).toMatchObject({ status: 'map-error' });
    expect(noMap.components.cart.detail).toMatch(/404 or private/);
    expect(noMap.components.cart.compiled).toEqual({ url: BUNDLE_URL, line: 1, column: 0 });

    clearResolverCaches();
    const badMap = await resolvePending(input(), broken.deps);
    expect(badMap.components.cart).toMatchObject({ status: 'map-error' });
    expect(badMap.components.cart.detail).toMatch(/not valid JSON/);
  });

  it('says a position exists in the bundle but not in its map', async () => {
    // A map that covers only line 0, while the function sits on line 1.
    const map = sourceMapJson(['src/other.tsx'], [[{ generatedColumn: 0, sourceIndex: 0 }]]);
    const { deps } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: map });

    const result = await resolvePending(input(), deps);
    expect(result.components.cart).toMatchObject({ status: 'map-error' });
    expect(result.components.cart.detail).toMatch(/no mapping covering/);
  });

  it('calls a match in several chunks ambiguous and says so', async () => {
    const other = 'https://shop.test/assets/vendor.js';
    const { deps } = harness({
      [BUNDLE_URL]: BUNDLE,
      [MAP_URL]: MAP,
      [other]: `something else\n${CART_SOURCE}\n`,
    });

    const result = await resolvePending(
      input({ scripts: { 'https://shop.test': [BUNDLE_URL, other] } }),
      deps,
    );

    expect(result.components.cart).toMatchObject({
      status: 'ambiguous',
      matchCount: 2,
      source: 'src/cart/Cart.tsx',
    });
    expect(result.components.cart.detail).toMatch(/may be the wrong one/);
  });

  it('names a lazy chunk as the likely cause when nothing matched', async () => {
    const { deps } = harness({ [BUNDLE_URL]: 'var x=1;\n' });

    const result = await resolvePending(input(), deps);
    expect(result.components.cart).toMatchObject({ status: 'not-found' });
    expect(result.components.cart.detail).toMatch(/lazy chunk/);
    // The needle is kept: the chunk may still load later in the recording.
    expect(result.needles.cart?.searched).toBe(1);
  });

  it('does not rescan the same bundles for a component it already failed to find', async () => {
    const { deps, fetched } = harness({ [BUNDLE_URL]: 'var x=1;\n' });

    const first = await resolvePending(input(), deps);
    const second = await resolvePending(
      input({ components: first.components, needles: first.needles }),
      deps,
    );

    expect(fetched).toEqual([BUNDLE_URL]);
    expect(second.changed).toBe(false);
  });

  it('retries once the page has loaded a chunk it has not seen', async () => {
    const lazy = 'https://shop.test/assets/lazy.js';
    const { deps } = harness({ [BUNDLE_URL]: 'var x=1;\n', [lazy]: BUNDLE, [MAP_URL]: MAP });

    const first = await resolvePending(input(), deps);
    expect(first.components.cart.status).toBe('not-found');

    const second = await resolvePending(
      input({
        components: first.components,
        needles: first.needles,
        scripts: { 'https://shop.test': [BUNDLE_URL, lazy] },
      }),
      deps,
    );

    expect(second.components.cart).toMatchObject({ status: 'resolved', line: 34 });
  });

  it('separates "could not read the bundles" from "not in them"', async () => {
    const { deps } = harness({});

    const result = await resolvePending(input(), deps);
    expect(result.components.cart).toMatchObject({ status: 'unfetchable' });
    expect(result.components.cart.detail).toMatch(/None of the page's script bundles/);
    // Retryable without needing new scripts — a fetch can fail once.
    expect(result.needles.cart?.searched).toBe(0);
  });

  it('says so when the page reported no scripts at all', async () => {
    const { deps, fetched } = harness({ [BUNDLE_URL]: BUNDLE });

    const result = await resolvePending(input({ scripts: {} }), deps);
    expect(result.components.cart).toMatchObject({ status: 'not-found' });
    expect(result.components.cart.detail).toMatch(/nothing to search/);
    expect(fetched).toEqual([]);
  });

  it('fetches a shared bundle once, however many components want it', async () => {
    const { deps, fetched } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP });

    await resolvePending(
      input({
        components: { a: pending('Cart'), b: pending('Price'), c: pending('Row') },
        needles: { a: needle(), b: needle(), c: needle() },
      }),
      deps,
    );

    expect(fetched.filter((url) => url === BUNDLE_URL)).toHaveLength(1);
  });

  it('leaves everything pending when the budget is already spent', async () => {
    const { deps, fetched } = harness({ [BUNDLE_URL]: BUNDLE });
    const spent: ResolveDeps = { ...deps, now: exhaustedClock() };

    const result = await resolvePending(input(), spent);
    expect(fetched).toEqual([]);
    expect(result.components.cart.status).toBe('pending');
    // Still queued, so the next trigger picks it up exactly here.
    expect(result.needles.cart).toBeDefined();
  });

  it('stops saying "pending" once there is no next trigger', async () => {
    const { deps } = harness({});
    const spent: ResolveDeps = { ...deps, now: exhaustedClock() };

    const result = await resolvePending(input({ final: true }), spent);
    expect(result.components.cart).toEqual({
      name: 'Cart',
      status: 'skipped',
      detail: 'The flow finished before this component could be looked up.',
    });
    expect(result.needles).toEqual({});
  });

  it('fetches nothing at all when resolution is switched off', async () => {
    const { deps, fetched } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP });

    const result = await resolvePending(input({ disabled: true }), deps);

    expect(fetched).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.components.cart.status).toBe('pending');
    // The needle survives, so switching the setting back on mid-recording still
    // gets this component its path.
    expect(result.needles.cart).toBeDefined();
  });

  it('says why, rather than "skipped", when the setting is what stopped it', async () => {
    const { deps } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP });

    const result = await resolvePending(input({ disabled: true, final: true }), deps);

    expect(result.components.cart).toEqual({
      name: 'Cart',
      status: 'skipped',
      detail: 'Finding source files is switched off in FlowSnap settings.',
    });
    expect(result.needles).toEqual({});
  });

  it('leaves an already-answered component alone', async () => {
    const { deps, fetched } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP });
    // `pos1` rather than a bare 12: this stands in for a `ComponentSource` read
    // back out of storage, which `docs/CONTRACTS.md` §1 names as one of the
    // three places the assertion is legitimate. It adds no arithmetic — it
    // states what the stored number already was.
    const answered: ComponentSource = {
      name: 'Cart',
      status: 'resolved',
      via: 'debug-source',
      source: 'src/Cart.tsx',
      line: pos1(12),
    };

    const result = await resolvePending(
      input({ components: { cart: answered }, needles: { cart: needle() } }),
      deps,
    );

    expect(result.components.cart).toBe(answered);
    expect(result.changed).toBe(false);
    expect(fetched).toEqual([]);
  });

  it('touches nothing but the component table and the needles', async () => {
    // The resolver runs while the capture queue rewrites `recordedSteps`
    // wholesale. Anything it returned beyond these two keys would be a second
    // writer on somebody else's data.
    const { deps } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP });
    const result = await resolvePending(input(), deps);

    expect(Object.keys(result).sort()).toEqual(['changed', 'components', 'needles']);
  });
});
