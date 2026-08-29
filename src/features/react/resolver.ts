/**
 * Turning a captured needle into the file somebody wrote.
 *
 * This is stage B of the three: it runs in the service worker, on
 * idle, decoupled from capture on purpose. A step is never delayed, degraded or
 * lost because a bundle was slow or a source map 404'd — the worst this can do
 * is leave a component with its name and a sentence saying why there is no path.
 *
 * Four properties it has to keep:
 *
 *   - **Idempotent.** An MV3 worker is killed whenever Chrome likes. Anything
 *     unfinished stays `pending` with its needle in storage, and the next
 *     trigger picks it up exactly where this one stopped.
 *   - **Bounded.** Every component gets at most one search per inventory
 *     generation, fetches are capped by size and concurrency, and a pass stops
 *     at a deadline. A pathological site costs a fixed amount and then stops.
 *   - **Honest.** Every outcome that is not a resolved path carries a status and
 *     one sentence saying why. There is no silent omission anywhere in here.
 *   - **Invisible to the recording.** These fetches come from the worker, so the
 *     page's patched `fetch`/`XHR` never see them and FlowSnap cannot end up
 *     recording itself.
 */

import { fetchText as fetchTextViaChrome } from '../../chrome/fetch.js';
import { isDependencyPath } from '../../core/react/classify.js';
import { searchBundle, countOccurrences } from '../../core/react/search.js';
import {
  extractSourceMappingURL,
  decodeDataUrl,
  lookupOriginal,
  parseSourceMap,
  SourceMapError,
  type PreparedMap,
} from '../../core/react/sourcemap.js';
import { isAbsolutePath } from '../../core/react/table.js';
import {
  BUNDLE_CACHE_BYTES,
  BUNDLE_CACHE_ENTRIES,
  MAX_MAP_BYTES,
  MAX_MATCHES_TRACKED,
  MAX_RESOLVE_MS_PER_FLOW,
  MAX_RESOURCE_BYTES,
  RESOLVE_CONCURRENCY,
} from '../../shared/constants.js';
import type { ComponentNeedle, ComponentSource } from '../../shared/types.js';
import { scriptsForPage } from './inventory.js';

/** Everything the resolver touches outside itself, so tests need no browser. */
export interface ResolveDeps {
  fetchText(url: string, maxBytes: number): Promise<{ ok: true; value: string } | { ok: false }>;
  now(): number;
}

const defaultDeps: ResolveDeps = {
  fetchText: fetchTextViaChrome,
  now: () => Date.now(),
};

export interface ResolveInput {
  components: Record<string, ComponentSource>;
  needles: Record<string, ComponentNeedle>;
  scripts: Record<string, string[]>;
  /**
   * No further trigger will follow — the recording has stopped, or the flow is
   * being sent. Anything still unattempted is reported as `skipped` rather than
   * left saying `pending`, which would read as "still working" forever.
   */
  final: boolean;
  /**
   * Resolution is switched off in settings. Nothing is fetched and nothing is
   * searched; the final pass says so, so a reader sees a reason rather than a
   * component that looks unresolvable.
   *
   * Needles are left in place until that final pass, which is what lets someone
   * who switches the setting back on mid-recording still get their paths.
   */
  disabled?: boolean;
  /**
   * How long this pass may spend, in milliseconds — `react.maxResolveMsPerFlow`.
   *
   * Read live by the caller rather than frozen, exactly like the `disabled`
   * flag above it: this is a budget for work that runs *after* the click, and
   * often after the recording has stopped, so "how long am I allowed to take"
   * is a question about now. It is not in the flow's stamp for the same reason
   * — a pass that ran out of time says so on the components themselves, which
   * is a fact about them rather than about the recording.
   *
   * Omitted falls back to the compiled-in default, for the tests that drive
   * this module directly.
   */
  budgetMs?: number;
  /**
   * The five Tier 2 numbers this pass works inside — see `ResolveLimits`.
   *
   * Live, like the budget: they are about what this machine is willing to spend
   * now, not about what the recording captured, so they are not in the freeze
   * and not in the flow's stamp. Omitted falls back to the shipped answer.
   */
  limits?: ResolveLimits;
}

export interface ResolveOutput {
  components: Record<string, ComponentSource>;
  needles: Record<string, ComponentNeedle>;
  /** False when nothing moved, so the caller can skip the storage write. */
  changed: boolean;
}

