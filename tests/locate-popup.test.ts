import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { pos1 } from '../src/core/react/positions.js';
import { bundleBudget, createWorkerProvider } from '../src/features/react/providers/worker.js';
import { clearResolverCaches } from '../src/features/react/resolver.js';
import { resolve as resolveSettings } from '../src/features/settings/resolve.js';
import { flowError } from '../src/shared/errors.js';
import type { Overrides, PickSuccess, PickedComponent, TreeGroup } from '../src/shared/types.js';
import {
  chooseComponent,
  locatePicked,
  locateSettings,
  type LocateDeps,
} from '../src/ui/popup/locate.js';
import { sourceMapJson } from './helpers/sourcemap-fixture.js';

/**
 * The popup's locate path, over a real provider and a fake web.
 *
 * The stub is at `fetchText` and at the two round trips to the tab — never at
 * `BundleProvider` and never at the resolver — so every case below runs through
 * the shipped bundle cache, the shipped size caps and the shipped search. That
 * is the whole claim this package makes: the popup does not resolve differently
 * from the panel or from a recording, it just reaches the bytes another way.
 */

const PAGE = 'https://shop.test/checkout';
const BUNDLE_URL = 'https://shop.test/assets/app.js';
const MAP_URL = 'https://shop.test/assets/app.js.map';
const OTHER_BUNDLE = 'https://shop.test/assets/vendor.js';

const BUTTON_SOURCE = 'function CheckoutButton(props){return props.children}';

/** `var x=1;\n` is 9 characters, so the component starts at line 1, column 0. */
const BUNDLE = `var x=1;\n${BUTTON_SOURCE}\n//# sourceMappingURL=app.js.map`;

/** Generated line 1, column 0 → original line 41, column 2. Both 0-based. */
const MAP = sourceMapJson(
  ['webpack://shop/./src/checkout/CheckoutButton.tsx'],
  [[], [{ generatedColumn: 0, sourceIndex: 0, originalLine: 41, originalColumn: 2 }]],
);

const DEFAULT_SETTINGS = locateSettings(resolveSettings({}));

function settingsWith(overrides: Overrides) {
  return locateSettings(resolveSettings(overrides));
}

function picked(...ancestry: PickedComponent[]): PickSuccess {
  return { kind: 'picked', ancestry, siblings: [] };
}

interface Harness {
  deps: LocateDeps;
  /** Every URL the provider actually went and read. */
  fetched: string[];
  /** Every row of the pick the page was asked for source text about. */
  asked: { group: TreeGroup; index: number }[];
}

