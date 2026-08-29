/**
 * One interactive locate: a component somebody just picked, and the file it was
 * written in.
 *
 * ## Why this is not `features/react/resolver.ts`
 *
 * The resolver is the recorder's background pass — many components, on idle,
 * resumable across service-worker deaths, budgeted so a pathological site costs
 * a fixed amount and then stops. This is one component, now, with a person
 * watching a checklist advance. They share every piece of engine underneath
 * (`buildNeedle`, `searchBundle`, `parseSourceMap`, `lookupOriginal`, and a
 * `BundleProvider` for the bytes) and none of the pass machinery, because there
 * is no pass: no queue to select from, no retry generation to record, no
 * deadline, and nothing to leave `pending` for next time.
 *
 * Three things this path does that the resolver deliberately does not, and each
 * of them is why it exists rather than being a call into the other:
 *
 *   - **It prefers `_debugSource`.** A picked component carries whatever React
 *     recorded on the fiber, and on a development build that is the exact
 *     original position — free, with no bundle to search. The resolver never
 *     sees one: the agent has already turned it into a `ComponentSource` by the
 *     time a step is written, so it has no such branch at all.
 *   - **It keeps `sourcesContent` (D3).** The panel renders a preview of the
 *     original file, and the text to render is the text the map inlined.
 *     `parseSourceMap` defaults to dropping it, and must: a flow is handed to an
 *     AI, and inlined source is both a token disaster and a way to leak code
 *     nobody meant to send. Here it never leaves the page it is drawn on.
 *   - **It honours `react.useSourceMaps`.** That setting governs the single
 *     lookup somebody is sitting and waiting for, and off it means *stop at the
 *     bundle* — a `compiled-only` answer with a sentence saying why, not a
 *     skipped one and not a failed one. The resolver's `disabled` flag is the
 *     other switch, `reactResolve`, and means something else.
 *
 * ## What it promises
 *
 * **Never a silent absence.** Every outcome that is not a resolved path is a
 * status plus one sentence saying which of the eight things happened. That is
 * the contract `ComponentSource` carries everywhere else in the product, and it
 * is why one card can be built for three surfaces.
 *
 * **It throws only for a pick that is gone.** A component that cannot be found,
 * a bundle that will not load, a map that will not parse — all of those are
 * answers. A page that navigated out from under an armed tree is not: there is
 * nothing to report about a component that is no longer there, so the panel
 * shows its error view and offers another pick.
 *
 * No DOM and no `chrome.*`: the bytes arrive through a `BundleProvider` and the
 * page's answer through a callback, which is what lets the whole of it be driven
 * from a test with two fakes.
 */

import { isDependencyPath } from '../../core/react/classify.js';
import { buildNeedle, type Needle } from '../../core/react/needle.js';
import { toOneBased, type Pos0 } from '../../core/react/positions.js';
import type { BundleProvider } from '../../core/react/provider.js';
import { countOccurrences, searchBundle } from '../../core/react/search.js';
import {
  decodeDataUrl,
  extractSourceMappingURL,
  lookupOriginal,
  parseSourceMap,
  SourceMapError,
} from '../../core/react/sourcemap.js';
import { isAbsolutePath } from '../../core/react/table.js';
import { MAX_MATCHES_TRACKED } from '../../shared/constants.js';
import type { ComponentSource, PickedComponent } from '../../shared/types.js';
import type { StageState } from './dom.js';

/** The original file's text around the answer, when the map inlined it. */
export interface SourcePreview {
  content: string;
  /** The line the answer is on, still 0-based — `previewLines` crosses the bridge. */
  line: Pos0;
}

export interface LocateOutcome {
  /** The one shape every surface renders. */
  source: ComponentSource;
  /** How many of the page's bundles were looked at. Sharpens the ambiguity sentence. */
  resourcesSearched: number;
  preview: SourcePreview | null;
}

export interface LocateInput {
  component: PickedComponent;
  /** Whose bundles to search. The DevTools provider is already scoped to the tab. */
  pageUrl: string;
  /** `react.useSourceMaps`. */
  useSourceMaps: boolean;
  /** `react.resolveConcurrency` — the same budget every other bundle read respects. */
  concurrency: number;
}

