/**
 * Looking up the position a bundle search returns, which is a function's start.
 *
 * `lookupOriginal` answers the question a source map is *specified* to answer:
 * which mapping covers this position. That takes the segment at or before it,
 * and it is right for a position inside code.
 *
 * It is wrong for the position a bundle search hands back. That is the first
 * character of a function, and a minifier need not emit a mapping there — so
 * the covering segment is whatever was emitted *before* the function, which on
 * a bundled application is a different function in a different file.
 *
 * The numbers below are the ones a real Vue 3 production build produced,
 * measured by driving the built extension against a running application. On
 * generated line 16 the map's segments ran:
 *
 *     6298–6488  CheckoutButton.vue
 *     6489–6603  CartPanel.vue
 *     6604–6684  App.vue
 *
 * and the three components' compiled render functions started at 6318, 6481 and
 * 6591. Two of those three fall *before* their own file's first segment — by 8
 * and 13 characters — because Vue compiles a render to an arrow whose first
 * mapping is on its body. Every component in the chain therefore resolved to
 * its child's `.vue` file, with a plausible line and a `resolved` status.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  lookupFunctionStart,
  lookupOriginal,
  parseSourceMap,
} from '../src/core/locate/sourcemap.js';
import { sourceMapJson, type FixtureSegment } from './helpers/sourcemap-fixture.js';
import { bundleBudget, createWorkerProvider } from '../src/features/react/providers/worker.js';
import { clearResolverCaches, resolvePending } from '../src/features/react/resolver.js';
import { resolve as resolveSettings } from '../src/features/settings/resolve.js';
import { flowError } from '../src/shared/errors.js';

const SOURCES = ['src/components/CheckoutButton.vue', 'src/components/CartPanel.vue', 'src/App.vue'];

/** The three regions, at the columns the real build put them at. */
const LINE: FixtureSegment[] = [
  { generatedColumn: 6298, sourceIndex: 0, originalLine: 1, originalColumn: 20 },
  { generatedColumn: 6331, sourceIndex: 0, originalLine: 5, originalColumn: 2 },
  { generatedColumn: 6489, sourceIndex: 1, originalLine: 4, originalColumn: 2 },
  { generatedColumn: 6604, sourceIndex: 2, originalLine: 4, originalColumn: 2 },
];

const map = parseSourceMap(sourceMapJson(SOURCES, [LINE]));

/** Length of the compiled text that matched — what bounds the forward scan. */
const NEEDLE = 60;

describe('a function start that the map does not mark', () => {
  /*
   * The defect, kept as an assertion so the difference between the two lookups
   * is visible rather than asserted about in a comment. `lookupOriginal` is not
   * wrong here — it is answering the question it was asked.
   */
  it('is covered, per the spec, by the previous file’s segment', () => {
    const found = lookupOriginal(map, 0, 6481);
    expect(found?.source).toBe('src/components/CheckoutButton.vue');
  });

  it('resolves forward to the file the function actually belongs to', () => {
    const found = lookupFunctionStart(map, 0, 6481, NEEDLE);
    expect(found?.source).toBe('src/components/CartPanel.vue');
    expect(found?.line).toBe(4);
  });

  it('does the same for the outermost component, 13 columns short', () => {
    expect(lookupFunctionStart(map, 0, 6591, NEEDLE)?.source).toBe('src/App.vue');
  });

  /*
   * The innermost component was never wrong: its match landed inside its own
   * region. The forward scan must not move an answer that was already right.
   */
  it('leaves an answer alone when the match is already inside its own region', () => {
    expect(lookupFunctionStart(map, 0, 6318, NEEDLE)?.source).toBe(
      'src/components/CheckoutButton.vue',
    );
  });
});

describe('the bound on the scan', () => {
  /*
   * `span` is the length of the matched text, so a segment past the function's
   * own compiled source is never accepted. Without it this would be a rule that
   * says "use whatever mapping comes next", which on a function the map is
   * silent about would name a completely unrelated file with total confidence.
   */
  it('refuses a segment beyond the matched text and falls back', () => {
    // 6489 is 8 columns away; a span of 4 cannot reach it.
    const near = lookupFunctionStart(map, 0, 6481, 4);
    expect(near?.source).toBe('src/components/CheckoutButton.vue');
  });

  it('accepts a segment exactly at the end of the span', () => {
    expect(lookupFunctionStart(map, 0, 6481, 9)?.source).toBe('src/components/CartPanel.vue');
  });

  /*
   * Where the map emits a mapping at the function start — which is most
   * `function name(){}` output, and is why React never met this — the first
   * segment at or after the column is that same segment, so both lookups agree.
   */
  it('agrees with lookupOriginal when the start is mapped', () => {
    expect(lookupFunctionStart(map, 0, 6489, NEEDLE)?.source).toBe(
      lookupOriginal(map, 0, 6489)?.source,
    );
  });

  it('falls back rather than inventing when the line has nothing at all', () => {
    expect(lookupFunctionStart(map, 5, 10, NEEDLE)).toBeNull();
  });
});

/*
 * The same defect one layer up, because the lookup being right is not the same
 * as the resolver calling it.
 *
 * Two adjacent arrow functions on one generated line, and a map whose second
 * mapping begins at the second arrow's *body* rather than at its start — the
 * shape a Vue SFC render compiles to. Swapping this call back to
 * `lookupOriginal` turns this test red, which is the whole reason it exists:
 * the sourcemap tests above pass either way.
 */
const FIRST = '(a,b)=>alpha(a,b)';
const SECOND = '(t,s)=>beta(t,s,"cart-panel-marker")';
const GENERATED = `${FIRST},${SECOND}`;
const SECOND_START = GENERATED.indexOf(SECOND);
const SECOND_BODY = GENERATED.indexOf('beta');

const PAGE = 'https://shop.test/';
const BUNDLE_URL = 'https://shop.test/app.js';
const MAP_URL = 'https://shop.test/app.js.map';

describe('the resolver, on a function whose start the map does not mark', () => {
  beforeEach(() => clearResolverCaches());

  it('names the file the function belongs to, not the one emitted before it', async () => {
    const budget = bundleBudget(resolveSettings({}));
    const files: Record<string, string> = {
      [BUNDLE_URL]: `${GENERATED}\n//# sourceMappingURL=app.js.map`,
      [MAP_URL]: sourceMapJson(
        ['src/components/CheckoutButton.vue', 'src/components/CartPanel.vue'],
        [
          [
            { generatedColumn: 0, sourceIndex: 0, originalLine: 4, originalColumn: 2 },
            { generatedColumn: SECOND_BODY, sourceIndex: 1, originalLine: 4, originalColumn: 2 },
          ],
        ],
      ),
    };

    // The arrow's own start is genuinely before its file's first mapping —
    // which is the condition the whole fix is about.
    expect(SECOND_START).toBeLessThan(SECOND_BODY);

    const provider = createWorkerProvider(budget, {
      scripts: {},
      fetchText: (url: string) =>
        Promise.resolve(
          files[url] === undefined
            ? { ok: false as const, error: flowError('RESOURCE_UNFETCHABLE', url) }
            : { ok: true as const, value: files[url] },
        ),
    });

    const result = await resolvePending(
      {
        components: { panel: { name: 'CartPanel', status: 'pending' } },
        needles: { panel: { head: SECOND, pageUrl: PAGE } },
        scripts: { 'https://shop.test': [BUNDLE_URL] },
        final: false,
      },
      { provider, now: () => 0 },
    );

    expect(result.components.panel.status).toBe('resolved');
    expect(result.components.panel.source).toBe('src/components/CartPanel.vue');
  });
});
