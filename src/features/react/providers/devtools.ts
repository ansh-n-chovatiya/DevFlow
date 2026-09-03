/**
 * The bundle provider that reads the DevTools cache.
 *
 * The other implementation of `BundleProvider` (`core/locate/provider.ts`, frozen
 * in Wave 0), ported from react-source-locator `src/core/resources.ts` @ 6eb7a30
 * onto the merged seam. It is the panel's, and it is better than the worker's at
 * exactly one thing, which happens to be the thing that matters most on a page
 * somebody is already debugging:
 *
 * **It sees scripts that loaded before the extension was watching.** The
 * worker's inventory is assembled from a `PerformanceObserver` plus a sweep of
 * `document.scripts`, so a bundle that was loaded and then removed from the DOM,
 * or fetched by a worker of the page's own, is simply not in it.
 * `inspectedWindow.getResources()` is DevTools' own record of everything the
 * page loaded, and `getContent()` hands back the text it already has — no second
 * request, no CORS, no size on the wire.
 *
 * ## Two things the port drops
 *
 * **The background round trip.** The locator fetched through the service worker
 * (`FETCH_CONTENT`) because it asked for `<all_urls>` at runtime through
 * `optional_host_permissions`, and only the background held the grant. DevFlow
 * holds `<all_urls>` as a static `host_permissions` grant — a superset — so the
 * panel is an extension page that can read a CDN bundle itself. One message
 * type, one background handler and one runtime permission prompt go with it.
 *
 * **The unbounded cache.** The locator's `contentCache` was a plain `Map` that
 * grew for the life of the panel, and its concurrency was a hardcoded
 * `FETCH_CONCURRENCY = 6`. Both are now `BundleBudget`, from the same five
 * settings the recorder reads — which is the point of the merge, and the reason
 * this provider and `WorkerProvider` share their cache implementation rather
 * than each keeping its own idea of how big is too big.
 *
 * ## What it keeps that the worker cannot
 *
 * `file:` URLs. The worker refuses them — `chrome/fetch.ts` will not read a
 * scheme the page chose, and it could not re-fetch a local file anyway — but
 * DevTools already has the text of a page opened off disk, so the panel can
 * still locate a component in a build somebody is serving from a folder. Only
 * the *listing* is widened: if the cache misses, the fallback fetch refuses the
 * scheme exactly as it does everywhere else, and the answer is `null`.
 */

import { fetchText as fetchTextViaChrome } from '../../../chrome/fetch.js';
import { getPageResources, getResourceContent } from '../../../chrome/devtools.js';
import type { BundleBudget, BundleProvider } from '../../../core/locate/provider.js';
import { isLikelyScript, isSearchableUrl } from '../inventory.js';
import {
  createBundleTextCache,
  createFetchGate,
  createTextLoader,
  type FetchText,
} from './worker.js';

export interface DevtoolsProvider extends BundleProvider {
  /** Adopt a new budget — the user changed a setting while the panel was open. */
  retarget(budget: BundleBudget): void;
  /** Drop every cached text and every resource handle. */
  clear(): void;
}

export interface DevtoolsProviderOptions {
  /** Injected by tests. Defaults to `chrome/devtools.ts`. */
  listResources?: () => Promise<chrome.devtools.inspectedWindow.Resource[]>;
  /** Injected by tests. Defaults to `chrome/devtools.ts`. */
  readResource?: (
    resource: chrome.devtools.inspectedWindow.Resource,
  ) => Promise<string | null>;
  /** Injected by tests. Defaults to `chrome/fetch.ts`. */
  fetchText?: FetchText;
}

/**
 * A resource URL the DevTools cache is worth asking about.
 *
 * `isSearchableUrl` is the worker's rule — only what it can re-fetch — and
 * `file:` is added on top of it here rather than inside it, because this is the
 * only surface for which it is true. Widening the shared predicate would let a
 * `file:` URL into the recorder's inventory, where every component filed under
 * it would resolve to nothing and report a fetch failure as the reason.
 */
