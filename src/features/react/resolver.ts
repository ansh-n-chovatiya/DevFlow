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
 *     page's patched `fetch`/`XHR` never see them and DevFlow cannot end up
 *     recording itself.
 *
 * ## Where the bytes come from (D4)
 *
 * Nothing in here fetches any more. Reading a bundle and reading a source map
 * are both `BundleProvider` calls (`core/locate/provider.ts`, frozen in Wave 0),
 * and the bundle-text cache, the in-flight dedupe, the size caps and the
 * concurrency gate all moved with them into `providers/worker.ts`. That is what
 * lets the DevTools panel run this same engine over the DevTools cache instead,
 * and it is why the five Tier 2 numbers are now one `BundleBudget` rather than
 * a hardcoded 6 on one side and a setting on the other.
 *
 * The one cache still here is the parsed one, because a `PreparedMap` is a core
 * object the provider knows nothing about — it hands back text.
 *
 * **The provider is asked for text, never for the script list.** `listScripts`
 * is part of `BundleProvider` (CONTRACTS §2) and belongs to a caller holding
 * only a tab. A resolve pass instead works from the inventory snapshot it was
 * handed, because
 * every answer it writes down is recorded against *that* snapshot's size: "not
 * found in the 3 scripts the page had loaded" is only ever retried once there
 * are more than 3, and re-reading storage mid-pass would let the number move
 * underneath the answer.
 *
 * ## The 1-based edge (D1)
 *
 * `lookupOriginal` is spec-true and returns `Pos0`, because that is what a
 * source map says. This module is the recorder's existing edge to 1-based, so
 * `toOneBased()` is applied here, once, on the way into `ComponentSource.line`.
 * `compiled` does *not* cross: it is a position in a minified file that
 * DevTools' Sources panel is asked to open, and that API is 0-based too.
 */

import { isDependencyPath } from '../../core/react/classify.js';
import { pos0, toOneBased } from '../../core/locate/positions.js';
import type { BundleBudget, BundleProvider } from '../../core/locate/provider.js';
import { searchBundle, countOccurrences } from '../../core/locate/search.js';
import {
  extractSourceMappingURL,
  decodeDataUrl,
  lookupFunctionStart,
  parseSourceMap,
  SourceMapError,
  type PreparedMap,
} from '../../core/locate/sourcemap.js';
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
import { createWorkerProvider, type WorkerProvider } from './providers/worker.js';

/**
 * Everything the resolver touches outside itself, so tests need no browser.
 *
 * It used to be a `fetchText` callback; it is a whole provider now, because the
 * caching, the dedupe and the size caps that used to sit in this file went with
 * it. A test that wants to control what a bundle read returns builds a
 * `WorkerProvider` over a stub `fetchText`, which means the tests exercise the
 * real cache and the real gate rather than a second implementation of them.
 */
export interface ResolveDeps {
  provider: BundleProvider;
  now(): number;
}

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

// ── Worker-lived state ───────────────────────────────────────────────────────

/**
 * The provider this worker has been using, kept between passes.
 *
 * One provider for the life of the worker, retargeted rather than rebuilt: its
 * bundle cache is what makes resolving the eighth component nearly free — it is
 * the same four bundles as the first — and the recorder's debounce fires a pass
 * every few seconds, so a fresh provider each time would throw the cache away
 * before it ever paid for itself.
 */
let sharedProvider: WorkerProvider | null = null;

function providerFor(limits: ResolveLimits, scripts: Record<string, string[]>): WorkerProvider {
  const budget = asBundleBudget(limits);

  if (sharedProvider) sharedProvider.retarget(budget, scripts);
  else sharedProvider = createWorkerProvider(budget, { scripts });

  return sharedProvider;
}

