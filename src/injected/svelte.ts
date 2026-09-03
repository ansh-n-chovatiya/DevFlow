/**
 * The Svelte adapter's DOM half: everything this unit is allowed to read off a
 * page, and nothing it does to one.
 *
 * ## Read only, and specifically read only
 *
 * This module installs nothing, patches nothing and subscribes to nothing. No
 * `addEventListener`, no `MutationObserver`, no property redefinition, no
 * `import('svelte/internal/*')`. That is a constraint with a history rather than
 * a style preference: `v3.2.0` made the trade of subscribing to a framework's
 * internals for better resolution and was reverted for it.
 *
 * Svelte makes the temptation unusually sharp, because the runtime *does* keep a
 * real component tree and it is *only* reachable from inside a running component.
 * The spike reached it exactly once, by adding an `$effect` to its own component
 * that imported the internals through a `.js` shim, and recorded two things
 * about that route: a content script in somebody else's page has no such
 * foothold, and the Svelte compiler rejects the direct version outright —
 * `` `Imports of `svelte/internal/*` are forbidden.` `` So the effect tree is
 * not reachable, would require the app's cooperation if it were, and is not
 * attempted here.
 *
 * ## Why the sweeps are capped
 *
 * Two of the five pieces of page evidence are "does *anything* on this page
 * carry X", and the honest implementation of that is a document scan. It runs on
 * the click path, so it is bounded and it stops early: the answer to "does
 * anything" is settled by the first hit, and a page with no hits at all is one
 * where the cap costs a few hundred property reads rather than a walk of a
 * hundred-thousand-node document.
 *
 * The caps are exported so a caller can raise them, and they live here rather
 * than in `src/shared/constants.ts` because this unit does not own that file —
 * see the integrator queue in this unit's report.
 *
 * ## Why `document` is a parameter
 *
 * So this can be driven in jsdom against fixtures built to the exact shapes the
 * spike printed. A module that reached for the ambient `document` would be
 * testable only by loading a browser, which is how the two other DOM-facing
 * modules in this repository ended up with the bugs their headers describe.
 */

import type { FrameworkAdapter, ResolvedChain } from '../core/locate/adapter.js';
import type { PageEvidence } from '../core/svelte/absence.js';
import { detectSvelte, resolveSvelteElement, type ResolveOptions, type SvelteGlobals } from '../core/svelte/index.js';

export { COMMENT_SCAN_LIMIT, PAGE_SCAN_LIMIT } from '../shared/constants.js';
import { COMMENT_SCAN_LIMIT, PAGE_SCAN_LIMIT } from '../shared/constants.js';

/**
 * The property Svelte's dev build writes on every element a component rendered.
 * The only own property a Svelte element has ever been measured to carry.
 */
const META_PROP = '__svelte_meta';

/**
 * The description of the symbol Svelte keys delegated event handlers under.
 *
 * Matched by description because the symbol itself is module-private to the
 * Svelte runtime and there is no way to obtain the same one from outside.
 */
const EVENTS_SYMBOL_DESCRIPTION = 'events';

/**
 * SvelteKit's hydration comment markers, measured in a production response body
 * as `[`, `]`, `[0` and `[-1` — block delimiters, unlabelled, carrying no
 * component name. They are used here purely as evidence that markup came from
 * the server, which is the whole of what they can honestly support.
 */
const HYDRATION_MARKER_RE = /^(?:\[-?\d*|\])$/;

function ownMeta(node: object): unknown {
  return Object.prototype.hasOwnProperty.call(node, META_PROP)
    ? (node as Record<string, unknown>)[META_PROP]
    : undefined;
}

function hasDelegatedEvents(node: object): boolean {
  for (const symbol of Object.getOwnPropertySymbols(node)) {
    if (symbol.description === EVENTS_SYMBOL_DESCRIPTION) return true;
  }
  return false;
}

