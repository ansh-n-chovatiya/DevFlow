/**
 * One interactive locate, driven with two fakes and no browser.
 *
 * The claim under test is the honesty one. A locate has eight ways to end
 * without a path and only one of them is a bug; the other seven are ordinary
 * facts about a shipped bundle — a lazy chunk that never loaded, a deploy that
 * shipped no maps, a CDN with no CORS headers, a setting somebody turned off.
 * What must never happen is that two of them look the same on screen, because a
 * reader with no way to tell picks the worst reading and concludes the feature
 * is broken.
 *
 * So nearly every case here asserts a `status` *and* the sentence beside it, and
 * the cases are paired deliberately: no annotation versus an annotation that
 * 404s, source maps switched off versus a map that would not parse. Those are
 * different things that would collapse into "no source" the moment anybody
 * simplified this.
 */

import { describe, expect, it, vi } from 'vitest';

import type { BundleProvider } from '../src/core/locate/provider.js';
import { pos1 } from '../src/core/locate/positions.js';
import type { PickedComponent } from '../src/shared/types.js';
import { locateComponent, StalePickError } from '../src/ui/locator/locate.js';
import { sourceMapJson } from './helpers/sourcemap-fixture.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** What `fn.toString()` hands back for the component that was picked. */
const FN = 'function CartSummary(props){return h("div",{className:"cart"},props.total)}';

/** The compiled chunk it was found in. `FN` sits on generated line 1, column 0. */
const BUNDLE = `!function(){var a=1;\n${FN}\n}();\n//# sourceMappingURL=main.js.map\n`;

/** The same chunk with no map announced at all — a build that ships none. */
const UNMAPPED = `!function(){var a=1;\n${FN}\n}();\n`;

const ORIGINAL = [
  'import { h } from "preact";',
  '',
  ...Array.from({ length: 39 }, (_, i) => `// filler ${i}`),
  'export function CartSummary(props) {',
  '  return <div className="cart">{props.total}</div>;',
  '}',
].join('\n');

/** Maps generated line 1, column 0 to `CartSummary.tsx` line 41, column 6 (0-based). */
function mapJson(source = 'src/checkout/CartSummary.tsx', withContent = true): string {
  return sourceMapJson(
    [source],
    [[], [{ generatedColumn: 0, sourceIndex: 0, originalLine: 41, originalColumn: 6 }]],
    withContent ? { sourcesContent: [ORIGINAL] } : {},
  );
}

interface Fake extends BundleProvider {
  scriptReads: string[];
  urlReads: string[];
}

function fakeProvider(
  scripts: [url: string, text: string | null][],
  urls: Record<string, string | null> = {},
): Fake {
  const scriptReads: string[] = [];
  const urlReads: string[] = [];

  return {
    scriptReads,
    urlReads,
    listScripts: () => Promise.resolve(scripts.map(([url]) => url)),
    loadScript: (url) => {
      scriptReads.push(url);
      return Promise.resolve(scripts.find(([known]) => known === url)?.[1] ?? null);
    },
    loadUrl: (url) => {
      urlReads.push(url);
      return Promise.resolve(urls[url] ?? null);
    },
  };
}

const PICKED: PickedComponent = { name: 'CartSummary' };

function run(
  provider: Fake,
  over: {
    component?: PickedComponent;
    fnSource?: string | null;
    useSourceMaps?: boolean;
    concurrency?: number;
    onStage?: (stage: 'match' | 'source', state: 'done' | 'active' | 'pending') => void;
  } = {},
) {
  return locateComponent(
    {
      component: over.component ?? PICKED,
      pageUrl: 'https://shop.test/checkout',
      useSourceMaps: over.useSourceMaps ?? true,
      concurrency: over.concurrency ?? 4,
    },
    {
      provider,
      readSource: () => Promise.resolve(over.fnSource === undefined ? FN : over.fnSource),
      onStage: over.onStage,
    },
  );
}

const MAIN = 'https://shop.test/main.js';
const MAP = 'https://shop.test/main.js.map';
const VENDOR = 'https://shop.test/vendor.js';

// ── The happy path ───────────────────────────────────────────────────────────

