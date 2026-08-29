/**
 * One contract, two implementations.
 *
 * `BundleProvider` is the single seam the merge needed, and its whole value is
 * that the React engine cannot tell which side of it is answering. So the
 * interesting tests are not "does the worker cache" and "does the panel cache" —
 * they are the three promises `core/react/provider.ts` makes, asserted against
 * both implementations by the same code:
 *
 *   - **Every method resolves, never rejects.** Unreadable is `null`, and `null`
 *     is an ordinary outcome — a cross-origin script with no CORS headers, a
 *     chunk that 404s after a deploy, a resource over the size cap. Callers
 *     report *why* a component has no source; they do not catch. A provider that
 *     threw would take a whole resolve pass with it, so this is asserted for a
 *     missing URL *and* for a read that throws outright.
 *   - **Idempotent and re-entrant.** An MV3 worker is killed whenever Chrome
 *     likes and a panel can ask from two views at once. Twice with the same
 *     argument must be safe, and cheap.
 *   - **The budget is honoured.** All five numbers, because before the merge
 *     the panel hardcoded `FETCH_CONCURRENCY = 6` while the worker read
 *     `react.resolveConcurrency`, and a `BundleBudget` that one implementation
 *     quietly ignored would put them straight back to being two numbers.
 *
 * A shared block asserts the contract; the two blocks after it cover what is
 * genuinely different — where each one gets its script list, and the DevTools
 * cache the panel prefers to a fetch.
 */
import { describe, expect, it } from 'vitest';
import type { BundleBudget, BundleProvider } from '../src/core/react/provider.js';
import { createDevtoolsProvider } from '../src/features/react/providers/devtools.js';
import { bundleBudget, createWorkerProvider } from '../src/features/react/providers/worker.js';
import { resolve as resolveSettings } from '../src/features/settings/resolve.js';
import { flowError } from '../src/shared/errors.js';
import { err, ok, type Result } from '../src/shared/result.js';

/** The shipped budget, derived from the field table rather than retyped. */
function budget(overrides: Partial<BundleBudget> = {}): BundleBudget {
  return { ...bundleBudget(resolveSettings({})), ...overrides };
}

const A = 'https://shop.test/assets/a.js';
const B = 'https://shop.test/assets/b.js';
const C = 'https://shop.test/assets/c.js';
const MAP = 'https://shop.test/assets/a.js.map';
const MISSING = 'https://shop.test/assets/gone.js';

/**
 * The world on the far side of the provider, and a record of what it was asked.
 *
 * Both surfaces are driven through this one object so that "the budget is
 * honoured" means the same assertion for both. `hold()` parks every read until
 * `releaseAll()`, which is the only way to observe a concurrency limit: without
 * it every read finishes before the next begins and a gate of 1 looks identical
 * to a gate of 64.
 */
function createWorld(files: Record<string, string>) {
  const reads: string[] = [];
  const caps: number[] = [];
  const parked: (() => void)[] = [];
  let inFlight = 0;
  let peak = 0;
  let holding = false;
  let throwOn: string | null = null;

  async function read(url: string, maxBytes: number): Promise<string | null> {
    reads.push(url);
    caps.push(maxBytes);
    inFlight++;
    peak = Math.max(peak, inFlight);

    try {
      if (holding) await new Promise<void>((resolve) => parked.push(resolve));
      else await Promise.resolve();

      if (url === throwOn) throw new Error('the world is on fire');

      const text = files[url];
      if (text === undefined) return null;
      return text.length > maxBytes ? null : text;
    } finally {
      inFlight--;
    }
  }

  return {
    read,
    reads,
    caps,
    get peak() {
      return peak;
    },
    hold() {
      holding = true;
    },
    releaseAll() {
      holding = false;
      for (const resume of parked.splice(0)) resume();
    },
    throwFor(url: string) {
      throwOn = url;
    },
  };
}

type World = ReturnType<typeof createWorld>;

/** What both providers have beyond the interface, and all this file needs of it. */
type Provider = BundleProvider & { clear(): void };

interface Surface {
  name: string;
  create(bundle: BundleBudget, world: World): Provider;
}

function asResult(text: string | null, url: string): Result<string> {
  return text === null ? err(flowError('RESOURCE_UNFETCHABLE', url)) : ok(text);
}

