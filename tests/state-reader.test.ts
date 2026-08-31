// @vitest-environment jsdom
/**
 * The page-side state reader, and the one promise it exists to keep.
 *
 * The reverted attempt at this feature assigned `window.__REDUX_DEVTOOLS_EXTENSION__`
 * a non-callable object when the real extension was absent, so the classic
 * `__REDUX_DEVTOOLS_EXTENSION__ && __REDUX_DEVTOOLS_EXTENSION__()` enhancer threw
 * at boot — on every page with Redux on it, recording or not. That is why the
 * first two tests here are about *globals* rather than about state: whatever
 * DevFlow reads, the page it reads it from has to boot.
 *
 * The rest is the reading itself, built on hand-made fibers. A real React tree
 * cannot be had in jsdom without React, and what is being tested is precisely
 * the internals React does not promise — so the fixtures are the shapes this
 * module claims to understand, written out, and a fixture that stops matching
 * React is exactly the failure the module is supposed to survive by skipping.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  forgetStores,
  sampleStores,
  stateNote,
  type StateBudget,
} from '../src/injected/state.js';

const BUDGET: StateBudget = {
  maxDepth: 6,
  maxKeys: 40,
  maxEntries: 20,
  stringCap: 200,
  maxStores: 8,
};

// ── Fibers, by hand ──────────────────────────────────────────────────────────

const CONTEXT_PROVIDER = 10;
const FUNCTION_COMPONENT = 0;

interface FakeContext {
  displayName?: string;
  _currentValue?: unknown;
}

interface FakeFiber {
  tag?: number;
  type?: unknown;
  stateNode?: unknown;
  memoizedProps?: Record<string, unknown> | null;
  dependencies?: { firstContext?: unknown } | null;
  child?: FakeFiber | null;
  sibling?: FakeFiber | null;
  return?: FakeFiber | null;
  alternate?: FakeFiber | null;
}

/** A context object shaped the way React ≤18 and React 19 both leave one. */
function context(displayName?: string): FakeContext {
  return { ...(displayName ? { displayName } : {}), _currentValue: undefined };
}

/** A provider fiber for `ctx`, holding `value`, in React 19's shape. */
function provider(ctx: FakeContext, value: unknown, child?: FakeFiber | null): FakeFiber {
  return { tag: CONTEXT_PROVIDER, type: ctx, memoizedProps: { value }, child: child ?? null };
}

/**
 * A component fiber that has *read* the given contexts.
 *
 * The dependency list is React's own record of what a component consumed, and
 * building it by hand is the only way to distinguish "read the context" from
 * "was rendered underneath the provider" — which is the distinction the
 * subscriber list is entirely about.
 */
function consumer(name: string, contexts: FakeContext[], child?: FakeFiber | null): FakeFiber {
  // A distinct closure per name, so the ids the reader mints are distinct too —
  // it hashes the compiled source, and two components sharing one would share
  // an id and make the subscriber assertions meaningless.
  const fn = Object.defineProperty(() => name, 'name', { value: name });

  let first: unknown = null;
  for (const ctx of [...contexts].reverse()) first = { context: ctx, next: first };

  return {
    tag: FUNCTION_COMPONENT,
    type: fn,
    dependencies: { firstContext: first },
    child: child ?? null,
  };
}

/**
 * Mount a tree under a container the reader will find.
 *
 * The shape here is React's and getting it wrong makes the double-buffer test
 * below meaningless: there is **one** FiberRoot object per root, shared by both
 * host-root fibers, and `fiberRoot.current` is the pointer that swaps. A
 * fixture that gave each host root its own `stateNode` would let `currentOf`
 * conclude that whichever fiber it was handed is the live one, every time, and
 * the test would pass against the bug it exists to catch.
 */
interface Mounted {
  fiberRoot: { current: FakeFiber };
  hostRoot: FakeFiber;
}

