/**
 * The bundle provider that works with DevTools closed.
 *
 * One of the two implementations of `BundleProvider` (`core/react/provider.ts`,
 * frozen in Wave 0). This is FlowSnap's strategy, lifted out of
 * `features/react/resolver.ts` where it used to be four module-level variables:
 * the page reports which scripts it loaded (`inventory.ts`), and the worker
 * fetches them itself.
 *
 * It is the weaker of the two at seeing scripts — a bundle that loaded before
 * the `PerformanceObserver` was installed is only in the inventory because
 * `document.scripts` also gets swept — and the only one of the two that works
 * at all when nobody has opened DevTools. That is what makes locating reachable
 * from the popup, which is half of "either door works".
 *
 * ## What it owns, and why it is here rather than in the core
 *
 * D4: the locator's `sourcemap.ts` owned a fetch callback and two module-level
 * caches; `src/core/` is bundled into `mcp-server/core.js` for a Node process
 * with no `chrome` object, so a `fetch` there fails `npm run build:mcp`. Both
 * caches moved out to the providers, and this one keeps the eviction policy an
 * MV3 worker needs: an entry ceiling *and* a byte ceiling, because a worker that
 * overruns its memory is killed outright — no warning, no error, and the
 * resolution in flight is simply lost. That is the failure mode that makes this
 * provider the one with real budgets.
 *
 * ## The rules from the contract, and where each is kept
 *
 *   - **Never rejects.** `loadScript`/`loadUrl` resolve to `null` for every
 *     failure: a refused scheme, a 404 after a deploy, a cross-origin script
 *     with no CORS headers, a resource over the size cap. `fetchText` already
 *     returns a `Result`; the `catch` below is for the bug that has not happened
 *     yet, because a provider that throws takes a whole resolve pass with it.
 *   - **Idempotent and re-entrant.** A cache hit is free and concurrent callers
 *     for one URL share a single in-flight promise, so four components racing
 *     for the same bundle fetch it once.
 *   - **Budgets are constructor arguments.** `BundleBudget` carries all five, so
 *     `react.resolveConcurrency` and the locator's old hardcoded
 *     `FETCH_CONCURRENCY = 6` stop being two numbers.
 *
 * ## Failures are not cached, deliberately
 *
 * The locator's `contentCache` stored `''` for a resource it could not read, so
 * a bundle that failed once was unreadable for the life of the panel. The
 * recorder's whole retry story depends on the opposite: an `unfetchable`
 * component is written down with `retryAfter: 0` precisely because "a bundle
 * that would not load once may load on the next pass", and a worker-lived
 * negative cache would make that retry a lie. So a `null` is remembered only for
 * as long as the fetch is in flight. Repeating it costs an HTTP round trip that
 * `cache: 'force-cache'` usually answers from the disk cache.
 */

import { fetchText as fetchTextViaChrome } from '../../../chrome/fetch.js';
import { getLocal } from '../../../chrome/storage.js';
import type { BundleBudget, BundleProvider } from '../../../core/react/provider.js';
import type { Result } from '../../../shared/result.js';
import { load as loadSettings, type Settings } from '../../settings/index.js';
import { scriptsForPage } from '../inventory.js';

/** Reads a URL as text, refusing anything over `maxBytes`. See `chrome/fetch.ts`. */
export type FetchText = (url: string, maxBytes: number) => Promise<Result<string>>;

// ── The budget, in one place ─────────────────────────────────────────────────

/**
 * The five Tier 2 numbers, read once, from the field table.
 *
 * Both providers are constructed with the result, which is the entire point of
 * `BundleBudget`: before the merge the panel hardcoded `FETCH_CONCURRENCY = 6`
 * and a separate `MAX_RESOURCE_BYTES`, while the worker read
 * `react.resolveConcurrency` and friends from settings, and neither knew the
 * other existed. There is now one place a wrong value can come from.
 *
 * Nothing here retypes a default. `resolve()` has already clamped every one of
 * these to the field's `min`/`max`, and the defaults themselves come from
 * `shared/constants.ts` by way of `fields.ts` — see `docs/CONTRACTS.md` §3.
 *
 * It lives in this file rather than in a module of its own because the brief's
 * file list for this package is two providers and no third file; `devtools.ts`
 * imports it from here. If that ever reads as backwards, the move is to
 * `providers/budget.ts` and nothing else changes.
 */