function isDevtoolsReadable(url: string): boolean {
  return isSearchableUrl(url) || url.startsWith('file:');
}

export function createDevtoolsProvider(
  budget: BundleBudget,
  options: DevtoolsProviderOptions = {},
): DevtoolsProvider {
  let limits = budget;

  const listResources = options.listResources ?? getPageResources;
  const readResource = options.readResource ?? getResourceContent;
  const fetchText = options.fetchText ?? fetchTextViaChrome;

  const cache = createBundleTextCache(limits);
  const gate = createFetchGate(limits.concurrency);
  const load = createTextLoader(cache, gate);

  /**
   * The handle `getContent()` has to be called on, kept from the last listing.
   *
   * A `Resource` is an object with a method, not a URL, so there is no way to
   * read one the panel has not listed. A `loadScript` for a URL that is not in
   * here — a source map's own bundle after a navigation, say — falls through to
   * a fetch rather than failing, which is also the locator's behaviour when the
   * cache misses.
   */
  const handles = new Map<string, chrome.devtools.inspectedWindow.Resource>();

  /**
   * The cap applies to text out of the DevTools cache too, not only to fetches.
   *
   * `getContent` has no size limit of its own and a sourcemap-laden vendor chunk
   * can be tens of megabytes. The panel is a DevTools page, not a service
   * worker, so it is not killed for holding it — but `indexOf` over 40 MB per
   * component is the cost `react.maxResourceBytes` exists to refuse, and the
   * setting has to mean the same thing on both surfaces or it means nothing.
   */
  function withinCap(text: string | null, maxBytes: number): string | null {
    if (text === null) return null;
    return text.length <= maxBytes ? text : null;
  }

  return {
    /**
     * The interface's `pageUrl` is not taken, and that is not an oversight.
     *
     * DevTools has already scoped `getResources()` to the inspected window, so
     * there is nothing left to filter by — and filtering by origin would be
     * actively wrong, because a page's chunks are routinely served from a CDN.
     * The parameter exists in the interface for the worker's sake: it holds one
     * inventory covering every tab of the session and has to be told which page
     * is being asked about.
     */
    async listScripts() {
      const resources = await listResources();
      const urls: string[] = [];
      const seen = new Set<string>();

      for (const resource of resources) {
        const url = resource.url ?? '';
        if (!isDevtoolsReadable(url) || !isLikelyScript(url)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        // The newest handle for a URL wins: a reloaded page hands out fresh
        // `Resource` objects and the old ones read from a document that is gone.
        handles.set(url, resource);
        urls.push(url);
      }

      return urls;
    },

    /**
     * The DevTools cache first, a fetch second.
     *
     * The fallback is what covers a script DevTools has a record of but no body
     * for — the common case being a resource evicted from the cache, or one
     * loaded before the DevTools window itself opened.
     */
    loadScript(url) {
      return load(url, async () => {
        const resource = handles.get(url);
        if (resource) {
          const cached = withinCap(await readResource(resource), limits.maxResourceBytes);
          if (cached !== null) return cached;
        }
        const fetched = await fetchText(url, limits.maxResourceBytes);
        return fetched.ok ? fetched.value : null;
      });
    },

    /**
     * A bare URL — a source map — is always fetched.
     *
     * Bundlers emit `.map` files the page never requests, so they are not page
     * resources and DevTools has no record of them. Asking the cache first would
     * be a guaranteed miss on every lookup.
     */
    loadUrl(url) {
      return load(url, async () => {
        const fetched = await fetchText(url, limits.maxMapBytes);
        return fetched.ok ? fetched.value : null;
      });
    },

    retarget(next) {
      limits = next;
      cache.retarget(next);
      gate.retarget(next.concurrency);
    },

    clear() {
      cache.clear();
      handles.clear();
    },
  };
}