describe('a component that resolves', () => {
  it('answers with the file somebody wrote, 1-based, and the bundle position 0-based', async () => {
    const outcome = await run(fakeProvider([[MAIN, BUNDLE]], { [MAP]: mapJson() }));

    expect(outcome.source).toMatchObject({
      name: 'CartSummary',
      status: 'resolved',
      via: 'bundle-search',
      source: 'src/checkout/CartSummary.tsx',
      // The map says 41:6 and a person reads 42:7 — the one bridge, once.
      line: 42,
      column: 7,
    });
    // The compiled pair deliberately does *not* cross: DevTools' Sources API is
    // 0-based, and this is what `Open in Sources` is handed unchanged.
    expect(outcome.source.compiled).toEqual({ url: MAIN, line: 1, column: 0 });
    expect(outcome.resourcesSearched).toBe(1);
  });

  it('carries the preview, which is why this path parses the map its own way (D3)', async () => {
    const outcome = await run(fakeProvider([[MAIN, BUNDLE]], { [MAP]: mapJson() }));

    expect(outcome.preview?.line).toBe(41);
    expect(outcome.preview?.content).toContain('export function CartSummary');
  });

  it('has no preview when the map inlined no source, which is not a failure', async () => {
    const outcome = await run(fakeProvider([[MAIN, BUNDLE]], { [MAP]: mapJson(undefined, false) }));

    expect(outcome.source.status).toBe('resolved');
    expect(outcome.preview).toBeNull();
  });

  it('marks a component that resolved into node_modules', async () => {
    const outcome = await run(
      fakeProvider([[MAIN, BUNDLE]], { [MAP]: mapJson('node_modules/@ui/kit/Button.tsx') }),
    );

    expect(outcome.source.dependency).toBe(true);
  });
});

// ── The build already knew ───────────────────────────────────────────────────

describe('a build stamp', () => {
  const withStamp: PickedComponent = {
    name: 'CartSummary',
    stamp: { source: 'src/checkout/CartSummary.tsx', line: pos1(12) },
  };

  it('is preferred outright, and neither the page nor a bundle is read', async () => {
    const provider = fakeProvider([[MAIN, BUNDLE]], { [MAP]: mapJson() });
    const readSource = vi.fn(() => Promise.resolve(FN));

    const outcome = await locateComponent(
      {
        component: withStamp,
        pageUrl: 'https://shop.test/checkout',
        useSourceMaps: true,
        concurrency: 4,
      },
      { provider, readSource },
    );

    expect(outcome.source).toEqual({
      name: 'CartSummary',
      status: 'resolved',
      via: 'plugin',
      source: 'src/checkout/CartSummary.tsx',
      line: 12,
    });
    expect(provider.scriptReads).toEqual([]);
    // Nothing to search for, so the page is never asked for the function body.
    expect(readSource).not.toHaveBeenCalled();
    expect(outcome.resourcesSearched).toBe(0);
  });

  /*
   * The precedence that has to match `core/react/table.ts`, and the reason it
   * does: a stamp is where the component was *defined* and `_debugSource` is
   * where its JSX was *written*, a position in the parent's file. The panel and
   * a recorded flow naming different files for one component is a contradiction
   * its reader cannot resolve.
   */
  it('beats the JSX position React recorded, which is a position in the parent', async () => {
    const outcome = await run(fakeProvider([[MAIN, BUNDLE]], { [MAP]: mapJson() }), {
      component: {
        name: 'CartSummary',
        stamp: { source: 'src/checkout/CartSummary.tsx', line: pos1(12) },
        debugSource: { source: 'src/checkout/Page.tsx', line: pos1(88), column: pos1(4) },
      },
    });

    expect(outcome.source.via).toBe('plugin');
    expect(outcome.source.source).toBe('src/checkout/CartSummary.tsx');
    expect(outcome.source.line).toBe(12);
  });

  it('marks a stamped node_modules path as a dependency, as every other path is', async () => {
    const outcome = await run(fakeProvider([]), {
      component: {
        name: 'Button',
        stamp: { source: 'node_modules/@ui/kit/Button.tsx', line: pos1(3) },
      },
    });

    expect(outcome.source.dependency).toBe(true);
  });

  it('still answers after the page has navigated out from under the pick', async () => {
    const outcome = await run(fakeProvider([]), { component: withStamp, fnSource: null });
    expect(outcome.source.via).toBe('plugin');
  });
});