function mount(child: FakeFiber): Mounted {
  const host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);

  const fiberRoot = { current: null as unknown as FakeFiber };
  const hostRoot: FakeFiber = { tag: 3, child, stateNode: fiberRoot };
  fiberRoot.current = hostRoot;
  link(hostRoot);

  (host as unknown as Record<string, unknown>)['__reactContainer$abc'] = hostRoot;
  return { fiberRoot, hostRoot };
}

/** Fill in the `return` pointers a real tree has and a literal does not. */
function link(fiber: FakeFiber): void {
  for (let node = fiber.child; node; node = node.sibling ?? null) {
    node.return = fiber;
    link(node);
  }
}

function reduxStore(state: unknown): Record<string, unknown> {
  return {
    getState: () => state,
    dispatch: () => undefined,
    subscribe: () => () => undefined,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  forgetStores();
});

afterEach(() => {
  forgetStores();
});

// ── The promise ──────────────────────────────────────────────────────────────

describe('reading state does not become part of the app', () => {
  it('leaves the Redux devtools global exactly as it found it', () => {
    const page = window as unknown as Record<string, unknown>;
    expect('__REDUX_DEVTOOLS_EXTENSION__' in page).toBe(false);

    const ctx = context('ReactRedux');
    mount(provider(ctx, { store: reduxStore({ cart: { items: 1 } }) }));
    sampleStores(BUDGET, () => 'id', true, 1000);

    // The exact expression the reverted attempt broke. It has to stay falsy —
    // not "defined but harmless": a truthy non-callable is what threw.
    expect('__REDUX_DEVTOOLS_EXTENSION__' in page).toBe(false);
    const enhancer = page.__REDUX_DEVTOOLS_EXTENSION__ as (() => unknown) | undefined;
    expect(() => enhancer && enhancer()).not.toThrow();
  });

  it('defines nothing on the page at all, whatever it read', () => {
    const before = new Set(Object.getOwnPropertyNames(window));

    const ctx = context('Theme');
    mount(provider(ctx, { mode: 'dark' }));
    sampleStores(BUDGET, () => 'id', true, 1000);
    forgetStores();

    const added = Object.getOwnPropertyNames(window).filter((key) => !before.has(key));
    expect(added).toEqual([]);
  });

  it('calls nothing on a store but its own read', () => {
    const called: string[] = [];
    const store = {
      getState: () => {
        called.push('getState');
        return { a: 1 };
      },
      dispatch: () => called.push('dispatch'),
      subscribe: () => {
        called.push('subscribe');
        return () => undefined;
      },
    };
    mount(provider(context('ReactRedux'), { store }));

    sampleStores(BUDGET, () => 'id', true, 1000);
    sampleStores(BUDGET, () => 'id', false, 1001);

    // Two samples, two reads, and never `subscribe` — which is the whole
    // difference between sampling and intercepting.
    expect(called).toEqual(['getState', 'getState']);
  });
});

// ── Recognising a store ──────────────────────────────────────────────────────

