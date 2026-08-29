/**
 * Telling a component the user wrote from the plumbing around it.
 *
 * Ported from react-source-locator `src/panel/classify.ts` @ 6eb7a30. The
 * category *names* and the ordering rule are verbatim; what is dropped is
 * everything the panel needed and a flow does not — the filter chips, their
 * labels and descriptions, `filterComponents`, `countByCategory`. Upstream lets
 * a user hide categories from a tree; here classification exists only to pick
 * one owner out of a chain (`owner.ts`).
 *
 * One addition that is not upstream's: `isSharedPrimitivePath`. The panel shows
 * a whole tree and lets the user pick from it, so it never has to answer "which
 * one of these did they mean"; a recorded flow does, and a shared UI kit is
 * where that question gets hard.
 *
 * Pure — no DOM, no Chrome.
 */

/** What a component appears to be, if anything recognisable. */
export type ComponentCategory =
  | 'routing'
  | 'providers'
  | 'react'
  | 'styling'
  | 'dependency'
  | 'unknown';

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
 * Anything unrecognised comes back `unknown` and is treated as the user's —
 * wrongly discarding their component is far worse than picking one router too
 * many. The cost is that a component of theirs genuinely called `Route` is
 * mistaken for plumbing.
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