function harness(
  files: Record<string, string>,
  options: {
    /** What the tab reports having loaded. */
    scripts?: string[];
    /** What a recording had already filed under this origin, if anything. */
    inventory?: string[];
    /** What the page hands back for a `READ_COMPONENT_SOURCE`. */
    source?: string | null;
  } = {},
): Harness {
  const fetched: string[] = [];
  const asked: { group: TreeGroup; index: number }[] = [];

  const provider = createWorkerProvider(bundleBudget(resolveSettings({})), {
    // Defined and empty is the ordinary state on this path: `reactScripts` is
    // written by a recording, and nothing is recording.
    scripts: options.inventory ? { 'https://shop.test': options.inventory } : {},
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

  return {
    fetched,
    asked,
    deps: {
      readSource: (group, index) => {
        asked.push({ group, index });
        return Promise.resolve(options.source === undefined ? BUTTON_SOURCE : options.source);
      },
      listScripts: () => Promise.resolve(options.scripts ?? [BUNDLE_URL]),
      provider,
      now: () => 0,
    },
  };
}

beforeEach(() => clearResolverCaches());

describe('one interactive locate', () => {
  it('answers with the file the component was written in', async () => {
    const { deps, fetched } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP });

    const result = await locatePicked(picked({ name: 'CheckoutButton' }), PAGE, DEFAULT_SETTINGS, deps);

    expect(result?.component).toBe('CheckoutButton');
    expect(result?.source).toEqual({
      name: 'CheckoutButton',
      status: 'resolved',
      via: 'bundle-search',
      source: 'src/checkout/CheckoutButton.tsx',
      // D1: the map says 0-based `41:2`, and a person reads `42:3`.
      line: 42,
      column: 3,
      compiled: { url: BUNDLE_URL, line: 1, column: 0 },
    });
    // The count the card's ambiguity sentence is sharpened with.
    expect(result?.resourcesSearched).toBe(1);
    expect(fetched).toEqual([BUNDLE_URL, MAP_URL]);
  });

  it('reads the page’s scripts from the tab, not from the recorder’s inventory', async () => {
    // The failure this prevents: `reactScripts` is only written while something
    // is recording, so a locate that trusted it would report "nothing to search"
    // on every page nobody happened to be recording — which is the entire case
    // this surface exists for.
    const { deps, fetched } = harness(
      { [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP },
      { scripts: [BUNDLE_URL], inventory: undefined },
    );

    const result = await locatePicked(picked({ name: 'CheckoutButton' }), PAGE, DEFAULT_SETTINGS, deps);

    expect(result?.source.status).toBe('resolved');
    expect(fetched).toContain(BUNDLE_URL);
  });

  it('still searches what a live recording already knew about', async () => {
    // Evidence is evidence. A chunk the recorder saw load is worth searching
    // even if the tab's own list has moved on.
    const { deps } = harness(
      { [OTHER_BUNDLE]: BUNDLE, [MAP_URL]: MAP },
      { scripts: [], inventory: [OTHER_BUNDLE] },
    );

    const result = await locatePicked(picked({ name: 'CheckoutButton' }), PAGE, DEFAULT_SETTINGS, deps);

    expect(result?.source.status).toBe('resolved');
    expect(result?.resourcesSearched).toBe(1);
  });

  it('drops what could never be a bundle before it is fetched', async () => {
    const { deps, fetched } = harness(
      { [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP },
      {
        scripts: [
          'https://shop.test/logo.png',
          'chrome-extension://abc/agent.js',
          'blob:https://shop.test/9d2',
          BUNDLE_URL,
        ],
      },
    );

    const result = await locatePicked(picked({ name: 'CheckoutButton' }), PAGE, DEFAULT_SETTINGS, deps);

    expect(result?.resourcesSearched).toBe(1);
    expect(fetched).toEqual([BUNDLE_URL, MAP_URL]);
  });

  it('reports what happened when nothing on the page holds the component', async () => {
    const { deps } = harness({ [BUNDLE_URL]: 'var unrelated = 1;\n' });

    const result = await locatePicked(picked({ name: 'CheckoutButton' }), PAGE, DEFAULT_SETTINGS, deps);

    expect(result?.source.status).toBe('not-found');
    // Never a blank. Every outcome that is not a path carries its sentence.
    expect(result?.source.detail).toContain('lazy chunk');
  });

  it('has no card to show when the click landed outside every component', async () => {
    const { deps } = harness({});
    expect(await locatePicked(picked(), PAGE, DEFAULT_SETTINGS, deps)).toBeNull();
  });
});

describe('the component a popup locate is about', () => {
  const chain: PickedComponent[] = [
    { name: 'Route' },
    { name: 'ThemeProvider' },
    { name: 'CheckoutButton' },
  ];

  it('is the nearest one the user is likely to have written', () => {
    // The panel shows the whole chain and lets the reader walk it. The popup
    // shows one component, so clicking a button inside two routers has to
    // answer with the button.
    const chosen = chooseComponent(picked(...chain), DEFAULT_SETTINGS.hidden);

    expect(chosen?.component.name).toBe('CheckoutButton');
    // The unfiltered index, because that is what the page agent keys rows by.
    expect(chosen?.index).toBe(2);
  });

  it('asks the page for that row, not for the one that was clicked', async () => {
    const { deps, asked } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP });

    await locatePicked(picked(...chain), PAGE, DEFAULT_SETTINGS, deps);

    expect(asked).toEqual([{ group: 'ancestry', index: 2 }]);
  });

  it('falls back to the nearest when the filters would hide everything', () => {
    // A page can legitimately be nothing but plumbing above the element. An
    // empty answer would say the pick found nothing, when it found three
    // components the filter happens to suppress.
    const chosen = chooseComponent(
      picked({ name: 'Route' }, { name: 'ThemeProvider' }),
      DEFAULT_SETTINGS.hidden,
    );

    expect(chosen?.component.name).toBe('Route');
    expect(chosen?.index).toBe(0);
  });

  it('follows the categories the user chose to keep', () => {
    const showingRouters = settingsWith({ 'locator.hidden.routing': false });

    expect(chooseComponent(picked(...chain), showingRouters.hidden)?.component.name).toBe('Route');
  });
});