/**
 * Parsed maps, and the failures — a map that will not parse must not be re-parsed.
 *
 * The one cache the provider cannot hold, because a `PreparedMap` is a core
 * object and a provider deals only in text. It used to be unbounded, which was a
 * slow leak with a loud ending: a `PreparedMap` keeps the whole `mappings`
 * string, `react.maxMapBytes` allows 64 MB of one, and an MV3 worker that
 * overruns its memory is killed outright with the resolution in flight simply
 * lost. It is bounded by `react.bundleCacheEntries` — the same count as the
 * bundle texts, because there is at most one map per bundle, and a second
 * setting for a number that can only ever track another one is a setting nobody
 * could reason about.
 *
 * A `SourceMapError` is remembered as readily as a map, and that is the half the
 * header claimed and the code did not do. A map that will not parse is a
 * `parseSourceMap` throw, and a throw wrote nothing down — so every one of the
 * hundred-odd components sharing that bundle re-decoded the whole `mappings`
 * string to reach the same verdict, inside a pass that has a deadline. The
 * components after the deadline are not merely slow: they are left `pending`
 * and reported as `skipped`, so an unparseable map cost a flow its component
 * table rather than costing one bundle its original paths. Only the *parse* is
 * remembered — a map that could not be fetched is not, for the reason the
 * provider caches no failures either: it may be there on the next pass.
 */
const mapCache = new Map<string, PreparedMap | null | SourceMapError>();

function rememberMap(
  bundleUrl: string,
  map: PreparedMap | null | SourceMapError,
  entries: number,
): void {
  mapCache.set(bundleUrl, map);

  // Oldest first, like the bundle cache and for the same reason: a pass walks
  // the page's bundles in load order from the top, so insertion order and
  // recency say the same thing here.
  while (mapCache.size > entries) {
    const oldest = mapCache.keys().next();
    if (oldest.done) break;
    mapCache.delete(oldest.value);
  }
}

export function clearResolverCaches(): void {
  sharedProvider?.clear();
  sharedProvider = null;
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
 *
 * **This is `BundleBudget` under older names.** The two describe exactly the
 * same five settings keys and are converted by `asBundleBudget` below, once.
 * They are not merged because `background/index.ts` builds this literal and
 * belongs to another package: renaming its fields from here would break a file
 * this session must not touch. The merge risk `BundleBudget` exists to remove is
 * two *values*, and there is still only one — both names read the same keys —
 * but the day `runResolve` switches to `bundleBudget(settings)`, `ResolveLimits`
 * and the converter should go with it.
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

/** The same five numbers, spelled the way the frozen contract spells them. */
function asBundleBudget(limits: ResolveLimits): BundleBudget {
  return {
    concurrency: limits.concurrency,
    maxResourceBytes: limits.resourceBytes,
    maxMapBytes: limits.mapBytes,
    cacheEntries: limits.cacheEntries,
    cacheBytes: limits.cacheBytes,
  };
}

// ── Resolving one component ──────────────────────────────────────────────────

/**
 * The four things every step of one component's pass needs.
 *
 * Grouped for the reason `ResolveLimits` is grouped: they travel together
 * through four functions, and threading them as positional parameters is how a
 * call site swaps two numbers and still typechecks. The deadline is in here
 * rather than recomputed because it is the *pass's* deadline — one clock reading
 * at the start, not a fresh budget per component.
 */
interface Pass {
  provider: BundleProvider;
  now(): number;
  /** The clock value past which this pass stops, whatever it has found. */
  deadline: number;
  /** `react.bundleCacheEntries`, for the parsed-map cache. */
  cacheEntries: number;
}


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
   * How much compiled text, from the reported position, is known to be this
   * component's own — the window `lookupFunctionStart` may accept a mapping in.
   *
   * Not `needleText.length`, which is what it used to be and is only right on
   * the head-needle path. A body-needle hit reports the *function start*
   * `searchBundle` walked back to, which sits up to `bodyOffset + slack`
   * characters before the matched text; measuring the window from the needle's
   * length then stopped it short by exactly that distance, and a map whose only
   * mapping for the function lay in the part that got cut off fell through to
   * `lookupOriginal` — the "segment at or before" lookup, which is the one that
   * answers with the *previous* function's file while the status still reads
   * `resolved`. That is the failure `lookupFunctionStart` was written to
   * remove, reintroduced by a short window.
   *
   * Measured rather than recomputed: it is the distance from the position
   * `searchBundle` reported to the end of the text it matched, so it stays
   * correct whatever rule that function uses to pick the start.
   */
  span: number;
  /**
   * False when the deadline cut the duplicate sweep short, so `matchCount` is a
   * lower bound rather than the answer.
   */
  swept: boolean;
}