// ── Caches ───────────────────────────────────────────────────────────────────
//
// Worker-lived and keyed by URL. The bundle cache is what makes resolving the
// eighth component nearly free: it is the same four bundles as the first.

const bundleCache = new Map<string, string>();
let bundleCacheBytes = 0;

/** In-flight fetches, so four components racing for one bundle fetch it once. */
const bundleInflight = new Map<string, Promise<string | null>>();

/** Parsed maps, and the failures — a map that will not parse must not be re-parsed. */
const mapCache = new Map<string, PreparedMap | null>();

export function clearResolverCaches(): void {
  bundleCache.clear();
  bundleCacheBytes = 0;
  bundleInflight.clear();
  mapCache.clear();
}

/**
 * The five Tier 2 numbers this module works inside.
 *
 * Passed in on `ResolveInput` rather than imported at use, for the reason the
 * budget above already gives: this module is bundled into a service worker that
 * Chrome kills and restarts, and a value read at import would be the
 * compiled-in default for every pass after that. Grouped rather than listed as
 * five parameters because they travel together through four functions, and a
 * call site that got their order wrong would still typecheck.
 *
 * The default is the shipped answer, for the tests that drive this module
 * directly and for any caller with no settings in hand.
 */
export interface ResolveLimits {
  /** `react.resolveConcurrency` — bundles fetched at once. */
  concurrency: number;
  /** `react.bundleCacheEntries` — bundle texts held at once. */
  cacheEntries: number;
  /** `react.bundleCacheBytes` — total size of those texts. */
  cacheBytes: number;
  /** `react.maxResourceBytes` — largest script fetched at all. */
  resourceBytes: number;
  /** `react.maxMapBytes` — largest source map fetched at all. */
  mapBytes: number;
}

export const DEFAULT_RESOLVE_LIMITS: ResolveLimits = {
  concurrency: RESOLVE_CONCURRENCY,
  cacheEntries: BUNDLE_CACHE_ENTRIES,
  cacheBytes: BUNDLE_CACHE_BYTES,
  resourceBytes: MAX_RESOURCE_BYTES,
  mapBytes: MAX_MAP_BYTES,
};

/** Evicts oldest-first until the cache is back inside both of its limits. */
function trimBundleCache(limits: ResolveLimits): void {
  for (const [url, text] of bundleCache) {
    if (bundleCache.size <= limits.cacheEntries && bundleCacheBytes <= limits.cacheBytes) return;
    bundleCache.delete(url);
    bundleCacheBytes -= text.length;
  }
}

function loadBundle(url: string, deps: ResolveDeps, limits: ResolveLimits): Promise<string | null> {
  const cached = bundleCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  const pending = bundleInflight.get(url);
  if (pending) return pending;

  const promise = deps
    .fetchText(url, limits.resourceBytes)
    .then((result) => {
      if (!result.ok) return null;
      bundleCache.set(url, result.value);
      bundleCacheBytes += result.value.length;
      trimBundleCache(limits);
      return result.value;
    })
    .finally(() => bundleInflight.delete(url));

  bundleInflight.set(url, promise);
  return promise;
}

// ── Resolving one component ──────────────────────────────────────────────────

/**
 * Why a bundle search ended without a position.
 *
 * `budget-exhausted` is a separate outcome from `not-found` because the two were
 * indistinguishable and the caller reported both as the latter. "Not found in
 * the 3 scripts the page had loaded" was written after reading one of them, and
 * `retryAfter: urls.length` then told the next pass it had already looked
 * everywhere — so a clock that ran out once made a component permanently
 * unresolvable, with a confident sentence explaining the wrong reason.
 */
type SearchFailure = 'not-found' | 'unfetchable' | 'budget-exhausted';

interface SearchSuccess {
  url: string;
  line: number;
  column: number;
  matchCount: number;
  content: string;
  /** The needle that hit, which is the text later bundles must be counted for. */
  needleText: string;
  /**
   * False when the deadline cut the duplicate sweep short, so `matchCount` is a
   * lower bound rather than the answer.
   */
  swept: boolean;
}