describe('what never reaches a search', () => {
  it('takes React’s own recorded position over reading any bundle at all', async () => {
    const { deps, fetched, asked } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP });

    const result = await locatePicked(
      picked({
        name: 'CheckoutButton',
        debugSource: { source: 'src/checkout/CheckoutButton.tsx', line: pos1(12), column: pos1(4) },
      }),
      PAGE,
      DEFAULT_SETTINGS,
      deps,
    );

    expect(result?.source).toEqual({
      name: 'CheckoutButton',
      status: 'resolved',
      via: 'debug-source',
      source: 'src/checkout/CheckoutButton.tsx',
      line: 12,
      column: 4,
    });
    // Nothing fetched and nothing asked of the page: the answer was in the pick.
    expect(fetched).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('marks an absolute dev-server path so it stays openable', async () => {
    const { deps } = harness({});

    const result = await locatePicked(
      picked({
        name: 'CheckoutButton',
        debugSource: { source: '/Users/me/shop/src/Button.tsx', line: pos1(3), column: pos1(1) },
      }),
      PAGE,
      DEFAULT_SETTINGS,
      deps,
    );

    expect(result?.source.absolutePath).toBe('/Users/me/shop/src/Button.tsx');
  });

  it('says so rather than scanning every script for a native function', async () => {
    const { deps, fetched } = harness({ [BUNDLE_URL]: BUNDLE }, {
      source: 'function bound CheckoutButton() { [native code] }',
    });

    const result = await locatePicked(picked({ name: 'CheckoutButton' }), PAGE, DEFAULT_SETTINGS, deps);

    expect(result?.source.status).toBe('skipped');
    expect(result?.source.detail).toContain('no bundle');
    expect(fetched).toEqual([]);
  });

  it('refuses a source too short to match anything but noise', async () => {
    const { deps, fetched } = harness({ [BUNDLE_URL]: BUNDLE }, { source: 'f=>f' });

    const result = await locatePicked(picked({ name: 'F' }), PAGE, DEFAULT_SETTINGS, deps);

    expect(result?.source.status).toBe('skipped');
    expect(result?.source.detail).toContain('too short');
    expect(fetched).toEqual([]);
  });

  it('explains a page that could not hand its source back', async () => {
    // A tab that navigated between the pick and the question. Not an error the
    // user did anything about, and not a blank card either.
    const { deps, fetched } = harness({ [BUNDLE_URL]: BUNDLE }, { source: null });

    const result = await locatePicked(picked({ name: 'CheckoutButton' }), PAGE, DEFAULT_SETTINGS, deps);

    expect(result?.source.status).toBe('skipped');
    expect(result?.source.detail).toContain('navigated');
    expect(fetched).toEqual([]);
  });
});

describe('with source maps switched off', () => {
  const MAPS_OFF = settingsWith({ 'react.useSourceMaps': false });

  it('reports the compiled position and never fetches the map', async () => {
    const { deps, fetched } = harness({ [BUNDLE_URL]: BUNDLE, [MAP_URL]: MAP });

    const result = await locatePicked(picked({ name: 'CheckoutButton' }), PAGE, MAPS_OFF, deps);

    expect(result?.source).toEqual({
      name: 'CheckoutButton',
      status: 'compiled-only',
      via: 'bundle-search',
      compiled: { url: BUNDLE_URL, line: 1, column: 0 },
      detail: expect.stringContaining('switched off'),
    });
    expect(fetched).toEqual([BUNDLE_URL]);
  });

  it('holds even where the map costs nothing to read', async () => {
    // The uniformity that makes the setting explicable from the card. An inlined
    // map arrives with the bundle, so a rule written only against the fetch
    // would quietly still resolve on the subset of sites that inline theirs.
    const inlined = `var x=1;\n${BUTTON_SOURCE}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(MAP).toString('base64')}`;
    const { deps } = harness({ [BUNDLE_URL]: inlined });

    const result = await locatePicked(picked({ name: 'CheckoutButton' }), PAGE, MAPS_OFF, deps);

    expect(result?.source.status).toBe('compiled-only');
    expect(result?.source.source).toBeUndefined();
  });

  it('leaves alone the answers a map was never part of', async () => {
    const { deps } = harness({});

    const result = await locatePicked(
      picked({
        name: 'CheckoutButton',
        debugSource: { source: 'src/Button.tsx', line: pos1(2), column: pos1(1) },
      }),
      PAGE,
      MAPS_OFF,
      deps,
    );

    expect(result?.source.status).toBe('resolved');
    expect(result?.source.via).toBe('debug-source');
  });
});

describe('the popup’s markup answers its controller', () => {
  /*
   * `el()` throws on a miss, so a mistyped id is a popup that renders nothing at
   * all — at runtime, in the one window with no console open in front of it.
   * The viewer holds this line in tests/viewer-markup.test.ts; the popup grew a
   * second surface's worth of ids and now needs it too.
   */
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const html = readFileSync(resolve(root, 'src/popup.html'), 'utf8');
  const controller = readFileSync(resolve(root, 'src/ui/popup/main.ts'), 'utf8');

  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const wanted = [...controller.matchAll(/\bel(?:<[^>]*>)?\('([^']+)'\)/g)].map((match) => match[1]);

  it('has every element the controller looks up', () => {
    expect(wanted.length).toBeGreaterThan(0);
    for (const id of wanted) expect(ids, `#${id}`).toContain(id);
  });

  it('links the card’s stylesheet through the one sheet the page loads', () => {
    // Two links are two CSS graphs and only one graph deduplicates, so the
    // shared shell would ship twice. popup.css pulls the card in instead.
    expect(html).not.toContain('result-card.css');
    expect(readFileSync(resolve(root, 'src/ui/popup/popup.css'), 'utf8')).toContain(
      "@import '../components/result-card.css';",
    );
  });
});
