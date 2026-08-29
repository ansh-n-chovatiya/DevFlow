/**
 * One interactive locate, for the surface with no DevTools behind it.
 *
 * The DevTools panel locates by asking the page's own resource cache what it
 * loaded; a recording locates in the background, on idle, over needles it
 * captured hours of clicks ago. This is the third case and the one neither
 * source repo had: **one component, picked just now, with DevTools closed and
 * nothing recording.** CONTRACTS §2 calls that door `WorkerProvider`, and this
 * module is what walks through it.
 *
 * ## It is not a second resolver
 *
 * Everything below the needle is `features/react/resolver.ts` — the same search,
 * the same source-map read, the same nine statuses and the same sentence for
 * each. A pass of one component is still a pass, so `resolvePending` is handed a
 * table with a single `pending` row rather than reimplemented at a smaller size.
 * That is deliberate: the merge's stated failure mode is two halves that share a
 * parser and drift in everything above it, and "the popup says *not found* where
 * the panel says *no map*" is exactly that failure, in the place a user is most
 * likely to compare the two.
 *
 * ## Where the bundle list comes from
 *
 * A resolve pass works from `reactScripts` — the inventory the page reports
 * *while recording*. Nothing reports it otherwise, so on the popup's own path
 * that key is usually empty, and a locate that trusted it would answer "no
 * script bundles were seen loading on that page" for every page nobody happened
 * to be recording. So the tab is asked directly, at the moment of the pick, and
 * whatever the inventory does hold is merged in behind it: a live recording's
 * chunk list is real evidence and costs nothing to keep. `mergeScripts` applies
 * the same two URL filters and the same per-origin cap either way, so a locate
 * searches exactly what a recording would have searched.
 *
 * ## The two things that are not a search
 *
 * A component whose React build recorded `_debugSource` is answered from the
 * pick itself, with no fetch at all — that is `via: 'dev build'` on the card. And
 * a component with no readable function source is not searched either: a bound
 * or native function appears in no bundle, and saying so is a better answer than
 * reading every script on the page to find nothing.
 *
 * ## `react.useSourceMaps`
 *
 * CONTRACTS §3.3 gives this key to the interactive locate, deliberately apart
 * from `reactResolve`, which gates the recorder's whole background pass —
 * merging them would mean switching off background resolution to stop a slow
 * pick. Off, this refuses to fetch a map *and* reports the compiled position for
 * every bundle hit, including the ones whose map was inlined and therefore free.
 * Uniformity is the point: a setting that quietly still resolved on the subset
 * of sites that inline their maps would be impossible to reason about from the
 * result card.
 *
 * Pure of `chrome.*`: every effect is a dependency, so the whole path is
 * exercised by tests/locate-popup.test.ts over a real `WorkerProvider` and a
 * fake web, rather than by loading the extension.
 */

import {
  HIDEABLE_CATEGORIES,
  filterComponents,
  type HiddenCategories,
} from '../../core/react/classify.js';
import { buildNeedle, type NeedleRejection } from '../../core/react/needle.js';
import type { BundleProvider } from '../../core/react/provider.js';
import { isAbsolutePath } from '../../core/react/table.js';
import { mergeScripts, scriptsForPage } from '../../features/react/inventory.js';
import { bundleBudget } from '../../features/react/providers/worker.js';
import { resolvePending, type ResolveLimits } from '../../features/react/resolver.js';
import { hiddenKeyFor, type Settings } from '../../features/settings/fields.js';
import type {
  ComponentSource,
  LocateResult,
  PickSuccess,
  PickedComponent,
  TreeGroup,
} from '../../shared/types.js';

/** The id the one-row component table is keyed by. It never leaves this module. */
const PICKED = 'picked';

// ── What a locate needs ──────────────────────────────────────────────────────

/**
 * Everything this reaches outside itself.
 *
 * `readSource` and `listScripts` are both round trips to the picked tab, which
 * the popup makes through the worker and `chrome.scripting`; the provider is the
 * budgeted bundle reader from CONTRACTS §2. A test supplies three functions and
 * a real `WorkerProvider` over a stub `fetchText`, so the cache, the in-flight
 * dedupe and the size caps are the shipped ones.
 */
export interface LocateDeps {
  /**
   * The picked component's compiled source, read in the page's own world.
   *
   * `null` is an ordinary answer, not a failure — a native function has no
   * source text, and a tab that navigated since the pick has nothing to read.
   */
  readSource(group: TreeGroup, index: number): Promise<string | null>;
  /** Script URLs the tab has loaded, newest evidence first. */
  listScripts(): Promise<string[]>;
  provider: BundleProvider;
  now(): number;
}