/**
 * Walks the page's bundles in load order until the needle hits.
 *
 * Once it has, the remaining bundles are still scanned for the same text —
 * purely to find out whether the answer is ambiguous. A component whose code
 * was inlined into three chunks has three equally true positions, and reporting
 * one of them as fact would be the kind of confident wrong answer this feature
 * exists to remove.
 *
 * That sweep counts `hit.needleText` rather than `needle.head`. The head is the
 * wrong text whenever the hit came from the body needle, which is precisely the
 * renamed-function case the body needle exists for: the same component compiled
 * into two chunks under two minified names shares no head, so every later chunk
 * counted zero and one of two equally likely paths shipped as unique.
 */
async function searchForNeedle(
  needle: ComponentNeedle,
  urls: string[],
  deps: ResolveDeps,
  deadline: number,
  limits: ResolveLimits,
): Promise<SearchSuccess | SearchFailure> {
  let hit: SearchSuccess | null = null;
  let anyLoaded = false;
  let outOfTime = false;

  for (const url of urls) {
    if (deps.now() > deadline) {
      outOfTime = true;
      break;
    }

    const content = await loadBundle(url, deps, limits);
    if (!content) continue;
    anyLoaded = true;

    if (hit) {
      hit.matchCount += countOccurrences(
        content,
        hit.needleText,
        MAX_MATCHES_TRACKED - hit.matchCount,
      );
      // The cap is as much as is ever tracked, so nothing further would change
      // the answer: this is a finished sweep, not a truncated one.
      if (hit.matchCount >= MAX_MATCHES_TRACKED) return hit;
      continue;
    }

    const found = searchBundle(content, needle);
    if (found) {
      hit = {
        url,
        line: found.line,
        column: found.column,
        matchCount: found.matchCount,
        content,
        needleText: found.needleText,
        swept: true,
      };
      if (hit.matchCount >= MAX_MATCHES_TRACKED) return hit;
    }
  }

  if (hit) {
    hit.swept = !outOfTime;
    return hit;
  }
  if (outOfTime) return 'budget-exhausted';
  return anyLoaded ? 'not-found' : 'unfetchable';
}

/** Fetches and parses a bundle's map. Null means the bundle ships none. */
async function loadMap(
  bundleUrl: string,
  bundleContent: string,
  deps: ResolveDeps,
  limits: ResolveLimits,
): Promise<PreparedMap | null> {
  const cached = mapCache.get(bundleUrl);
  if (cached !== undefined) return cached;

  const annotation = extractSourceMappingURL(bundleContent);
  if (!annotation) {
    mapCache.set(bundleUrl, null);
    return null;
  }

  let json: string;

  if (annotation.startsWith('data:')) {
    // Inlined by the bundler — no request, and no size guard needed beyond the
    // one the bundle itself already passed.
    json = decodeDataUrl(annotation);
  } else {
    let mapUrl: string;
    try {
      mapUrl = new URL(annotation, bundleUrl).toString();
    } catch {
      throw new SourceMapError(`the sourceMappingURL "${annotation}" is not a resolvable URL`);
    }

    const fetched = await deps.fetchText(mapUrl, limits.mapBytes);
    if (!fetched.ok) {
      throw new SourceMapError('its source map could not be fetched — it may be 404 or private');
    }
    json = fetched.value;
  }

  const map = parseSourceMap(json);
  mapCache.set(bundleUrl, map);
  return map;
}

/**
 * What one component's pass concluded.
 *
 * `retryAfter` records the inventory size the answer was reached with; absent
 * means terminal, and the needle is dropped. `unchanged` is neither: the pass
 * stopped without learning anything, so the entry and its needle are left
 * exactly as they were for the next pass to resume from.
 */
interface ResolveOutcome {
  source: ComponentSource;
  retryAfter?: number;
  unchanged?: true;
}

