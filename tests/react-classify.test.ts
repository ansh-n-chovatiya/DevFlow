/**
 * The half of `classify.ts` that D5 brought across: the category manifest, its
 * labels, and the filtering a tree does with them.
 *
 * `classifyComponent` and `isSharedPrimitivePath` are exercised in
 * `react-owner.test.ts`, where they are the rule that picks one owner out of a
 * chain. This file is the other consumer — the panel's chips — and the two
 * consumers now share one module, which is what D5 is.
 */

import { describe, expect, it } from 'vitest';
import {
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  HIDEABLE_CATEGORIES,
  categoryFromName,
  countByCategory,
  filterComponents,
  isDependencyPath,
  isHidden,
  isPlumbing,
  type HiddenCategories,
} from '../src/core/react/classify.js';
import { pos1 } from '../src/core/locate/positions.js';
import type { PickedComponent } from '../src/shared/types.js';

function component(name: string, source?: string): PickedComponent {
  return {
    name,
    debugSource: source ? { source, line: pos1(1), column: pos1(1) } : null,
  };
}

/** Every category hidden — the shipped default, and the readable one. */
const ALL_HIDDEN = Object.fromEntries(
  HIDEABLE_CATEGORIES.map((c) => [c, true]),
) as HiddenCategories;

const NONE_HIDDEN = Object.fromEntries(
  HIDEABLE_CATEGORIES.map((c) => [c, false]),
) as HiddenCategories;

describe('the category manifest', () => {
  it('has a label and a description for every hideable category', () => {
    // One settings key, one chip and one tooltip per entry. A category added
    // here without its strings ships a chip with no label at all.
    for (const category of HIDEABLE_CATEGORIES) {
      expect(CATEGORY_LABELS[category], category).toBeTruthy();
      expect(CATEGORY_DESCRIPTIONS[category], category).toBeTruthy();
    }
    expect(Object.keys(CATEGORY_LABELS)).toHaveLength(HIDEABLE_CATEGORIES.length);
    expect(Object.keys(CATEGORY_DESCRIPTIONS)).toHaveLength(HIDEABLE_CATEGORIES.length);
  });

  it('does not make the user\u2019s own code hideable', () => {
    // `unknown` is deliberately absent: there is no switch anywhere that hides
    // a component we failed to recognise, because that component is far more
    // likely to be theirs than a router we missed.
    expect(HIDEABLE_CATEGORIES).not.toContain('unknown');
    expect(isPlumbing('unknown')).toBe(false);
  });
});

describe('isDependencyPath', () => {
  it('detects a node_modules path, nested or Windows-separated', () => {
    expect(isDependencyPath('/Users/dev/app/node_modules/react-router/index.js')).toBe(true);
    expect(isDependencyPath('/app/node_modules/@mui/material/node_modules/x/y.js')).toBe(true);
    expect(isDependencyPath('C:\\app\\node_modules\\react-router\\index.js')).toBe(true);
  });

  it('rejects application source', () => {
    expect(isDependencyPath('/Users/dev/app/src/pages/NewPDP/collection-grid.tsx')).toBe(false);
  });

  it('does not match a directory that merely contains the words', () => {
    expect(isDependencyPath('/app/src/my_node_modules_helper/index.ts')).toBe(false);
  });
});