export interface LocateDeps {
  provider: BundleProvider;
  /**
   * The picked component's compiled source, read from the page.
   *
   * A callback, so this module never learns that the answer arrives over
   * `chrome.runtime` from a MAIN-world agent two hops away. `null` means the
   * page cannot answer any more — see the header.
   */
  readSource: () => Promise<string | null>;
  /** Advances the locating checklist. Nothing is reported that did not run. */
  onStage?: (stage: 'match' | 'source', state: StageState) => void;
}

/** Thrown when the pick itself is gone. The only failure that is not a status. */
export class StalePickError extends Error {}

const STALE =
  'That component is no longer on the page — it navigated or reloaded. Pick another one.';

export async function locateComponent(
  input: LocateInput,
  deps: LocateDeps,
): Promise<LocateOutcome> {
  const { component, pageUrl, useSourceMaps, concurrency } = input;
  const { provider, onStage } = deps;
  const name = component.name;
  const debugSource = component.debugSource ?? null;

  onStage?.('match', 'active');

  // Both at once: the page's answer and the script list are independent, and one
  // waiting on the other is half the latency of a pick spent doing nothing.
  const [fnSource, urls] = await Promise.all([deps.readSource(), provider.listScripts(pageUrl)]);

  if (fnSource === null && !debugSource) throw new StalePickError(STALE);

  /*
   * React already answered.
   *
   * `_debugSource` records where the JSX element was *written*, which is an
   * exact original position needing no search at all — so the bundle work is
   * skipped rather than done and discarded. The cost is that `Open in Sources`
   * has no compiled position to reveal, which is the right trade on a build that
   * has original files to open in the first place.
   */
  if (debugSource) {
    onStage?.('match', 'done');
    onStage?.('source', 'done');
    return {
      source: {
        name,
        status: 'resolved',
        via: 'debug-source',
        source: debugSource.source,
        line: debugSource.line,
        column: debugSource.column,
        ...(isAbsolutePath(debugSource.source) ? { absolutePath: debugSource.source } : {}),
        ...(isDependencyPath(debugSource.source) ? { dependency: true } : {}),
      },
      resourcesSearched: 0,
      preview: null,
    };
  }

  // Non-null by the guard above: the only way past it without a source is the
  // `debugSource` branch, which has already returned.
  const built = buildNeedle(fnSource ?? '');
  if (!built.ok) {
    onStage?.('match', 'done');
    return {
      source: {
        name,
        status: 'not-found',
        detail:
          built.reason === 'native'
            ? 'This is a native or bound function, so there is no code for it in any bundle to look for.'
            : 'Its compiled source is too short to search for without matching unrelated code.',
      },
      resourcesSearched: 0,
      preview: null,
    };
  }

  if (urls.length === 0) {
    onStage?.('match', 'done');
    return {
      source: {
        name,
        status: 'not-found',
        detail: 'No script bundles were seen loading on that page, so there was nothing to search.',
      },
      resourcesSearched: 0,
      preview: null,
    };
  }

  const found = await searchBundles(urls, built.needle, provider, concurrency);
  onStage?.('match', 'done');

  if (found === 'unfetchable') {
    return {
      source: {
        name,
        status: 'unfetchable',
        detail: "None of the page's script bundles could be read, so its source was never searched.",
      },
      resourcesSearched: urls.length,
      preview: null,
    };
  }

  if (found === 'not-found') {
    return {
      source: {
        name,
        status: 'not-found',
        detail:
          `Not found in the ${urls.length} script${urls.length === 1 ? '' : 's'} the page had ` +
          'loaded — most likely a lazy chunk that was never fetched.',
      },
      resourcesSearched: urls.length,
      preview: null,
    };
  }

  return {
    ...(await fromBundleHit(name, found, useSourceMaps, provider, onStage)),
    resourcesSearched: urls.length,
  };
}

// ── Searching ────────────────────────────────────────────────────────────────

interface BundleMatch {
  url: string;
  line: Pos0;
  column: Pos0;
  matchCount: number;
  /** The needle that actually hit, which is the text later bundles are counted for. */
  needleText: string;
  /** Kept, because the source map annotation is at the end of it. */
  content: string;
}

