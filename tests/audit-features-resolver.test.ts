/**
 * Two ways a resolve pass answered wrongly about a source map.
 *
 * Both are invisible from the outside — one costs a flow its component table
 * and reports the loss as `skipped`, the other names a file with
 * `status: 'resolved'` and no caveat — which is why they are worth a test each
 * rather than a look at a screen.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildNeedle } from '../src/core/locate/needle.js';
import type { BundleProvider } from '../src/core/locate/provider.js';
import { clearResolverCaches, resolvePending } from '../src/features/react/resolver.js';
import type { ComponentNeedle } from '../src/shared/types.js';
import { sourceMapJson } from './helpers/sourcemap-fixture.js';

const PAGE = 'https://shop.test/products/42';
const BUNDLE_URL = 'https://shop.test/assets/app.js';
const MAP_URL = 'https://shop.test/assets/app.js.map';

/** A provider over a fixed web that counts what it was asked for. */
function providerOver(files: Record<string, string>): {
  provider: BundleProvider;
  reads: string[];
} {
  const reads: string[] = [];
  const read = (url: string): Promise<string | null> => {
    reads.push(url);
    return Promise.resolve(files[url] ?? null);
  };

  return {
    reads,
    provider: {
      listScripts: () => Promise.resolve([BUNDLE_URL]),
      loadScript: read,
      loadUrl: read,
    },
  };
}

beforeEach(() => {
  clearResolverCaches();
});

// ── A map that will not parse ───────────────────────────────────────────────

describe('a bundle whose source map is unparseable', () => {
  const A = 'function Alpha(){return 1}';
  const B = 'function Beta(){return 2}';
  const BUNDLE = `${A}\n${B}\n//# sourceMappingURL=app.js.map`;

  /**
   * The map cache's own header says a map that will not parse must not be
   * re-parsed, and nothing wrote a parse failure down: `parseSourceMap` threw
   * and the cache stayed empty, so every component sharing the bundle decoded
   * the same `mappings` again to reach the same verdict. `react.maxMapBytes`
   * allows 64 MB of one and a pass has a deadline, so what that actually cost
   * was the components after the deadline — left `pending`, and reported to the
   * reader as `skipped`.
   */
  it('reads and parses it once for the whole bundle, not once per component', async () => {
    const { provider, reads } = providerOver({
      [BUNDLE_URL]: BUNDLE,
      // Truncated by whatever wrote it — `parseSourceMap` refuses it outright.
      [MAP_URL]: '{"version":3,"sources":["a.ts"],"mappings":"AAAA',
    });

    const out = await resolvePending(
      {
        components: {
          alpha: { name: 'Alpha', status: 'pending' },
          beta: { name: 'Beta', status: 'pending' },
        },
        needles: {
          alpha: { head: A, pageUrl: PAGE },
          beta: { head: B, pageUrl: PAGE },
        },
        scripts: { 'https://shop.test': [BUNDLE_URL] },
        final: false,
        limits: { concurrency: 1, cacheEntries: 8, cacheBytes: 1e7, resourceBytes: 1e7, mapBytes: 1e7 },
      },
      { provider, now: () => 0 },
    );

    // Both still learn the same thing, and both say so.
    expect(out.components.alpha.status).toBe('map-error');
    expect(out.components.beta.status).toBe('map-error');
    expect(out.components.beta.detail).toContain('not valid JSON');

    expect(reads.filter((url) => url === MAP_URL)).toHaveLength(1);
  });
});

// ── The window a function-start lookup is allowed to accept a mapping in ────

