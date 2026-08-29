/**
 * What the resolver may claim when the clock beat it.
 *
 * A pass stops at a deadline, which is right — a pathological site has to cost a
 * fixed amount and then stop. What was wrong is what the stop was reported as.
 * The bundle loop simply `break`s, and both of the states that leaves were being
 * published as finished work:
 *
 *   - Nothing found yet became `not-found`, with the sentence "not found in the
 *     N scripts the page had loaded" written after reading one of them, and a
 *     `searched` count of every script — which told `selectPending` it had
 *     already looked everywhere, so no later pass ever retried it. One slow
 *     minute made a component permanently unresolvable and explained it with a
 *     lazy chunk that had nothing to do with it.
 *   - Something found became `resolved`, because the sweep for duplicates that
 *     would have made it `ambiguous` was the part that got cut. Duplicated
 *     vendored modules make a second copy ordinary, so this is not a rare shape.
 *
 * Both are the failure this feature exists to avoid: not a missing answer, a
 * confident wrong one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildNeedle } from '../src/core/react/needle.js';
import { clearResolverCaches, resolvePending, type ResolveDeps } from '../src/features/react/resolver.js';
import type { ComponentNeedle, ComponentSource } from '../src/shared/types.js';
import { sourceMapJson } from './helpers/sourcemap-fixture.js';

const PAGE = 'https://shop.test/products/42';
const ORIGIN = 'https://shop.test';
const A = 'https://shop.test/assets/a.js';
const B = 'https://shop.test/assets/b.js';
const C = 'https://shop.test/assets/c.js';

const CART_SOURCE = 'function Cart(props){ return renderCartRow(props); }';

/** Line 1 of a bundle maps to Cart.tsx line 41, column 1 — the fixture is 0-based. */
const MAP = sourceMapJson(
  ['webpack://shop/./src/cart/Cart.tsx'],
  [[], [{ generatedColumn: 0, sourceIndex: 0, originalLine: 40, originalColumn: 0 }]],
);

/** A bundle with the component on line 1 and a map beside it. */
function bundleWith(fnSource: string, mapName: string): string {
  return `var pad=1;\n${fnSource}\n//# sourceMappingURL=${mapName}`;
}

function harness(files: Record<string, string>, now: () => number) {
  const fetched: string[] = [];
  const deps: ResolveDeps = {
    fetchText: (url) => {
      fetched.push(url);
      const text = files[url];
      return Promise.resolve(
        text === undefined ? { ok: false as const } : { ok: true as const, value: text },
      );
    },
    now,
  };
  return { deps, fetched };
}

/**
 * A clock that reads from a script and then holds its last value.
 *
 * The deadline is computed from the first reading, so a fixed clock can never
 * cross it and a monotonic one crosses it before anything is fetched. Both of
 * those are already covered; what needs a script is the middle — a budget that
 * runs out *part way through* the bundle list, which is where a wrong answer
 * gets published instead of no answer.
 */