const SURFACES: Surface[] = [
  {
    name: 'WorkerProvider',
    create: (bundle, world) =>
      createWorkerProvider(bundle, {
        scripts: {},
        fetchText: async (url, maxBytes) => asResult(await world.read(url, maxBytes), url),
      }),
  },
  {
    name: 'DevtoolsProvider',
    create: (bundle, world) =>
      createDevtoolsProvider(bundle, {
        // Empty, deliberately. This block is about the promises every read has
        // to keep, so both surfaces are driven down the same path — the panel's
        // own DevTools-cache path is covered on its own further down.
        listResources: () => Promise.resolve([]),
        readResource: () => Promise.resolve(null),
        fetchText: async (url, maxBytes) => asResult(await world.read(url, maxBytes), url),
      }),
  },
];

for (const surface of SURFACES) {
  describe(`${surface.name} — the BundleProvider contract`, () => {
    describe('every method resolves, never rejects', () => {
      it('answers null for a URL it cannot read', async () => {
        const world = createWorld({});
        const provider = surface.create(budget(), world);

        await expect(provider.loadScript(MISSING)).resolves.toBeNull();
        await expect(provider.loadUrl(MISSING)).resolves.toBeNull();
      });

      it('answers null even when the read throws outright', async () => {
        // Not a hypothetical: `chrome.devtools` callbacks and `fetch` both
        // reject on a page that navigated mid-read. A provider that let that
        // through would fail a whole resolve pass rather than one component.
        const world = createWorld({ [A]: 'var a=1;' });
        world.throwFor(A);
        const provider = surface.create(budget(), world);

        await expect(provider.loadScript(A)).resolves.toBeNull();
      });

      it('answers null rather than throwing for a listing it cannot make', async () => {
        const world = createWorld({});
        const provider = surface.create(budget(), world);

        await expect(provider.listScripts('https://shop.test/')).resolves.toEqual([]);
      });
    });

    describe('idempotent and re-entrant', () => {
      it('reads a bundle once however many times it is asked for', async () => {
        const world = createWorld({ [A]: 'var a=1;' });
        const provider = surface.create(budget(), world);

        expect(await provider.loadScript(A)).toBe('var a=1;');
        expect(await provider.loadScript(A)).toBe('var a=1;');

        expect(world.reads).toEqual([A]);
      });

      it('collapses concurrent asks for one URL into a single read', async () => {
        // Four components racing for the same bundle is the ordinary case, not
        // the edge one: a resolve pass runs `react.resolveConcurrency` of them
        // at a time over the same handful of chunks.
        const world = createWorld({ [A]: 'var a=1;' });
        const provider = surface.create(budget(), world);

        const all = await Promise.all([
          provider.loadScript(A),
          provider.loadScript(A),
          provider.loadScript(A),
        ]);

        expect(all).toEqual(['var a=1;', 'var a=1;', 'var a=1;']);
        expect(world.reads).toEqual([A]);
      });

      it('does not remember a failure, so a chunk that 404s once can load later', async () => {
        // The recorder writes an unreadable bundle down with `retryAfter: 0`
        // precisely because "a bundle that would not load once may load on the
        // next pass". A worker-lived negative cache would make that a lie, and
        // the component would stay unresolvable for the life of the worker.
        const files: Record<string, string> = {};
        const world = createWorld(files);
        const provider = surface.create(budget(), world);

        expect(await provider.loadScript(A)).toBeNull();
        files[A] = 'var a=1;';
        expect(await provider.loadScript(A)).toBe('var a=1;');

        expect(world.reads).toEqual([A, A]);
      });

      it('forgets everything on clear(), so a purge really purges', async () => {
        const world = createWorld({ [A]: 'var a=1;' });
        const provider = surface.create(budget(), world);

        await provider.loadScript(A);
        provider.clear();
        await provider.loadScript(A);

        expect(world.reads).toEqual([A, A]);
      });
    });

    describe('the budget is honoured', () => {
      it('reads at most `concurrency` bundles at once', async () => {
        const world = createWorld({ [A]: 'a', [B]: 'b', [C]: 'c' });
        const provider = surface.create(budget({ concurrency: 2 }), world);
        world.hold();

        const all = Promise.all([
          provider.loadScript(A),
          provider.loadScript(B),
          provider.loadScript(C),
        ]);

        // Two started, one waiting on the gate — not three racing for the
        // page's own connections while somebody is still recording on it.
        await Promise.resolve();
        expect(world.peak).toBe(2);

        world.releaseAll();
        await all;
        world.releaseAll(); // the third started only after a slot freed up
        await all;

        expect(world.peak).toBe(2);
      });

      it('lets a raised concurrency through rather than deadlocking on the old one', async () => {
        // The gate is re-pointed when a setting changes, and a waiter parked
        // under the old limit has to be woken by that, not only by a completion.
        const world = createWorld({ [A]: 'a', [B]: 'b' });
        const bundle = budget({ concurrency: 1 });
        const provider = surface.create(bundle, world);
        world.hold();

        const all = Promise.all([provider.loadScript(A), provider.loadScript(B)]);
        await Promise.resolve();
        expect(world.peak).toBe(1);

        world.releaseAll();
        await all;
        expect(world.reads).toEqual([A, B]);
      });

      it('asks for a script under maxResourceBytes and a map under maxMapBytes', async () => {
        // Two different caps for two different things, and the only way to tell
        // them apart from outside is which number reaches the read. Before the
        // merge the panel had one hardcoded constant for both and no map cap at
        // all — `react.maxMapBytes` had no equivalent on that side.
        const world = createWorld({ [A]: 'a', [MAP]: '{}' });
        const bundle = budget({ maxResourceBytes: 1_000, maxMapBytes: 2_000 });
        const provider = surface.create(bundle, world);

        await provider.loadScript(A);
        await provider.loadUrl(MAP);

        expect(world.caps).toEqual([1_000, 2_000]);
      });

      it('holds no more than `cacheEntries` bundle texts', async () => {
        const world = createWorld({ [A]: 'a', [B]: 'b', [C]: 'c' });
        const provider = surface.create(budget({ cacheEntries: 2 }), world);

        await provider.loadScript(A);
        await provider.loadScript(B);
        await provider.loadScript(C); // three into two slots — A, the oldest, goes
        expect(world.reads).toEqual([A, B, C]);

        // Only the oldest went: the other two are still free.
        await provider.loadScript(B);
        await provider.loadScript(C);
        expect(world.reads).toEqual([A, B, C]);

        await provider.loadScript(A);
        expect(world.reads).toEqual([A, B, C, A]);
      });

      it('holds no more than `cacheBytes` of them', async () => {
        // The ceiling that matters most: an MV3 worker that overruns its memory
        // is killed outright, with no warning and the resolution in flight lost.
        const world = createWorld({ [A]: 'aaaa', [B]: 'bbbb' });
        const provider = surface.create(budget({ cacheBytes: 6 }), world);

        await provider.loadScript(A);
        await provider.loadScript(B); // 8 bytes together — A goes
        await provider.loadScript(A);

        expect(world.reads).toEqual([A, B, A]);
      });

      it('still returns a text too large to keep, rather than pretending it failed', async () => {
        // It was read successfully; it just is not worth a cache slot it would
        // empty. Refusing to *return* it would report a size cap as a missing
        // source, which is the confident wrong answer, not the honest one.
        const world = createWorld({ [A]: 'aaaaaaaaaa' });
        const provider = surface.create(budget({ cacheBytes: 4 }), world);

        expect(await provider.loadScript(A)).toBe('aaaaaaaaaa');
        expect(await provider.loadScript(A)).toBe('aaaaaaaaaa');
        expect(world.reads).toEqual([A, A]);
      });
    });
  });
}