/** Nothing was found, and which of the two reasons it was. */
type SearchFailure = 'not-found' | 'unfetchable';

/**
 * Walks the page's bundles in load order until the needle hits, then keeps going.
 *
 * The second half is the point. Once there is a hit, the remaining bundles are
 * still scanned for the same text — purely to find out whether the answer is
 * *unique*. A component whose code was inlined into three chunks has three
 * equally true positions, and reporting the first as fact is the confident wrong
 * answer this whole feature exists to remove.
 *
 * The sweep counts `needleText` rather than the head needle. The head is the
 * wrong text whenever the hit came from the body needle, which is precisely the
 * renamed-function case the body needle exists for: the same component compiled
 * into two chunks under two minified names shares no head, so every later chunk
 * would count zero and one of two equally likely paths would ship as unique.
 *
 * Read in batches of the configured concurrency rather than one at a time or all
 * at once. Sequentially, a forty-chunk app is forty round trips with somebody
 * watching; all at once, every bundle text on the page is alive simultaneously,
 * which `react.bundleCacheBytes` exists to stop being possible. A batch is both
 * bounded and parallel, and load order is preserved inside it because the first
 * hit in load order is the answer.
 */
async function searchBundles(
  urls: string[],
  needle: Needle,
  provider: BundleProvider,
  concurrency: number,
): Promise<BundleMatch | SearchFailure> {
  const batch = Math.max(1, Math.floor(concurrency));
  let hit: BundleMatch | null = null;
  let anyLoaded = false;

  for (let start = 0; start < urls.length; start += batch) {
    const slice = urls.slice(start, start + batch);
    const texts = await Promise.all(slice.map((url) => provider.loadScript(url)));

    for (const [offset, content] of texts.entries()) {
      // Null covers every way a bundle can be unreadable — a 404 after a deploy,
      // no CORS headers, a resource over `react.maxResourceBytes`. The provider
      // never throws, so a bundle that cannot be read simply is not searched.
      if (!content) continue;
      anyLoaded = true;

      if (hit) {
        hit.matchCount += countOccurrences(
          content,
          hit.needleText,
          MAX_MATCHES_TRACKED - hit.matchCount,
        );
        // The cap is as much as is ever tracked, so nothing further could change
        // the answer. This is a finished sweep, not an abandoned one.
        if (hit.matchCount >= MAX_MATCHES_TRACKED) return hit;
        continue;
      }

      const found = searchBundle(content, needle);
      if (!found) continue;

      hit = {
        url: slice[offset],
        line: found.line,
        column: found.column,
        matchCount: found.matchCount,
        needleText: found.needleText,
        content,
      };
      if (hit.matchCount >= MAX_MATCHES_TRACKED) return hit;
    }
  }

  if (hit) return hit;
  return anyLoaded ? 'not-found' : 'unfetchable';
}

// ── From a bundle position to a file somebody wrote ──────────────────────────

/** The caveat appended to every sentence when the code matched more than once. */
function ambiguityNote(matchCount: number): string {
  if (matchCount <= 1) return '';
  const places = matchCount >= MAX_MATCHES_TRACKED ? `${MAX_MATCHES_TRACKED} or more` : matchCount;
  return ` The same code appears in ${places} places, so this may not be the right one.`;
}