describe('a body-needle hit whose only mapping lies past the needle text', () => {
  /** As `fn.toString()` returns it in the page, before the bundler renamed it. */
  const RUNTIME = 'function Cart(props){ return renderCartRow(props); }';

  function needleFor(source: string): ComponentNeedle {
    const built = buildNeedle(source);
    if (!built.ok) throw new Error(`fixture rejected: ${built.reason}`);
    return { ...built.needle, pageUrl: PAGE };
  }

  /**
   * `searchBundle` reports the *function start* it walked back to, which sits
   * `bodyOffset`-ish characters before the text that matched. The span handed to
   * `lookupFunctionStart` was the needle's own length, measured from that
   * earlier position — so the forward scan stopped short by exactly the distance
   * of the walk-back, and a map whose only mapping for the function lay in the
   * part that got cut off fell through to `lookupOriginal`. That is the
   * "segment at or before" lookup, and before the function start is the previous
   * module: the flow named another component's file, `status: 'resolved'`, no
   * caveat — the failure `lookupFunctionStart` exists to remove.
   */
  it('names the component’s own file rather than the previous module’s', async () => {
    const needle = needleFor(RUNTIME);
    expect(needle.body).toBeDefined();

    const previous = 'function a(e){return e+1}';
    const cart = 'function n(props){ return renderCartRow(props); }';
    const code = `${previous}${cart}`;
    const bundle = `${code}\n//# sourceMappingURL=app.js.map`;

    const start = previous.length;
    const bodyAt = cart.indexOf(needle.body!);
    expect(bodyAt).toBeGreaterThan(0);

    /*
     * One mapping for the previous module at column 0, and one for `Cart` at a
     * column that is past `start + body.length` and inside
     * `start + bodyAt + body.length` — which is to say: inside the function's
     * own compiled text, and outside the window the short span allowed.
     */
    const cartColumn = start + needle.body!.length + 1;
    expect(cartColumn).toBeLessThan(start + bodyAt + needle.body!.length);

    const map = sourceMapJson(
      ['webpack://shop/./src/Helper.ts', 'webpack://shop/./src/cart/Cart.tsx'],
      [
        [
          { generatedColumn: 0, sourceIndex: 0, originalLine: 1, originalColumn: 0 },
          { generatedColumn: cartColumn, sourceIndex: 1, originalLine: 33, originalColumn: 2 },
        ],
      ],
    );

    const { provider } = providerOver({ [BUNDLE_URL]: bundle, [MAP_URL]: map });

    const out = await resolvePending(
      {
        components: { cart: { name: 'Cart', status: 'pending' } },
        needles: { cart: needle },
        scripts: { 'https://shop.test': [BUNDLE_URL] },
        final: false,
        limits: { concurrency: 1, cacheEntries: 8, cacheBytes: 1e7, resourceBytes: 1e7, mapBytes: 1e7 },
      },
      { provider, now: () => 0 },
    );

    const resolved = out.components.cart;
    expect(resolved.status).toBe('resolved');
    expect(resolved.source).toBe('src/cart/Cart.tsx');
  });

  /** The head path is unchanged: the position is the needle's own start. */
  it('leaves a head-needle hit measuring exactly the needle', async () => {
    const head = 'function Cart(props){ return 1; }';
    const bundle = `var x=1;${head}\n//# sourceMappingURL=app.js.map`;
    const map = sourceMapJson(
      ['webpack://shop/./src/cart/Cart.tsx'],
      [[{ generatedColumn: 8, sourceIndex: 0, originalLine: 33, originalColumn: 2 }]],
    );

    const { provider } = providerOver({ [BUNDLE_URL]: bundle, [MAP_URL]: map });

    const out = await resolvePending(
      {
        components: { cart: { name: 'Cart', status: 'pending' } },
        needles: { cart: { head, pageUrl: PAGE } },
        scripts: { 'https://shop.test': [BUNDLE_URL] },
        final: false,
        limits: { concurrency: 1, cacheEntries: 8, cacheBytes: 1e7, resourceBytes: 1e7, mapBytes: 1e7 },
      },
      { provider, now: () => 0 },
    );

    expect(out.components.cart.status).toBe('resolved');
    expect(out.components.cart.source).toBe('src/cart/Cart.tsx');
  });
});
