/**
 * Where bundle text comes from.
 *
 * ## Why this seam exists
 *
 * "Both surfaces, one engine" needs exactly one abstraction, and this is it.
 *
 * The locator's only hard dependency on being a DevTools panel was
 * `chrome.devtools.inspectedWindow.getResources()` — the list of scripts the
 * inspected page loaded, and their text, straight out of the DevTools cache.
 * FlowSnap has no DevTools page at all, so it had already solved the same
 * problem the other way: `features/react/inventory.ts` collects script URLs from
 * the page itself (a `PerformanceObserver` over resource entries, plus
 * `document.scripts`), keyed by origin, and the worker fetches them.
 *
 * Neither is the better strategy. The DevTools cache sees scripts that loaded
 * before the extension was watching and never re-fetches them; the worker path
 * works with DevTools closed, which is the only way locating can be reachable
 * from the popup. So both survive, behind this interface, and every consumer of
 * the React engine takes one as an argument.
 *
 * ## The contract
 *
 * - **Caching is the provider's job, not the core's.** This is D4. `src/core/`
 *   is bundled into `mcp-server/core.js` for a Node process with no `chrome`
 *   object, so a `fetch` or a `chrome.*` in here fails `npm run build:mcp` — the
 *   purity rule is CI-enforced, not a convention. The locator's two module-level
 *   caches and FlowSnap's budgeted resolver cache both move behind this
 *   interface, where each can keep the eviction policy its surface needs.
 * - **Every method resolves, never rejects.** A bundle that cannot be read is
 *   `null`, which is an ordinary outcome: a cross-origin script with no CORS
 *   headers, a chunk that 404s after a deploy, a resource over the size cap.
 *   Callers report *why* a component has no source; they do not catch.
 * - **Idempotent and re-entrant.** An MV3 worker is killed whenever Chrome likes,
 *   and a panel can ask for the same bundle from two views at once. Calling any
 *   method twice with the same argument must be safe and should be cheap.
 * - **Budgets live in the implementation.** Concurrency, resource size caps and
 *   cache ceilings are settings (`react.resolveConcurrency`,
 *   `react.maxResourceBytes`, `react.maxMapBytes`, `react.bundleCacheEntries`,
 *   `react.bundleCacheBytes`) — see `BundleBudget` below. The core never sees
 *   them, which is why it never needed to know how the text arrived.
 *
 * Frozen in Wave 0. Implemented in W1·B as `DevtoolsProvider` and
 * `WorkerProvider`; consumed by B, G, H and K.
 *
 * Pure — no DOM, no Chrome, no network.
 */

export interface BundleProvider {
  /** Candidate bundle URLs for a page, in load order. */
  listScripts(pageUrl: string): Promise<string[]>;
  /** Bundle text, or null when it cannot be read. Caching is the provider's job. */
  loadScript(url: string): Promise<string | null>;
  /** A bare URL — a source map. Same caching contract. */
  loadUrl(url: string): Promise<string | null>;
}

/**
 * The tunables both providers read, resolved from settings by whoever builds one.
 *
 * Named here rather than in each implementation because the point of the merge
 * is that these stopped being two numbers: the locator hardcoded
 * `FETCH_CONCURRENCY = 6` while FlowSnap made the same quantity a Tier 2 setting
 * at `react.resolveConcurrency`. A provider is constructed with this, so there is
 * one place a wrong value can come from and one place to look when it does.
 */
export interface BundleBudget {
  /** Bundles fetched at once. `react.resolveConcurrency`. */
  concurrency: number;
  /** Scripts larger than this are assets, not code. `react.maxResourceBytes`. */
  maxResourceBytes: number;
  /** Source maps larger than this are skipped outright. `react.maxMapBytes`. */
  maxMapBytes: number;
  /** Bundle texts held at once. `react.bundleCacheEntries`. */
  cacheEntries: number;
  /** Total bytes those texts may occupy. `react.bundleCacheBytes`. */
  cacheBytes: number;
}
