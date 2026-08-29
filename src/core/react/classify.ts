/**
 * Telling a component somebody wrote from the plumbing around it.
 *
 * **D5 · One superset module, tree-shaken.** This existed twice with different
 * amounts of it. The panel's copy carried the filter chips, their labels and
 * descriptions, `filterComponents` and `countByCategory`; the recorder's kept
 * only what it takes to pick one owner out of a chain (`owner.ts`) and dropped
 * the rest. Splitting the difference — a "core" classify and a "panel" classify
 * — puts the category table back in two places, which is the duplication this
 * whole merge exists to delete. So everything is here, and the recorder's
 * bundle is kept honest by the build rather than by discipline: `src/core/` is
 * bundled into `mcp-server/core.js`, which imports only `isDependencyPath` and
 * `classifyComponent` through `owner.ts`, so a UI string that leaks onto the
 * worker path shows up as a bigger `core.js` and nowhere else.
 *
 * The category names, their ordering rule and the reasoning in
 * `classifyComponent` are shared by both uses. What differs is only what a
 * caller does with the answer: the panel hides a category from a tree, the
 * recorder prefers one candidate over another. Neither can hide the user's own
 * code, because `unknown` is never hideable and never plumbing.
 *
 * One thing here belongs to neither original: `isSharedPrimitivePath`. A panel
 * shows a whole tree and lets the user choose from it, so it never has to answer
 * "which one of these did they mean"; a recorded flow does, and a shared UI kit
 * is exactly where that question gets hard.
 *
 * Pure — no DOM, no Chrome.
 */

import type { PickedComponent } from '../../shared/types.js';

/**
 * The categories a tree can filter independently.
 *
 * Split rather than one "framework" switch because the groups are useful at
 * different moments: routers are noise while you hunt for a leaf component, and
 * exactly what you want when you are chasing which route rendered a page.
 *
 * One settings key per entry — `locator.hidden.<category>`, see CONTRACTS §3.3 —
 * so this array is also the manifest those keys are generated against.
 */
export const HIDEABLE_CATEGORIES = [
  'routing',
  'providers',
  'react',
  'styling',
  'dependency',
] as const;

export type HideableCategory = (typeof HIDEABLE_CATEGORIES)[number];

/** `unknown` is never hidden and never plumbing — see `classifyComponent`. */
export type ComponentCategory = HideableCategory | 'unknown';

/** Resolved view of the `locator.hidden.*` keys; the flat storage shape is J's. */
export type HiddenCategories = Record<HideableCategory, boolean>;

/** Chip labels. Short because they sit in a row of five above a tree. */
export const CATEGORY_LABELS: Record<HideableCategory, string> = {
  routing: 'Routers',
  providers: 'Providers',
  react: 'React',
  styling: 'Styling',
  dependency: 'Deps',
};

/** The tooltip behind each chip, since five one-word labels explain nothing. */
export const CATEGORY_DESCRIPTIONS: Record<HideableCategory, string> = {
  routing: 'Routers, routes and switches (react-router and friends)',
  providers: 'Context, store and client providers',
  react: 'React internals — Fragment, Suspense, Portal, lazy and memo wrappers',
  styling: 'Theme, style engine and headless UI primitives',
  dependency: 'Anything else React recorded as living in node_modules',
};

/** Names checked in order; the first category that matches wins. */
const CATEGORY_NAMES: Record<Exclude<ComponentCategory, 'dependency' | 'unknown'>, Set<string>> = {
  routing: new Set([
    'Router',
    'BrowserRouter',
    'HashRouter',
    'MemoryRouter',
    'StaticRouter',
    'Routes',
    'Route',
    'Switch',
    'Navigate',
    'Redirect',
    'Outlet',
    'RouterProvider',
    'RenderedRoute',
    'DataRouterProvider',
    'DataRouterStateProvider',
  ]),
  react: new Set([
    'Fragment',
    'Suspense',
    'SuspenseList',
    'StrictMode',
    'Profiler',
    'Portal',
    'Offscreen',
    'Activity',
    'ForwardRef',
    'Memo',
    'Lazy',
  ]),
  styling: new Set([
    'ThemeProvider',
    'RtlProvider',
    'DefaultPropsProvider',
    'StylesProvider',
    'GlobalStyles',
    'CssBaseline',
    'EmotionCacheProvider',
    'TssCacheProvider',
    'Slot',
    'SlotClone',
    'Presence',
  ]),
  providers: new Set([
    'Provider',
    'ApolloProvider',
    'QueryClientProvider',
    'HydrationBoundary',
    'Hydrate',
    'HelmetProvider',
    'I18nextProvider',
  ]),
};