/** The offset a 0-based line and column name in `content`, or -1. */
function offsetAt(content: string, line: number, column: number): number {
  let at = 0;
  for (let n = 0; n < line; n++) {
    const newline = content.indexOf('\n', at);
    if (newline === -1) return -1;
    at = newline + 1;
  }
  return at + column;
}

/**
 * From the reported start to the end of the matched text.
 *
 * The search starts at `start` rather than at 0, which is both cheaper and
 * exact: the reported position is at or before the hit, and the hit is the
 * first occurrence in the bundle, so nothing between them can match. A search
 * that comes back empty means the two facts do not line up — a bug rather than
 * a bundle — and the needle's own length is the answer that was given before
 * any of this, so it is what that falls back to.
 */
function spanOf(content: string, line: number, column: number, needleText: string): number {
  const start = offsetAt(content, line, column);
  if (start < 0) return needleText.length;

  const hit = content.indexOf(needleText, start);
  return hit < start ? needleText.length : hit - start + needleText.length;
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
  pass: Pass,
): Promise<SearchSuccess | SearchFailure> {
  let hit: SearchSuccess | null = null;
  let anyLoaded = false;
  let outOfTime = false;

  for (const url of urls) {
    if (pass.now() > pass.deadline) {
      outOfTime = true;
      break;
    }

    // Null covers every way a bundle can be unreadable — a 404 after a deploy,
    // no CORS headers, a resource over `react.maxResourceBytes`. The provider
    // never throws, so there is nothing to catch and nothing to distinguish:
    // a bundle that cannot be read simply is not searched.
    const content = await pass.provider.loadScript(url);
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
        span: spanOf(content, found.line, found.column, found.needleText),
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

/** Reads and parses a bundle's map. Null means the bundle ships none. */
async function loadMap(
  bundleUrl: string,
  bundleContent: string,
  pass: Pass,
): Promise<PreparedMap | null> {
  const cached = mapCache.get(bundleUrl);
  if (cached instanceof SourceMapError) throw cached;
  if (cached !== undefined) return cached;

  const annotation = extractSourceMappingURL(bundleContent);
  if (!annotation) {
    rememberMap(bundleUrl, null, pass.cacheEntries);
    return null;
  }

  /**
   * Remember a failure that cannot come out differently next time, then rethrow.
   *
   * Decoding an inlined map, resolving the annotation and parsing the JSON all
   * answer the same way however often they are asked, so the hundredth
   * component over this bundle should be told what the first one learned rather
   * than learning it again. A fetch is the one step that is not like that, and
   * is deliberately left out. Anything that is not a `SourceMapError` is a bug
   * in the decoder rather than a verdict on the map, and is not written down —
   * a transient bug must not become permanent for the life of the worker.
   */
  const permanent = (error: unknown): unknown => {
    if (error instanceof SourceMapError) rememberMap(bundleUrl, error, pass.cacheEntries);
    return error;
  };

  /** Null until the map has been fetched; a data URL is decoded below instead. */
  let json: string | null = null;

  if (!annotation.startsWith('data:')) {
    let mapUrl: string;
    try {
      mapUrl = new URL(annotation, bundleUrl).toString();
    } catch {
      throw permanent(
        new SourceMapError(`the sourceMappingURL "${annotation}" is not a resolvable URL`),
      );
    }

    const fetched = await pass.provider.loadUrl(mapUrl);
    // Not remembered, unlike everything else in here: the provider caches no
    // failure either, because a map that would not load once may load on the
    // next pass — which is the whole basis of the recorder's retry.
    if (fetched === null) {
      throw new SourceMapError('its source map could not be fetched — it may be 404 or private');
    }
    json = fetched;
  }

  let map: PreparedMap;
  try {
    /*
     * A `data:` annotation is inlined by the bundler — no request, and no size
     * guard needed beyond the one the bundle itself already passed.
     *
     * `keepSourcesContent` is left off (D3). A flow is sent to an AI, and
     * inlined original source is both a token disaster and a way to leak code
     * the user never meant to send. The panel, which renders a preview from it,
     * opts in at its own call site — the failure mode of getting this wrong is
     * a missing preview or a larger object, never a wrong path, which is
     * exactly why this one is a parameter where the line base (D1) is a type.
     */
    map = parseSourceMap(json ?? decodeDataUrl(annotation));
  } catch (error) {
    throw permanent(error);
  }

  rememberMap(bundleUrl, map, pass.cacheEntries);
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
  pass: Pass,
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

  const found = await searchForNeedle(needle, urls, pass);

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

  /*
   * The compiled position stays 0-based (D1). `searchBundle` reports an offset
   * into the bundle text, which is 0-based, and the only thing that ever opens
   * it is DevTools' Sources panel, whose API is 0-based too. The `+ 1` that used
   * to be here made this field agree with `line` below and disagree with every
   * consumer of it; the brand is what makes the two impossible to confuse now.
   */
  const compiled = { url: found.url, line: pos0(found.line), column: pos0(found.column) };
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
    map = await loadMap(found.url, found.content, pass);
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

  let original: ReturnType<typeof lookupFunctionStart>;
  try {
    /*
     * `lookupFunctionStart`, not `lookupOriginal`: `found` is the start of a
     * function, and a map need not emit a mapping there. Bounded by the text
     * that matched, so the segment accepted belongs to this function's own
     * compiled source rather than to whatever the bundler emitted before it.
     * See the header on `lookupFunctionStart` for what that cost on a real Vue
     * production build before it existed.
     */
    original = lookupFunctionStart(map, found.line, found.column, found.span);
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
      // The one bridge, applied once, at the recorder's existing 1-based edge.
      // `lookupOriginal` is spec-true and answers in the map's own base; a file
      // and a line are what a person and an editor read, and they start at 1.
      line: toOneBased(original.line),
      column: toOneBased(original.column),
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
  deps?: ResolveDeps,
): Promise<ResolveOutput> {
  const components = { ...input.components };
  const needles = { ...input.needles };

  const ids = input.disabled ? [] : selectPending(input);
  if (ids.length === 0) {
    return finish(components, needles, input, false);
  }

  const limits = input.limits ?? DEFAULT_RESOLVE_LIMITS;
  // Called through rather than lifted off `deps`: a method plucked from its
  // object loses its receiver, and `deps.now` in a test is a closure over state
  // the test is driving.
  const now = (): number => deps?.now() ?? Date.now();

  /*
   * The default provider is the worker's, retargeted to this pass rather than
   * rebuilt — see `providerFor`. A caller that supplies one (a test, or a
   * surface with a DevTools panel behind it) gets no shared state at all, which
   * is what keeps the tests independent of each other's caches.
   */
  const pass: Pass = {
    provider: deps?.provider ?? providerFor(limits, input.scripts),
    now,
    deadline: now() + (input.budgetMs ?? MAX_RESOLVE_MS_PER_FLOW),
    cacheEntries: limits.cacheEntries,
  };

  let changed = false;
  let next = 0;

  const workers = Array.from({ length: Math.min(limits.concurrency, ids.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= ids.length) return;
      if (now() > pass.deadline) return;

      const id = ids[index];
      const needle = needles[id];
      const entry = components[id];
      if (!needle || !entry) continue;

      const urls = scriptsForPage(input.scripts, needle.pageUrl);

      let outcome: ResolveOutcome;
      try {
        outcome = await resolveOne(entry, needle, urls, pass);
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
    ? '“Find the file each component was written in” is switched off in Settings.'
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