function scriptedClock(times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

/** Reads: the deadline, the worker's check, then one per bundle. */
const AFTER_FIRST_BUNDLE = [0, 0, 0, 60_000];

/** Built the way the page builds it, so the body needle is the real one. */
function needle(overrides: Partial<ComponentNeedle> = {}): ComponentNeedle {
  const built = buildNeedle(CART_SOURCE);
  if (!built.ok) throw new Error(`fixture rejected: ${built.reason}`);
  return { ...built.needle, pageUrl: PAGE, ...overrides };
}

function input(overrides: Partial<Parameters<typeof resolvePending>[0]> = {}) {
  return {
    components: { cart: { name: 'Cart', status: 'pending' } as ComponentSource },
    needles: { cart: needle() },
    scripts: { [ORIGIN]: [A, B, C] },
    final: false,
    ...overrides,
  };
}

beforeEach(() => clearResolverCaches());

describe('a pass that runs out of budget before it finds anything', () => {
  it('leaves the component queued instead of declaring it missing', async () => {
    // The code is in the third chunk; the clock stops the pass after the first.
    const { deps, fetched } = harness(
      { [A]: 'var x=1;\n', [B]: 'var y=2;\n', [C]: bundleWith(CART_SOURCE, 'c.js.map') },
      scriptedClock(AFTER_FIRST_BUNDLE),
    );

    const result = await resolvePending(input(), deps);

    expect(fetched).toEqual([A]);
    expect(result.components.cart.status).toBe('pending');
    // No sentence, because nothing was concluded. "Not found in the 3 scripts
    // the page had loaded" was a claim about two bundles this pass never read.
    expect(result.components.cart.detail).toBeUndefined();
    expect(result.changed).toBe(false);
    expect(result.needles.cart).toBeDefined();
  });

  it('resumes on the next pass, which is what the old answer prevented forever', async () => {
    const files = { [A]: 'var x=1;\n', [B]: 'var y=2;\n', [C]: bundleWith(CART_SOURCE, 'c.js.map'), 'https://shop.test/assets/c.js.map': MAP };
    const cut = harness(files, scriptedClock(AFTER_FIRST_BUNDLE));

    const first = await resolvePending(input(), cut.deps);

    // `searched` is what `selectPending` compares the inventory against. Left at
    // 3 — every script — the component was never looked at again however much
    // budget a later pass had.
    expect(first.needles.cart?.searched ?? 0).toBeLessThan(3);

    const unlimited = harness(files, () => 0);
    const second = await resolvePending(
      input({ components: first.components, needles: first.needles }),
      unlimited.deps,
    );

    expect(second.components.cart).toMatchObject({
      status: 'resolved',
      source: 'src/cart/Cart.tsx',
      line: 41,
    });
  });
});

describe('a pass that runs out of budget after it finds something', () => {
  it('does not call a match unique when the search for duplicates was cut short', async () => {
    const { deps } = harness(
      {
        [A]: bundleWith(CART_SOURCE, 'a.js.map'),
        'https://shop.test/assets/a.js.map': MAP,
        // The same component, inlined into a second chunk. Never read.
        [B]: bundleWith(CART_SOURCE, 'b.js.map'),
      },
      scriptedClock(AFTER_FIRST_BUNDLE),
    );

    const result = await resolvePending(input({ scripts: { [ORIGIN]: [A, B] } }), deps);

    expect(result.components.cart).toMatchObject({
      status: 'ambiguous',
      source: 'src/cart/Cart.tsx',
    });
    expect(result.components.cart.detail).toMatch(/time budget/);
  });

  it('still says "resolved" when the sweep actually finished', async () => {
    // The guard has to cost nothing in the ordinary case, or every step in every
    // flow acquires a caveat and the caveats stop meaning anything.
    const { deps } = harness(
      {
        [A]: bundleWith(CART_SOURCE, 'a.js.map'),
        'https://shop.test/assets/a.js.map': MAP,
        [B]: 'var y=2;\n',
      },
      () => 0,
    );

    const result = await resolvePending(input({ scripts: { [ORIGIN]: [A, B] } }), deps);

    expect(result.components.cart.status).toBe('resolved');
    expect(result.components.cart.detail).toBeUndefined();
  });
});

describe('counting duplicates across bundles', () => {
  it('counts the needle that actually hit, not the head that did not', async () => {
    // Two chunks hold the same component under two minified names. The head
    // matches neither, so the body needle is what found it — and the recount in
    // every later bundle used the head regardless, found nothing, and reported
    // one of two equally likely paths as the answer.
    const { deps } = harness(
      {
        [A]: bundleWith('function n(props){ return renderCartRow(props); }', 'a.js.map'),
        'https://shop.test/assets/a.js.map': MAP,
        [B]: bundleWith('function q(props){ return renderCartRow(props); }', 'b.js.map'),
      },
      () => 0,
    );

    const result = await resolvePending(input({ scripts: { [ORIGIN]: [A, B] } }), deps);

    expect(result.components.cart).toMatchObject({ status: 'ambiguous', matchCount: 2 });
    expect(result.components.cart.detail).toMatch(/may be the wrong one/);
  });
});


/**
 * The budget is a setting, and the number it uses is the one it was given.
 *
 * `react.maxResolveMsPerFlow` was tabled in Phase 0 and named by no phase in
 * the list at all; Phase 4 took it. The wiring is one number reaching one
 * addition, and the way it fails is that it does not — the deadline is computed
 * from the compiled-in 30 seconds, every test above still passes because they
 * drive the clock rather than the budget, and the setting does nothing while
 * looking exactly like it works.
 */
describe('the time budget comes from the setting', () => {
  const files = {
    [A]: 'var x=1;\n',
    [B]: 'var y=2;\n',
    [C]: bundleWith(CART_SOURCE, 'c.js.map'),
    'https://shop.test/assets/c.js.map': MAP,
  };

  /** The clock reads 0, then 10s from the second reading onwards. */
  const TEN_SECONDS_IN = [0, 10_000];

  it('stops a pass that has exceeded the configured budget', async () => {
    const { deps, fetched } = harness(files, scriptedClock(TEN_SECONDS_IN));

    const result = await resolvePending(input({ budgetMs: 5_000 }), deps);

    // Ten seconds against a five-second budget: nothing is read at all.
    expect(fetched).toEqual([]);
    expect(result.components.cart.status).toBe('pending');
  });

  it('lets the same pass finish under a budget that allows it', async () => {
    const { deps } = harness(files, scriptedClock(TEN_SECONDS_IN));

    const result = await resolvePending(input({ budgetMs: 60_000 }), deps);

    // Same clock, same bundles, different setting — so the setting is the only
    // thing that can have decided this.
    expect(result.components.cart.status).toBe('resolved');
  });

  it('falls back to the shipped default when nothing passes one', async () => {
    // The default is 30s, which this clock is inside. A caller outside the
    // mechanism — which is a thing only a test can be — still gets a budget.
    const { deps } = harness(files, scriptedClock(TEN_SECONDS_IN));

    const result = await resolvePending(input(), deps);

    expect(result.components.cart.status).toBe('resolved');
  });
});