/** One component, start to finish. Never throws — every failure is a status. */
async function resolveOne(
  entry: ComponentSource,
  needle: ComponentNeedle,
  urls: string[],
  deps: ResolveDeps,
  deadline: number,
  limits: ResolveLimits,
): Promise<ResolveOutcome> {
  const name = entry.name;

  if (urls.length === 0) {
    return {
      source: {
        name,
        status: 'not-found',
        detail: 'No script bundles were seen loading on that page, so there was nothing to search.',
      },
      retryAfter: 0,
    };
  }

  const found = await searchForNeedle(needle, urls, deps, deadline, limits);

  if (found === 'budget-exhausted') {
    // Nothing was learned, so nothing is written down. Saying "not found in the
    // N scripts the page had loaded" here would be a conclusion drawn from the
    // bundles this pass never got to read, and — because that answer carries a
    // `searched` count of every script — one no later pass would revisit.
    // Left as it was, the entry is still `pending`, `selectPending` picks it up
    // unconditionally next time, and `finish` turns it into an honest `skipped`
    // if the flow ends first.
    return { source: entry, unchanged: true };
  }

  if (found === 'unfetchable') {
    return {
      source: {
        name,
        status: 'unfetchable',
        detail: "None of the page's script bundles could be read, so its source was never searched.",
      },
      // A bundle that would not load once may load on the next pass.
      retryAfter: 0,
    };
  }

  if (found === 'not-found') {
    return {
      source: {
        name,
        status: 'not-found',
        detail: `Not found in the ${urls.length} script${urls.length === 1 ? '' : 's'} the page had loaded — most likely a lazy chunk that was never fetched.`,
      },
      // Worth another look, but only once the page has loaded more scripts.
      retryAfter: urls.length,
    };
  }

  const compiled = { url: found.url, line: found.line + 1, column: found.column + 1 };
  const ambiguous = found.matchCount > 1;

  /*
   * A match found before the duplicate sweep could finish is not a unique match;
   * it is a first match with the checking abandoned. The deadline lands here as
   * readily as anywhere — a hit in the first of four bundles leaves three still
   * to fetch — and duplicated vendored modules make a second copy ordinary. So a
   * cut-short sweep is reported at the confidence it was actually reached with,
   * rather than as the `resolved`, caveat-free answer it used to produce.
   */
  const unswept = !found.swept && !ambiguous;
  const uncertain = ambiguous || unswept;

  const partialNote =
    " Not all of the page's bundles were checked before the time budget ran out, so the same code may appear elsewhere.";
  const ambiguityNote = ambiguous
    ? ` The same code appears in ${found.matchCount === MAX_MATCHES_TRACKED ? `${MAX_MATCHES_TRACKED} or more` : found.matchCount} places, so this may not be the right one.`
    : unswept
      ? partialNote
      : '';

  let map: PreparedMap | null;
  try {
    map = await loadMap(found.url, found.content, deps, limits);
  } catch (error) {
    const reason = error instanceof SourceMapError ? error.message : 'its source map could not be read';
    return {
      source: {
        name,
        status: 'map-error',
        via: 'bundle-search',
        compiled,
        ...(ambiguous ? { matchCount: found.matchCount } : {}),
        detail: `Found in the bundle, but ${reason}. The compiled position is the best available.${ambiguityNote}`,
      },
    };
  }

  if (!map) {
    return {
      source: {
        name,
        status: 'compiled-only',
        via: 'bundle-search',
        compiled,
        ...(ambiguous ? { matchCount: found.matchCount } : {}),
        detail: `Found in the bundle, which ships no source map, so the original file is unknown.${ambiguityNote}`,
      },
    };
  }

  let original: ReturnType<typeof lookupOriginal>;
  try {
    original = lookupOriginal(map, found.line, found.column);
  } catch (error) {
    const reason = error instanceof SourceMapError ? error.message : 'the source map is unusable';
    return {
      source: {
        name,
        status: 'map-error',
        via: 'bundle-search',
        compiled,
        ...(ambiguous ? { matchCount: found.matchCount } : {}),
        detail: `Found in the bundle, but ${reason}.${ambiguityNote}`,
      },
    };
  }

  if (!original) {
    return {
      source: {
        name,
        status: 'map-error',
        via: 'bundle-search',
        compiled,
        ...(ambiguous ? { matchCount: found.matchCount } : {}),
        detail: `Found in the bundle, but its source map has no mapping covering that position.${ambiguityNote}`,
      },
    };
  }

  const dependency = isDependencyPath(original.source);

  return {
    source: {
      name,
      status: uncertain ? 'ambiguous' : 'resolved',
      via: 'bundle-search',
      source: original.source,
      line: original.line,
      column: original.column,
      ...(isAbsolutePath(original.source) ? { absolutePath: original.source } : {}),
      ...(dependency ? { dependency: true } : {}),
      compiled,
      ...(ambiguous ? { matchCount: found.matchCount } : {}),
      ...(ambiguous
        ? { detail: `Matched in ${found.matchCount} places; this is the first. The path may be the wrong one.` }
        : {}),
      ...(unswept
        ? { detail: `Matched here, but the search did not finish.${partialNote}` }
        : {}),
    },
  };
}