const CATEGORY_PATTERNS: [Exclude<ComponentCategory, 'dependency' | 'unknown'>, RegExp][] = [
  ['react', /^Lazy\(/], // React.lazy wrappers, including the bare `Lazy()`
  ['react', /^(ForwardRef|Memo)\(/], // unnamed wrapper fallbacks
  ['styling', /^Primitive\./], // Radix primitives: Primitive.div
  ['providers', /\.(Provider|Consumer)$/], // raw context objects
];

/** True for a path inside an installed dependency. */
export function isDependencyPath(path: string): boolean {
  return /(^|[\\/])node_modules[\\/]/.test(path);
}

/**
 * True for a path that looks like the app's own shared UI kit.
 *
 * `src/components/ui/Button.tsx` is the user's code by every test that matters —
 * it is in their repo, they can edit it — and it is still almost never the
 * answer to "which component did they click". A click on Continue lands in
 * `Button`, and what the reader wanted to know was `CheckoutButton`.
 *
 * Used only to *prefer* something further out, never to reject: see
 * `pickEnclosing`. That is what makes a wrong guess here harmless. An app whose
 * every file lives under `src/ui/` has every candidate demoted equally, which
 * changes nothing, and an app with no shared kit never reaches this at all.
 *
 * Deliberately a short list of segment names rather than a clever heuristic.
 * These are the conventions the ecosystem actually settled on — shadcn/ui put
 * `components/ui` in a large fraction of React apps single-handedly — and a
 * longer list buys accuracy on rarer layouts at the cost of misfiring on names
 * that mean something else in someone's repo.
 */
export function isSharedPrimitivePath(path: string): boolean {
  return /(^|[\\/])(ui|primitives|design-system|design_system)[\\/]/i.test(path);
}

/** The category a name alone implies, or null when it implies nothing. */
export function categoryFromName(
  name: string,
): Exclude<ComponentCategory, 'dependency' | 'unknown'> | null {
  for (const [category, names] of Object.entries(CATEGORY_NAMES)) {
    if (names.has(name)) return category as Exclude<ComponentCategory, 'dependency' | 'unknown'>;
  }
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(name)) return category;
  }
  return null;
}

/**
 * Categorises a component.
 *
 * The name decides first, and the resolved path is only a fallback. That
 * ordering is not a preference — a `debug-source` path records **where the JSX
 * element was written, not where the component is defined**. `<Switch>` written
 * in the app's own router file reports the app's file, so treating a
 * non-`node_modules` path as proof that a component is the user's silently
 * exempts every library component the app renders directly, which is most of
 * them.
 *
 * The path is still a sound one-way signal: code that lives *inside*
 * `node_modules` belongs to a library, whatever it is called.
 *
 * Anything unrecognised comes back `unknown`, is treated as the user's, and is
 * never hidden — wrongly discarding their component is far worse than keeping
 * one router too many. The cost of leading with the name is that a component of
 * theirs genuinely called `Route` is mistaken for plumbing; in the tree the
 * category chip is the escape hatch, and in a flow the owner rule has three more
 * tiers to fall through.
 *
 * `source` is the *resolved* path where one is known and the `debugSource` path
 * otherwise, which is why it can only ever be read one way: `node_modules` in it
 * proves a library, and its absence proves nothing.
 */
export function classifyComponent(name: string, source?: string | null): ComponentCategory {
  const byName = categoryFromName(name);
  if (byName) return byName;

  if (source && isDependencyPath(source)) return 'dependency';

  return 'unknown';
}

/** Is this something the user wrote, or the machinery it runs inside? */
export function isPlumbing(category: ComponentCategory): boolean {
  return category !== 'unknown';
}

/**
 * Whether a category is currently suppressed.
 *
 * `unknown` fails open, always. Hiding one of the user's own components is far
 * worse than leaving an extra router in the list — they would be looking for a
 * component that the tree simply does not show, with nothing saying why.
 */
export function isHidden(category: ComponentCategory, hidden: HiddenCategories): boolean {
  return category !== 'unknown' && hidden[category];
}

/** A component that survived the filters, and where it sat before them. */
export interface VisibleEntry {
  item: PickedComponent;
  /** Position in the unfiltered list — the index the page agent knows it by. */
  index: number;
}

/**
 * Applies the category filters to a picked chain.
 *
 * `keepIndex` is always retained: hiding the component the user just selected
 * would leave the tree with no highlighted row and no way back to it.
 *
 * Indices are the *unfiltered* ones, because that is what the page agent keys
 * its highlights by — renumbering here would highlight the wrong element as soon
 * as a chip was toggled.
 */
export function filterComponents(
  items: PickedComponent[],
  hidden: HiddenCategories,
  keepIndex = -1,
): VisibleEntry[] {
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => index === keepIndex || !isHidden(classifyPicked(item), hidden));
}

/** How many components fall in each hideable category, for the chip counts. */
export function countByCategory(items: PickedComponent[]): Record<HideableCategory, number> {
  const counts = Object.fromEntries(HIDEABLE_CATEGORIES.map((c) => [c, 0])) as Record<
    HideableCategory,
    number
  >;

  for (const item of items) {
    const category = classifyPicked(item);
    if (category !== 'unknown') counts[category]++;
  }

  return counts;
}

/**
 * `classifyComponent` for a picked component.
 *
 * Separate from `classifyComponent` rather than an overload of it, so that the
 * rule itself stays two strings wide: `owner.ts` classifies a `ComponentSource`
 * and a tree classifies a `PickedComponent`, and neither shape belongs inside
 * the rule. Exported because a tree row shows its own category as well as being
 * filtered by it, and unpacking `debugSource` at each of those call sites is how
 * two of them end up reading a different field.
 */
export function classifyPicked(component: PickedComponent): ComponentCategory {
  return classifyComponent(component.name, component.debugSource?.source);
}