/** The settings one locate runs inside, resolved once by the caller. */
export interface LocateSettings {
  /** Which categories the chain filter suppresses — `locator.hidden.*`. */
  hidden: HiddenCategories;
  /** `react.useSourceMaps`. */
  useSourceMaps: boolean;
  /** `react.maxResolveMsPerFlow`, as a ceiling on the wait. */
  budgetMs: number;
  /** The five Tier 2 numbers, as the resolver spells them. */
  limits: ResolveLimits;
}

/**
 * The settings a locate reads, in one place.
 *
 * Nothing here retypes a default: `resolve()` has already clamped every value
 * against the field table, and the five bundle numbers arrive through
 * `bundleBudget`, which is the shape CONTRACTS §2 froze precisely so that the
 * panel and this path cannot end up with two different sets.
 */
export function locateSettings(settings: Settings): LocateSettings {
  return {
    hidden: hiddenCategories(settings),
    useSourceMaps: settings['react.useSourceMaps'],
    budgetMs: settings['react.maxResolveMsPerFlow'],
    limits: resolveLimits(settings),
  };
}

/**
 * `locator.hidden.*` as the classifier wants it.
 *
 * Absent keys default to hidden, which is the field table's own default: an
 * ancestor chain is mostly routers and providers, and a category the classifier
 * knows about but the table has no switch for is still plumbing.
 */
function hiddenCategories(settings: Settings): HiddenCategories {
  const hidden = {} as HiddenCategories;

  for (const category of HIDEABLE_CATEGORIES) {
    const key = hiddenKeyFor(category);
    hidden[category] = key === undefined ? true : settings[key] === true;
  }

  return hidden;
}

/**
 * `BundleBudget` under the resolver's older names.
 *
 * The conversion is here rather than at five settings lookups because the
 * resolver's own header says these are the same five keys twice named, and the
 * one thing worse than two names is two readings of the table.
 */
function resolveLimits(settings: Settings): ResolveLimits {
  const budget = bundleBudget(settings);

  return {
    concurrency: budget.concurrency,
    cacheEntries: budget.cacheEntries,
    cacheBytes: budget.cacheBytes,
    resourceBytes: budget.maxResourceBytes,
    mapBytes: budget.maxMapBytes,
  };
}

// ── Choosing what was picked ─────────────────────────────────────────────────

/** A row of the pick, with the index the page agent knows it by. */
export interface Chosen {
  component: PickedComponent;
  group: TreeGroup;
  index: number;
}

/**
 * Which component of the picked chain the popup is about.
 *
 * The panel shows the whole ancestry and lets the reader walk it. The popup
 * shows one component, so the choice has to be the one they meant: the nearest
 * ancestor that is not plumbing. Clicking a button inside six routers and
 * providers should answer with the button's component, not with `Route`.
 *
 * When *everything* above the element is plumbing the nearest is used anyway. A
 * page can legitimately be built that way, and an empty answer would say the
 * pick found nothing when it found six components the filter happens to hide.
 */
export function chooseComponent(pick: PickSuccess, hidden: HiddenCategories): Chosen | null {
  const visible = filterComponents(pick.ancestry, hidden)[0];
  if (visible) return { component: visible.item, group: 'ancestry', index: visible.index };

  const nearest = pick.ancestry[0];
  return nearest ? { component: nearest, group: 'ancestry', index: 0 } : null;
}

// ── The sentences this module writes ─────────────────────────────────────────

/**
 * Why a component was not searched for, by what the needle builder refused.
 *
 * Written here rather than shared with `table.ts`'s recording-side copy because
 * the reader is in a different position: they picked this component a second
 * ago and are watching for an answer, so the sentence says what happened to
 * *their* gesture rather than describing a row in a flow.
 */
const NEEDLE_DETAIL: Record<NeedleRejection, string> = {
  native:
    'This is a bound or native function, so its source appears in no bundle to search.',
  'too-short':
    'Its source is too short to search for without matching unrelated code, so no file is claimed.',
};

const UNREADABLE_DETAIL =
  'The page did not hand back this component’s source, so there was nothing to search for — it may have navigated since the pick.';

const MAPS_OFF_DETAIL =
  'Found in the bundle. Source maps are switched off in Settings, so the compiled position is as far as this goes.';

// ── Locating ─────────────────────────────────────────────────────────────────

/**
 * Resolve the component the user just picked.
 *
 * Never throws and never rejects: every way this can fail is one of the nine
 * statuses with a sentence attached, because the caller is a window the user is
 * watching and "nothing appeared" is not an outcome it can render.
 *
 * `null` only when the pick carried no component at all, which is a different
 * thing from a component with no source — there is no name to put on a card.
 */