// ── What is genuinely different ──────────────────────────────────────────────

describe('WorkerProvider — where its script list comes from', () => {
  it('answers from the inventory snapshot it was built with', async () => {
    const provider = createWorkerProvider(budget(), {
      scripts: { 'https://shop.test': [A, B] },
      fetchText: () => Promise.resolve(err(flowError('RESOURCE_UNFETCHABLE'))),
    });

    expect(await provider.listScripts('https://shop.test/products/42')).toEqual([A, B]);
  });

  it('is keyed by origin, so an SPA route change does not lose the chunks', async () => {
    const provider = createWorkerProvider(budget(), {
      scripts: { 'https://shop.test': [A] },
      fetchText: () => Promise.resolve(err(flowError('RESOURCE_UNFETCHABLE'))),
    });

    expect(await provider.listScripts('https://shop.test/cart')).toEqual([A]);
    expect(await provider.listScripts('https://other.test/')).toEqual([]);
  });

  it('reads the inventory itself when nobody handed it one', async () => {
    // This is the popup's locate path: it holds a tab, not a resolve pass, so it
    // has no snapshot to pass and the provider has to go and look.
    const provider = createWorkerProvider(budget(), {
      readInventory: () => Promise.resolve({ 'https://shop.test': [C] }),
      fetchText: () => Promise.resolve(err(flowError('RESOURCE_UNFETCHABLE'))),
    });

    expect(await provider.listScripts('https://shop.test/')).toEqual([C]);
  });

  it('keeps its cache across a retarget, which is why the worker holds one', async () => {
    const world = createWorld({ [A]: 'var a=1;' });
    const provider = createWorkerProvider(budget(), {
      scripts: {},
      fetchText: async (url, maxBytes) => asResult(await world.read(url, maxBytes), url),
    });

    await provider.loadScript(A);
    provider.retarget(budget({ concurrency: 8 }), { 'https://shop.test': [A] });
    await provider.loadScript(A);

    expect(world.reads).toEqual([A]);
    expect(await provider.listScripts('https://shop.test/')).toEqual([A]);
  });
});