async function fromBundleHit(
  name: string,
  hit: BundleMatch,
  useSourceMaps: boolean,
  provider: BundleProvider,
  onStage: LocateDeps['onStage'],
): Promise<Omit<LocateOutcome, 'resourcesSearched'>> {
  /*
   * The compiled position stays 0-based (D1). `searchBundle` reports an offset
   * into bundle text, which is 0-based, and the only thing that ever opens it is
   * DevTools' Sources panel, whose API is 0-based too. Nothing shows this number
   * to a person without `positionToOneBased` first.
   */
  const compiled = { url: hit.url, line: hit.line, column: hit.column };
  const ambiguous = hit.matchCount > 1;
  const note = ambiguityNote(hit.matchCount);
  const counted = ambiguous ? { matchCount: hit.matchCount } : {};

  if (!useSourceMaps) {
    // Not a failure and not a skip: the bundle position *is* the answer the
    // setting asked for, and the sentence names the setting rather than leaving
    // a missing path looking like something that went wrong.
    return {
      source: {
        name,
        status: 'compiled-only',
        via: 'bundle-search',
        compiled,
        ...counted,
        detail:
          'Reading source maps is switched off, so this is the bundled file it was ' +
          `compiled into rather than the file it was written in.${note}`,
      },
      preview: null,
    };
  }

  onStage?.('source', 'active');

  let json: string;
  try {
    const loaded = await loadMapText(hit, provider);
    if (loaded === null) {
      onStage?.('source', 'done');
      return {
        source: {
          name,
          status: 'compiled-only',
          via: 'bundle-search',
          compiled,
          ...counted,
          detail: `Found in the bundle, which ships no source map, so the original file is unknown.${note}`,
        },
        preview: null,
      };
    }
    json = loaded;
  } catch (error) {
    onStage?.('source', 'done');
    return {
      source: {
        name,
        status: 'map-error',
        via: 'bundle-search',
        compiled,
        ...counted,
        detail: `Found in the bundle, but ${reasonFor(error)}. The compiled position is the best available.${note}`,
      },
      preview: null,
    };
  }

  let original: ReturnType<typeof lookupOriginal>;
  try {
    // `keepSourcesContent` — the panel's own call site, opting in (D3). This is
    // the text the preview is drawn from, and it goes no further than the page
    // it is drawn on.
    const map = parseSourceMap(json, { keepSourcesContent: true });
    original = lookupOriginal(map, hit.line, hit.column);
  } catch (error) {
    onStage?.('source', 'done');
    return {
      source: {
        name,
        status: 'map-error',
        via: 'bundle-search',
        compiled,
        ...counted,
        detail: `Found in the bundle, but ${reasonFor(error)}.${note}`,
      },
      preview: null,
    };
  }

  onStage?.('source', 'done');

  if (!original) {
    return {
      source: {
        name,
        status: 'map-error',
        via: 'bundle-search',
        compiled,
        ...counted,
        detail: `Found in the bundle, but its source map has no mapping covering that position.${note}`,
      },
      preview: null,
    };
  }

  return {
    source: {
      name,
      status: ambiguous ? 'ambiguous' : 'resolved',
      via: 'bundle-search',
      source: original.source,
      // The one bridge, applied once, where the number stops being a fact about
      // a map and starts being a fact a person and an editor read.
      line: toOneBased(original.line),
      column: toOneBased(original.column),
      ...(isAbsolutePath(original.source) ? { absolutePath: original.source } : {}),
      ...(isDependencyPath(original.source) ? { dependency: true } : {}),
      compiled,
      ...counted,
      ...(ambiguous
        ? {
            detail: `Matched in ${hit.matchCount} places; this is the first. The path may be the wrong one.`,
          }
        : {}),
    },
    preview: original.content ? { content: original.content, line: original.line } : null,
  };
}

/**
 * The bundle's source map, as text. `null` when the bundle ships none.
 *
 * Throws `SourceMapError` for a map that is announced and then cannot be had,
 * because those are different facts: a bundle with no annotation was built
 * without maps, and one whose `.map` file 404s was built with them and deployed
 * without them. The sentences the caller writes for the two are not the same.
 */
async function loadMapText(hit: BundleMatch, provider: BundleProvider): Promise<string | null> {
  const annotation = extractSourceMappingURL(hit.content);
  if (!annotation) return null;

  // Inlined by the bundler — no request, and no size guard beyond the one the
  // bundle itself already passed.
  if (annotation.startsWith('data:')) return decodeDataUrl(annotation);

  let mapUrl: string;
  try {
    mapUrl = new URL(annotation, hit.url).toString();
  } catch {
    throw new SourceMapError(`the sourceMappingURL "${annotation}" is not a resolvable URL`);
  }

  const text = await provider.loadUrl(mapUrl);
  if (text === null) {
    throw new SourceMapError('its source map could not be read — it may be missing or private');
  }
  return text;
}

function reasonFor(error: unknown): string {
  return error instanceof SourceMapError ? error.message : 'its source map could not be read';
}