/**
 * Whether any element carries dev metadata, and whether any carries delegated
 * events — answered in one pass because they are the same walk.
 *
 * Stops as soon as both are settled. On a dev page the first element usually
 * settles the first flag, and on a production page neither is ever set, which is
 * the case the cap is for.
 */
function sweepElements(doc: Document, limit: number): { meta: boolean; events: boolean } {
  let meta = false;
  let events = false;
  let seen = 0;

  for (const el of doc.querySelectorAll('*')) {
    if (seen++ >= limit) break;
    if (!meta && ownMeta(el) !== undefined) meta = true;
    if (!events && hasDelegatedEvents(el)) events = true;
    if (meta && events) break;
  }

  return { meta, events };
}

function hasHydrationMarkers(doc: Document, limit: number): boolean {
  const root = doc.body ?? doc.documentElement;
  if (!root) return false;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  let seen = 0;

  while (walker.nextNode()) {
    if (seen++ >= limit) return false;
    if (HYDRATION_MARKER_RE.test((walker.currentNode.nodeValue ?? '').trim())) return true;
  }
  return false;
}

/**
 * `window.__svelte.v`, SvelteKit's dev global, and the server-emitted markup
 * attribute — the three O(1) reads `detect()` is permitted.
 *
 * `versions` distinguishes an absent global from an empty `Set`, because the
 * absence is the load-bearing signal for `not-hydrated` and an empty set is not
 * the same claim.
 */
export function readSvelteGlobals(win: Window, doc: Document): SvelteGlobals {
  const global = (win as unknown as Record<string, unknown>).__svelte;
  const versions =
    typeof global === 'object' && global !== null && (global as { v?: unknown }).v instanceof Set
      ? [...((global as { v: Set<unknown> }).v)].map(String)
      : null;

  const body = doc.body as Element | null;
  const kitMarkup = body
    ? [...body.attributes].some((attr) => attr.name.startsWith('data-sveltekit-'))
    : false;

  return {
    versions,
    kitDev: '__sveltekit_dev' in (win as unknown as Record<string, unknown>),
    kitMarkup,
  };
}

export interface SvelteAdapterOptions extends ResolveOptions {
  pageScanLimit?: number;
  commentScanLimit?: number;
}

/**
 * Gathers the page-wide evidence one resolution needs.
 *
 * Kept separate from `createSvelteAdapter` so a caller resolving several
 * elements at once can read it once — it is the expensive half, and it is the
 * same answer for every element in the document.
 */
export function readPageEvidence(
  win: Window,
  doc: Document,
  options: SvelteAdapterOptions = {},
): PageEvidence {
  const globals = readSvelteGlobals(win, doc);
  const swept = sweepElements(doc, options.pageScanLimit ?? PAGE_SCAN_LIMIT);

  return {
    runtimeGlobal: globals.versions !== null,
    devMetaAnywhere: swept.meta,
    delegatedEventsAnywhere: swept.events,
    hydrationMarkers: hasHydrationMarkers(doc, options.commentScanLimit ?? COMMENT_SCAN_LIMIT),
    sveltekit: globals.kitMarkup || globals.kitDev,
  };
}

/**
 * A `FrameworkAdapter` for Svelte 5 and SvelteKit.
 *
 * `fromElement` is expensive by the contract's own permission, and it spends
 * that budget on the page sweep rather than on a bundle fetch: this adapter
 * never searches, because in development the answer is already on the element
 * and in production there is nothing to search with.
 */
export function createSvelteAdapter(
  win: Window,
  doc: Document = win.document,
  options: SvelteAdapterOptions = {},
): FrameworkAdapter {
  return {
    framework: 'svelte',

    detect: () => detectSvelte(readSvelteGlobals(win, doc)),

    fromElement: (el: Element): ResolvedChain | null =>
      resolveSvelteElement(
        { meta: ownMeta(el), page: readPageEvidence(win, doc, options) },
        options,
      ),
  };
}