// ── React already knew ───────────────────────────────────────────────────────

describe('_debugSource', () => {
  const withDebug: PickedComponent = {
    name: 'CartSummary',
    debugSource: { source: 'src/checkout/CartSummary.tsx', line: pos1(42), column: pos1(7) },
  };

  it('is preferred outright, and no bundle is read at all', async () => {
    const provider = fakeProvider([[MAIN, BUNDLE]], { [MAP]: mapJson() });
    const outcome = await run(provider, { component: withDebug });

    expect(outcome.source).toMatchObject({
      status: 'resolved',
      via: 'debug-source',
      source: 'src/checkout/CartSummary.tsx',
      line: 42,
    });
    // The search is skipped rather than done and discarded.
    expect(provider.scriptReads).toEqual([]);
    expect(outcome.resourcesSearched).toBe(0);
  });

  it('still answers after the page has navigated out from under the pick', async () => {
    // The function is gone, but where it was written is not a fact about the
    // document that is currently loaded.
    const outcome = await run(fakeProvider([]), { component: withDebug, fnSource: null });
    expect(outcome.source.via).toBe('debug-source');
  });
});

// ── The pick itself is gone ──────────────────────────────────────────────────

describe('a stale pick', () => {
  it('throws, because there is nothing to report a status about', async () => {
    await expect(run(fakeProvider([[MAIN, BUNDLE]]), { fnSource: null })).rejects.toBeInstanceOf(
      StalePickError,
    );
  });
});

// ── Everything that is an answer rather than a failure ───────────────────────

describe('a component with no path, and the sentence that says why', () => {
  it('does not search for a native or bound function', async () => {
    const provider = fakeProvider([[MAIN, BUNDLE]]);
    const outcome = await run(provider, { fnSource: 'function bind() { [native code] }' });

    expect(outcome.source.status).toBe('not-found');
    expect(outcome.source.detail).toContain('native or bound function');
    // A full pass to report "not found" would read as a bug in the search.
    expect(provider.scriptReads).toEqual([]);
  });

  it('refuses a source too short to match anything but noise', async () => {
    const outcome = await run(fakeProvider([[MAIN, BUNDLE]]), { fnSource: 'a=>a' });

    expect(outcome.source.status).toBe('not-found');
    expect(outcome.source.detail).toContain('too short');
  });

  it('separates a page with no bundles from bundles that would not load', async () => {
    const none = await run(fakeProvider([]));
    expect(none.source.status).toBe('not-found');
    expect(none.source.detail).toContain('nothing to search');

    const unreadable = await run(fakeProvider([[MAIN, null]]));
    expect(unreadable.source.status).toBe('unfetchable');
    expect(unreadable.source.detail).toContain('None of the page');
  });

  it('counts what it actually looked at when the needle is simply not there', async () => {
    const outcome = await run(
      fakeProvider([
        [MAIN, 'var nothing = 1;'],
        [VENDOR, 'var alsoNothing = 2;'],
      ]),
    );

    expect(outcome.source.status).toBe('not-found');
    expect(outcome.source.detail).toContain('the 2 scripts');
    expect(outcome.resourcesSearched).toBe(2);
  });

  it('stops at the bundle when source maps are switched off, and says so', async () => {
    const provider = fakeProvider([[MAIN, BUNDLE]], { [MAP]: mapJson() });
    const outcome = await run(provider, { useSourceMaps: false });

    expect(outcome.source.status).toBe('compiled-only');
    expect(outcome.source.detail).toContain('switched off');
    expect(outcome.source.compiled).toEqual({ url: MAIN, line: 1, column: 0 });
    // The setting is about not paying for the lookup, so it is not paid for.
    expect(provider.urlReads).toEqual([]);
    expect(outcome.preview).toBeNull();
  });

  it('tells a build with no maps apart from a build whose map went missing', async () => {
    const none = await run(fakeProvider([[MAIN, UNMAPPED]]));
    expect(none.source.status).toBe('compiled-only');
    expect(none.source.detail).toContain('ships no source map');

    // Announced and then unavailable: built with maps, deployed without them.
    const missing = await run(fakeProvider([[MAIN, BUNDLE]], {}));
    expect(missing.source.status).toBe('map-error');
    expect(missing.source.detail).toContain('missing or private');
  });

  it('reports a map that will not parse as a map problem, not a missing file', async () => {
    const outcome = await run(fakeProvider([[MAIN, BUNDLE]], { [MAP]: '{ not json' }));

    expect(outcome.source.status).toBe('map-error');
    expect(outcome.source.compiled).toEqual({ url: MAIN, line: 1, column: 0 });
  });

  it('says when a map covers the bundle but not this position', async () => {
    const elsewhere = sourceMapJson(
      ['src/other.tsx'],
      [[{ generatedColumn: 0, sourceIndex: 0, originalLine: 0, originalColumn: 0 }]],
    );
    const outcome = await run(fakeProvider([[MAIN, BUNDLE]], { [MAP]: elsewhere }));

    expect(outcome.source.status).toBe('map-error');
    expect(outcome.source.detail).toContain('no mapping covering that position');
  });
});

