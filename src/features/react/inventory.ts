/**
 * Which scripts a page loaded, so the resolver knows what to search.
 *
 * react-source-locator gets this for free from
 * `chrome.devtools.inspectedWindow.getResources()`. FlowSnap has no DevTools
 * page, so the page itself reports what it loaded — a `PerformanceObserver` on
 * `resource` entries plus `document.scripts` — and this module folds those
 * deltas into something the worker can keep.
 *
 * The URL filters are ported from react-source-locator `src/core/resources.ts`
 * @ 6eb7a30 (`isLikelyScript`, `isSearchableUrl`).
 *
 * **Divergence from the plan: the inventory is keyed by origin, not by document
 * URL.** A single-page app changes its URL by `pushState` without loading a new
 * document, so a document-URL key would file a chunk under the route that
 * happened to be showing when it loaded and then fail to find it from the route
 * that used it. Origin is the granularity bundles are actually served at, and
 * over-searching costs a cache-warm fetch while under-searching costs the
 * answer. Component ids are content hashes, so nothing collides across origins.
 *
 * Pure — no Chrome. The worker owns the storage read and write.
 */

import { MAX_SCRIPTS_PER_ORIGIN } from '../../shared/constants.js';

/**
 * True when a URL looks like it serves JavaScript.
 *
 * Extensionless URLs are kept: plenty of apps serve bundles from paths like
 * `/_next/static/chunk`. What this excludes is images and fonts, which would
 * otherwise be downloaded whole so `indexOf` could run over decoded PNG bytes.
 */
export function isLikelyScript(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }

  const dot = pathname.lastIndexOf('.');
  const slash = pathname.lastIndexOf('/');
  if (dot === -1 || dot < slash) return true; // no extension — could be a bundle

  const ext = pathname.slice(dot + 1).toLowerCase();
  return ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx' || ext === 'ts' || ext === 'tsx';
}

/**
 * Only page-served schemes can hold the app's code.
 *
 * `chrome-extension:` scripts belong to other extensions, and `blob:` and
 * `data:` bundles cannot be re-fetched from the worker at all — the worker has
 * no access to the page's blob registry, so a fetch would fail well after the
 * component had been queued.
 */
export function isSearchableUrl(url: string): boolean {
  return url.startsWith('http:') || url.startsWith('https:');
}

/**
 * The key a page's scripts are filed under.
 *
 * Empty for anything without a real origin — an unparseable URL, but also
 * `about:blank` and `data:`, which parse fine and report the *string* `"null"`.
 * Filing under that would pool every opaque page in a session into one bucket.
 */
export function inventoryKey(pageUrl: string): string {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return '';
  }
  return origin && origin !== 'null' ? origin : '';
}

export interface InventoryMerge {
  scripts: Record<string, string[]>;
  /** False when every URL was already known — the caller then skips the write. */
  changed: boolean;
}

/**
 * Adds newly seen script URLs to the inventory.
 *
 * Order is preserved and duplicates are dropped, so the resolver searches
 * bundles in the order the page loaded them — which is roughly most-likely
 * first, and is deterministic regardless of which fetch finishes when.
 */
export function mergeScripts(
  scripts: Record<string, string[]>,
  pageUrl: string,
  urls: string[],
  limit = MAX_SCRIPTS_PER_ORIGIN,
): InventoryMerge {
  const key = inventoryKey(pageUrl);
  if (!key) return { scripts, changed: false };

  const existing = scripts[key] ?? [];
  const seen = new Set(existing);
  const added: string[] = [];

  for (const url of urls) {
    if (existing.length + added.length >= limit) break;
    if (!isSearchableUrl(url) || !isLikelyScript(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    added.push(url);
  }

  if (added.length === 0) return { scripts, changed: false };

  return { scripts: { ...scripts, [key]: [...existing, ...added] }, changed: true };
}

/** The scripts worth searching for a component seen on `pageUrl`. */
export function scriptsForPage(scripts: Record<string, string[]>, pageUrl: string): string[] {
  return scripts[inventoryKey(pageUrl)] ?? [];
}