describe('what it recognises', () => {
  it('reads a Redux store through the wrapper react-redux puts it behind', () => {
    mount(provider(context('ReactRedux'), { store: reduxStore({ cart: { items: 2 } }) }));

    const [sample] = sampleStores(BUDGET, () => 'id', true, 1000);
    expect(sample?.kind).toBe('redux');
    expect(sample?.value).toEqual({ cart: { items: 2 } });
  });

  it('reads a store provided directly, not only one behind a wrapper', () => {
    mount(provider(context('Store'), reduxStore({ count: 7 })));

    const [sample] = sampleStores(BUDGET, () => 'id', true, 1000);
    expect(sample?.kind).toBe('redux');
    expect(sample?.value).toEqual({ count: 7 });
  });

  it('calls a Zustand store Zustand, not Redux, on the absence of dispatch', () => {
    mount(
      provider(context('CartStore'), {
        getState: () => ({ items: [] }),
        setState: () => undefined,
        subscribe: () => () => undefined,
      }),
    );

    const [sample] = sampleStores(BUDGET, () => 'id', true, 1000);
    expect(sample?.kind).toBe('zustand');
  });

  it('records a query cache as keys and statuses, never as the cached data', () => {
    const client = {
      getQueryCache: () => ({
        getAll: () => [
          {
            queryHash: '["orders"]',
            state: {
              status: 'error',
              fetchStatus: 'idle',
              dataUpdatedAt: 12,
              data: { secretlyEnormous: 'x'.repeat(5000) },
              error: new Error('nope'),
            },
          },
        ],
      }),
    };
    mount(provider(context('QueryClient'), client));

    const [sample] = sampleStores(BUDGET, () => 'id', true, 1000);
    expect(sample?.kind).toBe('react-query');
    expect(sample?.value).toEqual({
      '["orders"]': { status: 'error', fetchStatus: 'idle', dataUpdatedAt: 12, error: 'nope' },
    });
    // The response body is already on the step that fetched it. A second copy
    // in every later step's patch would be the largest thing in the recording.
    expect(JSON.stringify(sample?.value)).not.toContain('secretlyEnormous');
  });

  it('reads an ordinary context as itself', () => {
    mount(provider(context('Theme'), { mode: 'dark' }));

    const [sample] = sampleStores(BUDGET, () => 'id', true, 1000);
    expect(sample?.kind).toBe('context');
    expect(sample?.value).toEqual({ mode: 'dark' });
  });

  it('masks a credential a store was holding', () => {
    mount(provider(context('Auth'), { user: 'ada', accessToken: 'ya29.secret' }));

    const [sample] = sampleStores(BUDGET, () => 'id', true, 1000);
    expect(sample?.value).toEqual({ user: 'ada', accessToken: '[redacted]' });
  });
});

// ── Naming ───────────────────────────────────────────────────────────────────

describe('naming a store so the next recording agrees', () => {
  it('uses the displayName the app gave the context', () => {
    mount(provider(context('ThemeContext'), { mode: 'dark' }));
    expect(sampleStores(BUDGET, () => 'id', true, 1000)[0]?.label).toBe('ThemeContext');
  });

  it('falls back to the shape, which two recordings of one app agree on', () => {
    mount(provider(context(), { mode: 'dark', accent: 'blue' }));
    const first = sampleStores(BUDGET, () => 'id', true, 1000)[0]?.label;

    // A second recording: a new page, new fibers, new context object, same app.
    forgetStores();
    document.body.innerHTML = '';
    mount(provider(context(), { accent: 'red', mode: 'light' }));
    const second = sampleStores(BUDGET, () => 'id', true, 2000)[0]?.label;

    expect(first).toBe('{accent,mode}');
    // The label is what the knowledge graph keys a `state_keys` node on. An id
    // minted per recording would give one store a fresh node per Send.
    expect(second).toBe(first);
  });
});

// ── Subscribers ──────────────────────────────────────────────────────────────

describe('who is observed reading a store', () => {
  it('names the components whose own fibers depended on the context', () => {
    const ctx = context('Cart');
    mount(provider(ctx, { items: [] }, consumer('CartBadge', [ctx])));

    const [sample] = sampleStores(BUDGET, (_fn, name) => `id:${name}`, true, 1000);
    expect(sample?.subscribers).toEqual(['id:CartBadge']);
  });

  it('does not name a component merely rendered underneath the provider', () => {
    const ctx = context('Cart');
    // `Layout` is inside the provider's subtree and read nothing. Counting it
    // would count almost every component in the app, which answers nothing.
    mount(provider(ctx, { items: [] }, consumer('Layout', [])));

    const [sample] = sampleStores(BUDGET, (_fn, name) => `id:${name}`, true, 1000);
    expect(sample?.subscribers).toEqual([]);
  });

  it('names a component against each context it read, and no others', () => {
    const cart = context('Cart');
    const theme = context('Theme');
    const tree = provider(cart, { items: [] }, provider(theme, { mode: 'dark' }, consumer('Badge', [cart])));
    mount(tree);

    const samples = sampleStores(BUDGET, (_fn, name) => `id:${name}`, true, 1000);
    const byLabel = new Map(samples.map((sample) => [sample.label, sample.subscribers]));
    expect(byLabel.get('Cart')).toEqual(['id:Badge']);
    expect(byLabel.get('Theme')).toEqual([]);
  });
});