export async function locatePicked(
  pick: PickSuccess,
  pageUrl: string,
  settings: LocateSettings,
  deps: LocateDeps,
): Promise<LocateResult | null> {
  const chosen = chooseComponent(pick, settings.hidden);
  if (!chosen) return null;

  const name = chosen.component.name;
  const around = { component: name, ancestry: pick.ancestry, siblings: pick.siblings };

  const debug = chosen.component.debugSource;
  if (debug?.source) {
    /*
     * A development build wrote the position down at compile time, so there is
     * nothing to search for and no bundle to read. Not the same fact as a
     * bundle hit — this is where the JSX element was *written*, a position in
     * the parent's file — which is why the card labels it `dev build` rather
     * than treating it as a search result.
     */
    return {
      ...around,
      resourcesSearched: 0,
      source: {
        name,
        status: 'resolved',
        via: 'debug-source',
        source: debug.source,
        line: debug.line,
        column: debug.column,
        ...(isAbsolutePath(debug.source) ? { absolutePath: debug.source } : {}),
      },
    };
  }

  const fnSource = await deps.readSource(chosen.group, chosen.index);
  if (fnSource === null) {
    return { ...around, resourcesSearched: 0, source: { name, status: 'skipped', detail: UNREADABLE_DETAIL } };
  }

  const built = buildNeedle(fnSource);
  if (!built.ok) {
    return {
      ...around,
      resourcesSearched: 0,
      source: { name, status: 'skipped', detail: NEEDLE_DETAIL[built.reason] },
    };
  }

  const scripts = await inventoryFor(pageUrl, deps);
  const searched = scriptsForPage(scripts, pageUrl).length;

  const pass = await resolvePending(
    {
      components: { [PICKED]: { name, status: 'pending' } },
      needles: { [PICKED]: { ...built.needle, pageUrl } },
      scripts,
      // There is no next trigger. A locate is one gesture with one answer, so
      // anything the budget did not reach is reported rather than left saying
      // "still resolving" under a spinner that has stopped.
      final: true,
      budgetMs: settings.budgetMs,
      limits: settings.limits,
    },
    {
      provider: settings.useSourceMaps ? deps.provider : withoutMapFetches(deps.provider),
      // Called through rather than handed over: a method plucked off its object
      // loses its receiver, and a test's clock is a closure over state it drives.
      now: () => deps.now(),
    },
  );

  const source = pass.components[PICKED] ?? {
    name,
    status: 'skipped' as const,
    detail: 'The search did not report an outcome for this component.',
  };

  return {
    ...around,
    resourcesSearched: searched,
    source: settings.useSourceMaps ? source : compiledOnly(source),
  };
}

/**
 * What to search: the tab as it is now, plus anything a recording already knew.
 *
 * The live gather is first because it is the complete list for the document on
 * screen, and `mergeScripts` keeps first-seen order — which is the page's own
 * load order, and roughly most-likely-first for a search that stops at its first
 * hit.
 */
async function inventoryFor(
  pageUrl: string,
  deps: LocateDeps,
): Promise<Record<string, string[]>> {
  const live = await deps.listScripts();
  // The frozen `BundleProvider` method, used for the one caller it was kept
  // for: a surface holding a tab and no pass. Empty unless something recorded
  // this origin, which is why it is the fallback rather than the source.
  const known = await deps.provider.listScripts(pageUrl);

  return mergeScripts({}, pageUrl, [...live, ...known]).scripts;
}

/**
 * The provider, with map reads refused.
 *
 * `loadUrl` is only ever called for a source map — bundles go through
 * `loadScript` — so this is the whole of "do not fetch a map", and it is a
 * wrapper rather than a flag on the resolver because the resolver belongs to
 * another package and the setting belongs to this surface.
 */
function withoutMapFetches(provider: BundleProvider): BundleProvider {
  return {
    listScripts: (pageUrl) => provider.listScripts(pageUrl),
    loadScript: (url) => provider.loadScript(url),
    loadUrl: () => Promise.resolve(null),
  };
}

/**
 * The answer a locate gives when source maps are switched off.
 *
 * A refused fetch is not enough on its own: a bundle that inlines its map as a
 * `data:` URL needs no fetch, so it would map back anyway and the setting would
 * hold on some sites and not others. Every bundle hit therefore reports its
 * compiled position, with one sentence saying why — which is also what makes
 * `Open in Sources` the useful action on the card that comes back.
 *
 * Untouched: everything that never involved a map. A `dev build` position was
 * read off the fiber, and `not-found` found nothing to map.
 */
function compiledOnly(source: ComponentSource): ComponentSource {
  if (source.via !== 'bundle-search' || !source.compiled) return source;

  return {
    name: source.name,
    status: 'compiled-only',
    via: 'bundle-search',
    compiled: source.compiled,
    ...(source.matchCount === undefined ? {} : { matchCount: source.matchCount }),
    detail: MAPS_OFF_DETAIL,
  };
}