// ── The pass ─────────────────────────────────────────────────────────────────

/** Components this pass should attempt, in a stable order. */
function selectPending(input: ResolveInput): string[] {
  const ids: string[] = [];

  for (const [id, needle] of Object.entries(input.needles)) {
    const entry = input.components[id];
    if (!entry) continue;

    if (entry.status === 'pending') {
      ids.push(id);
      continue;
    }

    // A component that was not found is worth searching again only once the
    // page has loaded scripts it has not already been searched against —
    // otherwise every pass would redo the same fruitless scan of every bundle.
    if (entry.status === 'not-found' || entry.status === 'unfetchable') {
      const available = scriptsForPage(input.scripts, needle.pageUrl).length;
      if (available > (needle.searched ?? 0)) ids.push(id);
    }
  }

  return ids.sort();
}

/**
 * Resolves everything pending, or as much of it as the budget allows.
 *
 * The deadline is per pass rather than per flow. Cumulative time across passes
 * cannot be tracked without persisting it through worker deaths, and it does not
 * need to be: a pass only ever retries a component when the inventory has grown
 * under it, so the work is bounded by what the page actually loads.
 */
export async function resolvePending(
  input: ResolveInput,
  deps: ResolveDeps = defaultDeps,
): Promise<ResolveOutput> {
  const components = { ...input.components };
  const needles = { ...input.needles };

  const ids = input.disabled ? [] : selectPending(input);
  if (ids.length === 0) {
    return finish(components, needles, input, false);
  }

  const deadline = deps.now() + (input.budgetMs ?? MAX_RESOLVE_MS_PER_FLOW);
  const limits = input.limits ?? DEFAULT_RESOLVE_LIMITS;
  let changed = false;
  let next = 0;

  const workers = Array.from({ length: Math.min(limits.concurrency, ids.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= ids.length) return;
      if (deps.now() > deadline) return;

      const id = ids[index];
      const needle = needles[id];
      const entry = components[id];
      if (!needle || !entry) continue;

      const urls = scriptsForPage(input.scripts, needle.pageUrl);

      let outcome: ResolveOutcome;
      try {
        outcome = await resolveOne(entry, needle, urls, deps, deadline, limits);
      } catch (error) {
        // A bug in here must cost one component its path, not the whole pass.
        outcome = {
          source: {
            name: entry.name,
            status: 'map-error' as const,
            detail: `Resolution failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }

      // The pass ran out of budget mid-component. Writing anything here — even
      // the entry it started with — would replace "still queued" with a verdict,
      // so both the entry and its needle are left untouched for the next pass.
      if (outcome.unchanged) continue;

      components[id] = outcome.source;
      changed = true;

      if (outcome.retryAfter === undefined) {
        // A terminal answer. The needle is 200 characters of the site's own
        // source and has now done its only job, so it goes.
        delete needles[id];
      } else {
        // `searched` records the inventory size this answer was reached with, so
        // the next pass can tell "already looked everywhere" from "the page has
        // loaded more since". Zero means retry unconditionally.
        needles[id] = { ...needle, searched: outcome.retryAfter };
      }
    }
  });

  await Promise.all(workers);

  return finish(components, needles, input, changed);
}

/**
 * On the last pass, says plainly what was left over.
 *
 * A component still reading `pending` after the flow has been sent is a lie by
 * omission — nothing is going to happen next. `skipped` plus a sentence tells
 * whoever reads the flow that the name is all there is and why.
 */
function finish(
  components: Record<string, ComponentSource>,
  needles: Record<string, ComponentNeedle>,
  input: ResolveInput,
  changed: boolean,
): ResolveOutput {
  if (!input.final) return { components, needles, changed };

  let touched = changed;

  const detail = input.disabled
    ? 'Finding source files is switched off in FlowSnap settings.'
    : 'The flow finished before this component could be looked up.';

  for (const [id, entry] of Object.entries(components)) {
    if (entry.status !== 'pending') continue;
    components[id] = {
      name: entry.name,
      status: 'skipped',
      detail,
    };
    delete needles[id];
    touched = true;
  }

  return { components, needles, changed: touched };
}