export function bundleBudget(settings: Settings): BundleBudget {
  return {
    concurrency: settings['react.resolveConcurrency'],
    maxResourceBytes: settings['react.maxResourceBytes'],
    maxMapBytes: settings['react.maxMapBytes'],
    cacheEntries: settings['react.bundleCacheEntries'],
    cacheBytes: settings['react.bundleCacheBytes'],
  };
}

/**
 * The budget as it stands right now.
 *
 * Read live at the point a provider is built, never frozen into a recording's
 * stamp: these are questions about what this machine is willing to spend, not
 * about what the flow captured. `load()` resolves an unreadable storage area to
 * the shipped defaults, so a storage hiccup cannot quietly switch resolution
 * down to nothing.
 */
export async function loadBundleBudget(): Promise<BundleBudget> {
  return bundleBudget(await loadSettings());
}

// ── Pieces both providers share ──────────────────────────────────────────────

/**
 * Bundle text held by URL, evicted oldest-first against both ceilings.
 *
 * Exported because `DevtoolsProvider` keeps one too and a second copy of this
 * would be exactly the duplication the merge exists to delete. The two providers
 * are free to differ in eviction policy — the contract says so — and today they
 * do not, so they share the one implementation instead of drifting into two.
 *
 * A `Map` iterates in insertion order, which makes oldest-first eviction free.
 * It is not an LRU: re-reading a bundle does not renew it. Bundles are read in
 * the page's load order and a resolve pass walks that order from the top every
 * time, so recency and insertion order say the same thing here, and an LRU would
 * cost a delete-and-reinsert on every hit for no better answer.
 */
export interface BundleTextCache {
  get(url: string): string | undefined;
  put(url: string, text: string): void;
  /** Adopt a new budget, evicting immediately if it is smaller than the old one. */
  retarget(budget: BundleBudget): void;
  clear(): void;
  readonly entries: number;
  readonly bytes: number;
}

export function createBundleTextCache(budget: BundleBudget): BundleTextCache {
  const texts = new Map<string, string>();
  let held = 0;
  let limits = budget;

  function trim(): void {
    for (const [url, text] of texts) {
      if (texts.size <= limits.cacheEntries && held <= limits.cacheBytes) return;
      texts.delete(url);
      held -= text.length;
    }
  }

  return {
    get: (url) => texts.get(url),

    put(url, text) {
      // A single text bigger than the whole ceiling would evict every other
      // entry and still not fit, leaving the cache empty *and* over budget. It
      // is still returned to the caller — it was read successfully — it just is
      // not kept.
      if (text.length > limits.cacheBytes) return;

      const previous = texts.get(url);
      if (previous !== undefined) held -= previous.length;
      texts.set(url, text);
      held += text.length;
      trim();
    },

    retarget(next) {
      limits = next;
      trim();
    },

    clear() {
      texts.clear();
      held = 0;
    },

    get entries() {
      return texts.size;
    },
    get bytes() {
      return held;
    },
  };
}

/**
 * At most `concurrency` reads in flight, whoever asked for them.
 *
 * `react.resolveConcurrency` says "bundles fetched at once", and this is the
 * only place that can be true of: the resolver bounds how many *components* it
 * works on, which is a different number, and the panel loads every listed script
 * at once and had no bound at all beyond the locator's `mapWithConcurrency`
 * helper. Putting the gate in the provider means the setting means one thing on
 * both surfaces.
 *
 * The setting's own consequence text is the reason it is not simply unbounded:
 * these fetches share the page's connections, so above about eight the app's own
 * requests queue behind ours while the user is still recording.
 */
export interface FetchGate {
  run<T>(task: () => Promise<T>): Promise<T>;
  retarget(concurrency: number): void;
}

export function createFetchGate(concurrency: number): FetchGate {
  let limit = Math.max(1, concurrency);
  let active = 0;
  const waiting: (() => void)[] = [];

  function release(): void {
    active--;
    // A raised limit can let more than one waiter through at once, so this
    // drains rather than popping exactly one.
    while (active < limit && waiting.length > 0) {
      active++;
      waiting.shift()?.();
    }
  }

  return {
    async run(task) {
      if (active >= limit) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active++;
      }

      try {
        return await task();
      } finally {
        release();
      }
    },

    retarget(next) {
      limit = Math.max(1, next);
      while (active < limit && waiting.length > 0) {
        active++;
        waiting.shift()?.();
      }
    },
  };
}