// ── The double buffer ────────────────────────────────────────────────────────

describe('reading a context that has re-rendered since discovery', () => {
  it('reads the live fiber, not the half of the pair discovery happened to see', () => {
    const ctx = context('Theme');
    const stale = provider(ctx, { mode: 'dark' });
    const { fiberRoot, hostRoot } = mount(stale);
    // Discovery captures `stale` while it is current.
    expect(sampleStores(BUDGET, () => 'id', true, 1000)[0]?.value).toEqual({ mode: 'dark' });

    /*
     * React re-renders the provider with a new value. The work-in-progress
     * fibers become current: a second host root, sharing the one FiberRoot, and
     * a second provider fiber paired with the first. The fiber the reader is
     * holding is now the alternate — one render behind — and a provider
     * re-renders exactly when its value changes, which is the only moment this
     * feature has anything to say.
     */
    const fresh: FakeFiber = {
      tag: CONTEXT_PROVIDER,
      type: ctx,
      memoizedProps: { value: { mode: 'light' } },
      alternate: stale,
    };
    stale.alternate = fresh;

    const freshHost: FakeFiber = { tag: 3, child: fresh, stateNode: fiberRoot, alternate: hostRoot };
    hostRoot.alternate = freshHost;
    fresh.return = freshHost;
    fiberRoot.current = freshHost;

    // Sampled without re-discovering, so this is the captured fiber answering.
    expect(sampleStores(BUDGET, () => 'id', false, 1100)[0]?.value).toEqual({ mode: 'light' });
  });
});

// ── Budgets and absence ──────────────────────────────────────────────────────

describe('bounding what it reads', () => {
  it('keeps the innermost providers when there are more than the cap allows', () => {
    const outer = context('Outer');
    const middle = context('Middle');
    const inner = context('Inner');
    mount(provider(outer, { a: 1 }, provider(middle, { b: 2 }, provider(inner, { c: 3 }))));

    const labels = sampleStores({ ...BUDGET, maxStores: 2 }, () => 'id', true, 1000).map(
      (sample) => sample.label,
    );
    // The route's own providers are nearer the leaves than the app-wide ones.
    expect(labels).toEqual(['Middle', 'Inner']);
  });

  it('marks a sample bounded when a cap bit, so the patch cannot claim completeness', () => {
    mount(provider(context('Deep'), { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }));

    const [sample] = sampleStores({ ...BUDGET, maxDepth: 2 }, () => 'id', true, 1000);
    expect(sample?.bounded).toBe(true);
  });

  it('reports a store whose read throws rather than dropping it', () => {
    mount(
      provider(context('Broken'), {
        getState: () => {
          throw new Error('torn down');
        },
        dispatch: () => undefined,
        subscribe: () => () => undefined,
      }),
    );

    const [sample] = sampleStores(BUDGET, () => 'id', true, 1000);
    // Dropped, the pair either side of it would describe different sets of
    // stores and the diff would read as a store that vanished.
    expect(sample?.value).toBeNull();
    expect(sample?.kind).toBe('redux');
  });
});

describe('saying there is nothing rather than saying nothing', () => {
  it('explains an empty page instead of leaving the gap to be misread', () => {
    sampleStores(BUDGET, () => 'id', true, 1000);
    expect(stateNote()).toMatch(/No store was found/);
  });

  it('says nothing at all once a store has been found', () => {
    mount(provider(context('Theme'), { mode: 'dark' }));
    sampleStores(BUDGET, () => 'id', true, 1000);
    expect(stateNote()).toBeUndefined();
  });
});