// ── Ambiguity ────────────────────────────────────────────────────────────────

describe('code that was inlined more than once', () => {
  it('keeps looking after the first hit, and downgrades the answer when it finds another', async () => {
    /*
     * The confident wrong answer this whole feature exists to remove: a
     * component compiled into two chunks has two equally true positions, and
     * reporting the first as fact is indistinguishable from reporting the right
     * one.
     */
    const provider = fakeProvider([[MAIN, BUNDLE], [VENDOR, BUNDLE]], { [MAP]: mapJson() });
    const outcome = await run(provider);

    expect(outcome.source.status).toBe('ambiguous');
    expect(outcome.source.matchCount).toBe(2);
    expect(outcome.source.detail).toContain('this is the first');
    // The first hit in load order is still the one reported.
    expect(outcome.source.compiled?.url).toBe(MAIN);
    expect(provider.scriptReads).toEqual([MAIN, VENDOR]);
  });

  it('appends the caveat to an answer that never reached an original file either', async () => {
    const outcome = await run(fakeProvider([[MAIN, UNMAPPED], [VENDOR, UNMAPPED]]));

    expect(outcome.source.status).toBe('compiled-only');
    expect(outcome.source.matchCount).toBe(2);
    expect(outcome.source.detail).toContain('appears in 2 places');
  });
});

// ── Reading the bundles ──────────────────────────────────────────────────────

describe('bundle reads', () => {
  it('preserves load order across batches, so the first chunk still wins', async () => {
    // One at a time and four at a time must agree about which position is the
    // answer, or the result would depend on a concurrency setting.
    for (const concurrency of [1, 2, 8]) {
      const provider = fakeProvider(
        [
          [VENDOR, 'var nothing = 1;'],
          [MAIN, BUNDLE],
        ],
        { [MAP]: mapJson() },
      );
      const outcome = await run(provider, { concurrency });

      expect(outcome.source.compiled?.url, `concurrency ${concurrency}`).toBe(MAIN);
      expect(provider.scriptReads).toEqual([VENDOR, MAIN]);
    }
  });

  it('survives a concurrency of zero rather than looping forever', async () => {
    const outcome = await run(fakeProvider([[MAIN, BUNDLE]], { [MAP]: mapJson() }), {
      concurrency: 0,
    });
    expect(outcome.source.status).toBe('resolved');
  });
});

// ── The checklist ────────────────────────────────────────────────────────────

describe('stage reporting', () => {
  it('reports only the stages that actually ran', async () => {
    const onStage = vi.fn();
    await run(fakeProvider([[MAIN, BUNDLE]], { [MAP]: mapJson() }), { onStage });

    expect(onStage.mock.calls).toEqual([
      ['match', 'active'],
      ['match', 'done'],
      ['source', 'active'],
      ['source', 'done'],
    ]);
  });

  it('leaves the source stage untouched when there was nothing to look up', async () => {
    const onStage = vi.fn();
    await run(fakeProvider([[MAIN, 'var nothing = 1;']]), { onStage });

    // A row still reading `pending` is the honest report: that stage never ran.
    expect(onStage.mock.calls).toEqual([
      ['match', 'active'],
      ['match', 'done'],
    ]);
  });
});