describe('categoryFromName', () => {
  it.each(['Route', 'Router', 'Switch', 'BrowserRouter', 'Routes', 'Outlet', 'Navigate'])(
    'puts %s in routing',
    (name) => {
      expect(categoryFromName(name)).toBe('routing');
    },
  );

  it.each(['Fragment', 'Suspense', 'Portal', 'StrictMode', 'Profiler'])(
    'puts %s in react',
    (name) => {
      expect(categoryFromName(name)).toBe('react');
    },
  );

  it.each(['ThemeProvider', 'StylesProvider', 'CssBaseline', 'Slot'])(
    'puts %s in styling',
    (name) => {
      expect(categoryFromName(name)).toBe('styling');
    },
  );

  it.each(['Provider', 'ApolloProvider', 'QueryClientProvider'])('puts %s in providers', (name) => {
    expect(categoryFromName(name)).toBe('providers');
  });

  it('matches the wrapper shapes a bundler leaves behind', () => {
    expect(categoryFromName('Lazy()')).toBe('react');
    expect(categoryFromName('Lazy(ProductList)')).toBe('react');
    expect(categoryFromName('Primitive.div')).toBe('styling');
    expect(categoryFromName('ThemeContext.Provider')).toBe('providers');
  });

  it.each(['ProductList', 'CollectionGrid', 'PageRouter', 'NewPDPContent', 'QuickShop'])(
    'leaves application component %s uncategorised',
    (name) => {
      expect(categoryFromName(name)).toBeNull();
    },
  );

  it('leaves generic names an app might own uncategorised', () => {
    // Hiding one of the user's own is worse than showing an extra library one.
    expect(categoryFromName('ErrorBoundary')).toBeNull();
    expect(categoryFromName('Layout')).toBeNull();
  });
});

describe('isHidden', () => {
  it('never hides unknown components, failing open', () => {
    expect(isHidden('unknown', ALL_HIDDEN)).toBe(false);
  });

  it('honours the per-category flag', () => {
    expect(isHidden('routing', ALL_HIDDEN)).toBe(true);
    expect(isHidden('routing', { ...ALL_HIDDEN, routing: false })).toBe(false);
  });
});

describe('filterComponents', () => {
  // A real chain: library components whose JSX was written in app files, which
  // is why the name has to decide before the path does.
  const items = [
    component('App', '/app/src/App.tsx'),
    component('Switch', '/app/src/routing/PageRouter.tsx'),
    component('Lazy()', '/app/src/routing/PageRouter.tsx'),
    component('ApolloProvider', '/app/src/App.tsx'),
    component('ProductList', '/app/src/ProductList.tsx'),
  ];

  it('returns everything when nothing is hidden', () => {
    expect(filterComponents(items, NONE_HIDDEN)).toHaveLength(5);
  });

  it('drops every hidden category by default', () => {
    expect(filterComponents(items, ALL_HIDDEN).map((e) => e.item.name)).toEqual([
      'App',
      'ProductList',
    ]);
  });

  it('hides each category independently', () => {
    expect(
      filterComponents(items, { ...NONE_HIDDEN, routing: true }).map((e) => e.item.name),
    ).toEqual(['App', 'Lazy()', 'ApolloProvider', 'ProductList']);
    expect(
      filterComponents(items, { ...ALL_HIDDEN, routing: false }).map((e) => e.item.name),
    ).toEqual(['App', 'Switch', 'ProductList']);
  });

  it('preserves original indices, which the page agent keys highlights by', () => {
    // Renumbering here would highlight the wrong element the moment a chip
    // was toggled, because the agent only knows the unfiltered list.
    expect(filterComponents(items, ALL_HIDDEN).map((e) => e.index)).toEqual([0, 4]);
  });

  it('always keeps the selected component, even from a hidden category', () => {
    // Otherwise picking a router leaves the tree with no highlighted row and
    // no way back to it.
    expect(filterComponents(items, ALL_HIDDEN, 1).map((e) => e.item.name)).toEqual([
      'App',
      'Switch',
      'ProductList',
    ]);
  });

  it('handles an empty list', () => {
    expect(filterComponents([], ALL_HIDDEN)).toEqual([]);
  });
});

describe('countByCategory', () => {
  it('counts each category separately and ignores app code', () => {
    expect(
      countByCategory([
        component('App', '/app/src/App.tsx'),
        component('Route'),
        component('Router'),
        component('Lazy()'),
        component('ApolloProvider'),
        component('Vendor', '/app/node_modules/v/x.js'),
      ]),
    ).toEqual({ routing: 2, providers: 1, react: 1, styling: 0, dependency: 1 });
  });

  it('returns a zero for every category on an empty list, not an empty object', () => {
    // The chips render their counts unconditionally; a missing key reads as
    // `undefined` on screen.
    expect(countByCategory([])).toEqual({
      routing: 0,
      providers: 0,
      react: 0,
      styling: 0,
      dependency: 0,
    });
  });
});