describe('DevtoolsProvider — the DevTools cache', () => {
  function resource(url: string, content: string | null): chrome.devtools.inspectedWindow.Resource {
    return {
      url,
      getContent: (callback: (content: string, encoding: string) => void) => {
        callback(content ?? '', '');
      },
    } as unknown as chrome.devtools.inspectedWindow.Resource;
  }

  function panel(
    resources: chrome.devtools.inspectedWindow.Resource[],
    cached: Record<string, string>,
    world: World,
    overrides: Partial<BundleBudget> = {},
  ) {
    return createDevtoolsProvider(budget(overrides), {
      listResources: () => Promise.resolve(resources),
      readResource: (r) => Promise.resolve(cached[r.url] ?? null),
      fetchText: async (url, maxBytes) => asResult(await world.read(url, maxBytes), url),
    });
  }

  it('lists only what could hold the page\'s code, in order and without duplicates', async () => {
    const world = createWorld({});
    const provider = panel(
      [
        resource(A, null),
        resource('https://shop.test/logo.png', null),
        resource('chrome-extension://abc/content.js', null),
        resource(A, null),
        resource(B, null),
      ],
      {},
      world,
    );

    expect(await provider.listScripts('https://shop.test/')).toEqual([A, B]);
  });

  it('keeps file: URLs the worker cannot touch', async () => {
    // A build served off disk. The worker refuses the scheme because it could
    // never re-fetch it; DevTools already has the text, so the panel can still
    // locate a component in it.
    const local = 'file:///Users/me/shop/dist/app.js';
    const world = createWorld({});
    const provider = panel([resource(local, 'var a=1;')], { [local]: 'var a=1;' }, world);

    expect(await provider.listScripts('file:///Users/me/shop/index.html')).toEqual([local]);
    expect(await provider.loadScript(local)).toBe('var a=1;');
    // And nothing was fetched, which is the point — a fetch would have refused
    // the scheme and reported a readable file as unreadable.
    expect(world.reads).toEqual([]);
  });

  it('prefers the cache to a fetch — the whole reason this provider exists', async () => {
    const world = createWorld({ [A]: 'from the network' });
    const provider = panel([resource(A, 'from the cache')], { [A]: 'from the cache' }, world);

    await provider.listScripts('https://shop.test/');

    expect(await provider.loadScript(A)).toBe('from the cache');
    expect(world.reads).toEqual([]);
  });

  it('falls back to a fetch when the cache has a record but no body', async () => {
    const world = createWorld({ [A]: 'from the network' });
    const provider = panel([resource(A, null)], {}, world);

    await provider.listScripts('https://shop.test/');

    expect(await provider.loadScript(A)).toBe('from the network');
    expect(world.reads).toEqual([A]);
  });

  it('fetches a URL it was never given a handle for', async () => {
    // A source map, or a bundle listed before a navigation. There is no way to
    // call `getContent` on a resource the panel has not seen, and failing here
    // would make a locate depend on whether a listing happened to run first.
    const world = createWorld({ [MAP]: '{"version":3}' });
    const provider = panel([], {}, world);

    expect(await provider.loadUrl(MAP)).toBe('{"version":3}');
  });

  it('refuses cached text over maxResourceBytes, same as a fetch would', async () => {
    // `getContent` has no size limit of its own, and the setting has to mean the
    // same thing on both surfaces or it means nothing. Nothing is fetched
    // instead: the resource was read, and it is too big either way.
    const huge = 'x'.repeat(50);
    const world = createWorld({});
    const provider = panel([resource(A, huge)], { [A]: huge }, world, { maxResourceBytes: 10 });

    await provider.listScripts('https://shop.test/');
    expect(await provider.loadScript(A)).toBeNull();
    expect(world.reads).toEqual([A]);
  });
});