/**
 * A cached, deduplicated, gated read — every `loadScript` and `loadUrl` on both
 * providers goes through one of these.
 *
 * The three contract promises live here rather than in either implementation,
 * which is what keeps them from drifting: the cache makes a repeat call cheap,
 * the in-flight map makes a concurrent one free, and the rejection handler is
 * what makes "resolves, never rejects" true of a read that throws. All the
 * implementations supply is `read` — how this particular surface gets bytes.
 */
export function createTextLoader(
  cache: BundleTextCache,
  gate: FetchGate,
): (url: string, read: () => Promise<string | null>) => Promise<string | null> {
  const inflight = new Map<string, Promise<string | null>>();

  return (url, read) => {
    const cached = cache.get(url);
    if (cached !== undefined) return Promise.resolve(cached);

    const pending = inflight.get(url);
    if (pending) return pending;

    const promise = gate
      .run(read)
      .then(
        (text) => {
          if (text !== null) cache.put(url, text);
          return text;
        },
        // The contract says this method resolves, never rejects. `fetchText`
        // and `getResourceContent` already keep that promise; this is the guard
        // for a bug in one of them, because a provider that throws fails a whole
        // resolve pass rather than one component.
        () => null,
      )
      .finally(() => inflight.delete(url));

    inflight.set(url, promise);
    return promise;
  };
}

// ── The provider ─────────────────────────────────────────────────────────────

export interface WorkerProvider extends BundleProvider {
  /**
   * Point an existing provider at this pass's budget and inventory.
   *
   * The caches survive, which is the whole reason a worker holds one provider
   * for its lifetime rather than building one per pass: resolving the eighth
   * component is nearly free because it is the same four bundles as the first,
   * and a fresh provider each pass would throw that away every time the
   * recorder's debounce fired.
   */
  retarget(budget: BundleBudget, scripts?: Record<string, string[]>): void;
  /** Drop every cached text. */
  clear(): void;
}

export interface WorkerProviderOptions {
  /**
   * This pass's inventory snapshot, if the caller already read one.
   *
   * The recorder passes the same `reactScripts` object it read alongside the
   * components and needles, because the pass's answers are recorded against the
   * inventory *size* it saw — a component that was "not found in the 3 scripts
   * the page had loaded" is only retried once there are more than 3. Reading
   * storage again mid-pass would let that number move under the answer.
   *
   * Omitted, `listScripts` reads the local area itself, which is what the
   * popup's locate path needs: it has no pass and no snapshot, just a tab.
   */
  scripts?: Record<string, string[]>;
  /** Injected by tests. Defaults to `chrome/fetch.ts`. */
  fetchText?: FetchText;
  /** Injected by tests. Defaults to reading `reactScripts` from the local area. */
  readInventory?: () => Promise<Record<string, string[]>>;
}

async function readInventoryFromStorage(): Promise<Record<string, string[]>> {
  const stored = await getLocal('reactScripts');
  return stored.ok ? (stored.value.reactScripts ?? {}) : {};
}

export function createWorkerProvider(
  budget: BundleBudget,
  options: WorkerProviderOptions = {},
): WorkerProvider {
  let limits = budget;
  let snapshot = options.scripts;

  const fetchText = options.fetchText ?? fetchTextViaChrome;
  const readInventory = options.readInventory ?? readInventoryFromStorage;

  const cache = createBundleTextCache(limits);
  const gate = createFetchGate(limits.concurrency);
  const load = createTextLoader(cache, gate);

  /**
   * One read, capped at whichever of the two size limits applies.
   *
   * The cache is keyed by URL alone, without the cap that fetched it: a text is
   * a text, and the cap only decides whether the read happens. The two caps can
   * therefore only disagree about a URL asked for as both a script and a map,
   * which no bundler produces.
   */
  function read(url: string, maxBytes: number): Promise<string | null> {
    return load(url, async () => {
      const result = await fetchText(url, maxBytes);
      return result.ok ? result.value : null;
    });
  }

  return {
    async listScripts(pageUrl) {
      const inventory = snapshot ?? (await readInventory());
      return scriptsForPage(inventory, pageUrl);
    },

    loadScript(url) {
      return read(url, limits.maxResourceBytes);
    },

    loadUrl(url) {
      return read(url, limits.maxMapBytes);
    },

    retarget(next, scripts) {
      limits = next;
      snapshot = scripts ?? snapshot;
      cache.retarget(next);
      gate.retarget(next.concurrency);
    },

    clear() {
      cache.clear();
    },
  };
}
