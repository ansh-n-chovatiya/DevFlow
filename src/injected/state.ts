/**
 * Reading the app's own state, without becoming part of the app.
 *
 * ## It samples; it does not intercept
 *
 * The obvious way to record what a store did is to wrap it — patch
 * `store.dispatch`, install a devtools global, subscribe to every listener set —
 * and it is the way the reverted attempt took. It assigned
 * `window.__REDUX_DEVTOOLS_EXTENSION__` a non-callable object when the real
 * extension was absent, so the classic
 * `__REDUX_DEVTOOLS_EXTENSION__ && __REDUX_DEVTOOLS_EXTENSION__()` enhancer
 * threw at boot and broke every page with Redux on it, recording or not. That is
 * Invariant 1 — zero app dependency — failing on every app DevFlow touches, in
 * exchange for data nobody had asked for yet.
 *
 * So nothing here writes. This module **reads** two snapshots per interaction —
 * one when the interaction is dispatched, one once the app has settled — off the
 * fibers React already keeps, and computes nothing from them. It defines no
 * global, patches no method, subscribes to no store and holds no reference the
 * page can observe. "Inert when not recording" is therefore not a property this
 * file maintains; it is a property it cannot violate, because there is nothing
 * to restore and no un-restore path to get wrong. The one thing it touches
 * outside the fiber tree is `__REACT_DEVTOOLS_GLOBAL_HOOK__`, which it reads and
 * never assigns — `agent.ts` already reads it for React's version.
 *
 * The honest cost of sampling is stated in the tool that reads the result: a
 * store that changed and changed back between the two samples shows no change at
 * all. That is the trade for a recorder that cannot break the app it records.
 *
 * ## What it can see, and what it deliberately cannot
 *
 * Everything here comes through a React **context**, because a context value is
 * on the provider's fiber and a fiber is readable. That covers react-redux
 * (whose context carries the store), TanStack Query (whose context carries the
 * client), any store deliberately provided through a context, and the app's own
 * contexts.
 *
 * A module-level Zustand store — `const useStore = create(…)` with no provider —
 * is **not** read, and the flow says so (`stateNote`) rather than leaving the
 * gap to be mistaken for "nothing changed". This is a refusal, measured against
 * React 19 and Zustand 4 and 5 rather than reasoned from the shape of the
 * problem; the argument in full is in `ROADMAP_AND_PHASES.md` §1.2. The short
 * version is that the two things a consumer's fiber offers are the wrong two:
 *
 *   - The `useSyncExternalStore` hook's `queue.getSnapshot` is Zustand's
 *     per-consumer closure, not `api.getState`, so what it returns is that
 *     component's **selection**.
 *   - The effect hook after it carries `deps: [api.subscribe]`, which *is* the
 *     store's own function and *is* shared by every consumer of it — so
 *     consumers can be grouped. That is more than this comment used to claim,
 *     and it changes nothing, because grouping selections still only yields the
 *     union of whatever components were mounted. A key leaves that union when
 *     its component unmounts, so a diff over it would report a change the store
 *     never made; and the shape it presents — which is what `labelFor` keys a
 *     cross-recording name on — differs between two recordings of one store.
 *
 * `subscribes_to` and `state_keys` are complete without it, because every store
 * a subscriber can be *observed* reading is a context store anyway: a context
 * dependency is recorded on the consuming fiber, and a closure is not.
 *
 * ## Why discovery is not on the interaction path
 *
 * Finding the stores means walking the fiber tree, and the reverted "why did
 * this render" engine walked it on every commit on every page against a <2% CPU
 * budget. Here the walk happens when a recording starts and at most once every
 * `REDISCOVER_MS` afterwards, bounded by `DISCOVERY_NODE_CAP` fibers, and only
 * ever from the *settled* sample — which already runs on a timer, off the
 * gesture. What an interaction pays is one read per known store.
 */

import type { StateStoreKind } from '../shared/types.js';
import type { Fiber, ComponentFn } from '../core/react/fiber.js';
import { getDisplayName } from '../core/react/fiber.js';
import { snapshot, type SnapshotBudget } from '../core/state/snapshot.js';
import { isSecretStateKey } from '../core/redact/index.js';
import { reactRoots } from './roots.js';

/**
 * The fields of a fiber this module reads and `core/react/fiber.ts` does not.
 *
 * Declared here rather than widened onto the shared `Fiber`, because they are
 * the internals React reserves the right to move: `tag` numbering, the hook
 * list, the context dependency list. Everything that reads them is in this file,
 * so when a React version breaks one of them there is one place to look, and the
 * rest of the tree keeps the narrow `Fiber` it can rely on.
 */
interface StateFiber extends Fiber {
  tag?: number;
  memoizedProps?: Record<string, unknown> | null;
  dependencies?: { firstContext?: ContextDependency | null } | null;
  /** The other half of React's double buffer — see `currentOf`. */
  alternate?: StateFiber | null;
  child: StateFiber | null;
  sibling: StateFiber | null;
  return: StateFiber | null;
}

/** One entry of a fiber's context dependency list — a context it actually read. */
interface ContextDependency {
  context?: ReactContext | null;
  next?: ContextDependency | null;
}

/** React's context object, in the two shapes the supported versions give it. */
interface ReactContext {
  displayName?: string;
  _currentValue?: unknown;
  /** React ≤18: the provider element type carries the context under this. */
  _context?: ReactContext;
}

/**
 * `ContextProvider`. The one tag number this file depends on, and it has been
 * 10 since the fiber tags were introduced.
 *
 * Read defensively all the same: a fiber that fails the shape checks below is
 * skipped whatever its tag says, so a renumbering costs coverage rather than
 * correctness.
 */
const TAG_CONTEXT_PROVIDER = 10;

/**
 * Fibers one discovery walk may visit.
 *
 * A real app's tree is a few thousand fibers and this is a full traversal, so
 * the cap is what stops a pathological page — a virtualised table rendering
 * fifty thousand rows — from turning a background walk into a frame drop. Being
 * cut costs the providers below the cut, and providers are near the root.
 */
const DISCOVERY_NODE_CAP = 5000;

/**
 * How stale the store list may get.
 *
 * A provider can mount long after a recording starts — a route that lazy-loads
 * its own `QueryClientProvider` — and a list built once would never see it. Re-
 * walking costs one bounded traversal per interval, taken from the settled
 * sample rather than the gesture.
 */
const REDISCOVER_MS = 5000;

/** What the reader knows about one store, and how to read it again. */
interface KnownStore {
  id: string;
  kind: StateStoreKind;
  label: string;
  /** Identity across samples and across re-discoveries. */
  context: ReactContext;
  /** Reads the store's current value, or throws. */
  read: () => unknown;
  /** Component ids observed with a dependency on this context. */
  subscribers: Set<string>;
}

/** One store, sampled. */
export interface StateSample {
  id: string;
  kind: StateStoreKind;
  label: string;
  subscribers: string[];
  /** JSON-safe and bounded, or `null` when the read threw. */
  value: unknown;
  bounded: boolean;
}

/** The caps a snapshot is taken under, plus how many stores are worth keeping. */
export interface StateBudget extends Omit<SnapshotBudget, 'secretKey'> {
  maxStores: number;
}

/**
 * How this module names a component, supplied by the caller.
 *
 * `agent.ts` owns the id — it is a hash over the component's compiled source,
 * cached per function — and a second implementation here would mint ids that
 * look like the recorder's and index nothing. A subscriber list whose ids do not
 * join to `FlowReact.components` is a list of hex strings.
 */
export type Identify = (fn: ComponentFn, name: string) => string;

let stores: KnownStore[] = [];
let discoveredAt = 0;

/** Forgets the page. Called when a recording stops, and on every navigation. */
export function forgetStores(): void {
  stores = [];
  discoveredAt = 0;
}

// ── Finding the roots ────────────────────────────────────────────────────────

/*
 * The root finder used to be copied here, with a comment saying it would become
 * a module on the day a third caller wanted it. `architecture.ts` is that
 * caller, so it did — `roots.ts`, generic over the fiber type so this file keeps
 * its own `StateFiber` view rather than widening to one no caller wanted. The
 * lifecycle argument that kept the copies apart is unaffected: `roots.ts` holds
 * no state, so nothing there can be warm or cold when this module calls it.
 */

// ── Recognising a store ──────────────────────────────────────────────────────

function isFn(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** A Redux store: the three methods the contract has required since 2015. */
function reduxStore(value: unknown): Record<string, unknown> | null {
  const obj = asRecord(value);
  if (!obj) return null;
  return isFn(obj.getState) && isFn(obj.dispatch) && isFn(obj.subscribe) ? obj : null;
}

/**
 * A store held behind a wrapper, as react-redux's context holds one.
 *
 * react-redux puts `{ store, subscription }` on its context rather than the
 * store itself, and an app that provides its own store directly puts the store.
 * Both are ordinary and neither is worth a separate code path.
 */
function unwrapStore(value: unknown): Record<string, unknown> | null {
  return reduxStore(value) ?? reduxStore(asRecord(value)?.store);
}

/** A TanStack Query client. `getQueryCache` is the method the whole API hangs off. */
function queryClient(value: unknown): Record<string, unknown> | null {
  const obj = asRecord(value);
  return obj && isFn(obj.getQueryCache) ? obj : null;
}

/**
 * A Zustand store API: `getState` and `subscribe` without a `dispatch`.
 *
 * Only reached when the app provides its store through a context, which is
 * Zustand's own documented answer to per-request and per-tree stores. The
 * module-level form is not here — see the header.
 */
function zustandStore(value: unknown): Record<string, unknown> | null {
  const obj = asRecord(value);
  if (!obj) return null;
  return isFn(obj.getState) && isFn(obj.subscribe) && !isFn(obj.dispatch) ? obj : null;
}

/**
 * What a query cache is worth recording.
 *
 * Not the cached data. That is a response body, it is already on the step that
 * fetched it, and a second copy of it inside every subsequent step's state
 * patch would be the largest thing in the recording by an order of magnitude.
 * What a reader wants from the cache is the part the network calls do not say:
 * which keys exist, and what state each is in — which is exactly what turns
 * *"the list is empty"* into *"the query errored"* or *"the query is still
 * fetching"*.
 */
function queryCacheValue(client: Record<string, unknown>): unknown {
  const cache = (client.getQueryCache as () => { getAll?: () => unknown[] })();
  const all = cache?.getAll?.() ?? [];
  const out: Record<string, unknown> = {};
  for (const entry of all) {
    const query = asRecord(entry);
    const state = asRecord(query?.state);
    if (!query || !state) continue;
    let key: string;
    try {
      // `queryHash` is TanStack's own stable string for the key and is what the
      // library indexes by; the JSON of `queryKey` is the fallback for a cache
      // entry that predates it. Neither is stringified through `String` on an
      // object — a key that came back as `[object Object]` would collapse every
      // query in the cache onto one entry.
      key = typeof query.queryHash === 'string' ? query.queryHash : JSON.stringify(query.queryKey);
    } catch {
      continue;
    }
    if (typeof key !== 'string') continue;
    const error = asRecord(state.error);
    out[key] = {
      status: state.status ?? null,
      fetchStatus: state.fetchStatus ?? null,
      dataUpdatedAt: state.dataUpdatedAt ?? null,
      // The message, or nothing. An `Error` has no useful string form and an
      // arbitrary thrown value has none at all, so a store that rejected with
      // an object would otherwise record `[object Object]` as its failure.
      ...(state.error
        ? { error: typeof error?.message === 'string' ? error.message : 'unknown error' }
        : {}),
    };
  }
  return out;
}

/** The store a context provider's value holds, or null when it holds none. */
function classify(value: unknown): { kind: StateStoreKind; read: () => unknown } | null {
  const redux = unwrapStore(value);
  if (redux) return { kind: 'redux', read: () => (redux.getState as () => unknown)() };

  const client = queryClient(value);
  if (client) return { kind: 'react-query', read: () => queryCacheValue(client) };

  const zustand = zustandStore(value);
  if (zustand) return { kind: 'zustand', read: () => (zustand.getState as () => unknown)() };

  // An ordinary context. Read through the provider's own fiber rather than
  // captured here, so a re-render's new value is what the next sample sees.
  return null;
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** Top-level key names, as the fallback half of a label. */
function shapeOf(value: unknown): string {
  const obj = asRecord(value);
  if (!obj || Array.isArray(obj)) return '';
  try {
    return Object.keys(obj).sort().slice(0, 6).join(',');
  } catch {
    return '';
  }
}

/**
 * A name for a store that means the same thing in the next recording.
 *
 * `StateStoreRef.id` is stable only for the life of one recording, so the label
 * is what the knowledge graph has to key a `state_keys` node on. A context's
 * `displayName` is the good answer and most contexts do not set one, so the
 * fallback is the store's *shape* — its sorted top-level keys — which is stable
 * across reloads for the same store and different between two stores that are
 * genuinely different. Two contexts of identical shape do collide, and that is
 * the honest limit of naming a thing the app declined to name.
 */
function labelFor(kind: StateStoreKind, context: ReactContext, value: unknown): string {
  const declared = typeof context.displayName === 'string' ? context.displayName.trim() : '';
  if (declared) return declared.slice(0, 60);
  if (kind !== 'context') return kind;
  const shape = shapeOf(value);
  return shape ? `{${shape}}` : 'context';
}

/**
 * What kind of store a context value is, without reading it.
 *
 * Exported for `architecture.ts`, which names the same four kinds in the living
 * map that `subscribes_to` names in the graph, and must not invent a fifth
 * vocabulary for one question. It is `classify` with the reader thrown away:
 * every check behind it is a `typeof` on a method, so nothing is copied out of
 * the page and no budget is spent. The map carries structure and never values —
 * see the header of `core/architecture` — and this is the line that lets it say
 * "redux" without crossing that.
 */
export function classifyKind(value: unknown): StateStoreKind {
  return classify(value)?.kind ?? 'context';
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * How deep a tree this will climb to answer "is this the live fiber".
 *
 * A React tree is tens of levels, not hundreds. The cap is a guard against a
 * `return` chain that loops, which a half-torn-down tree can have, not a real
 * depth limit.
 */
const CURRENT_CLIMB_CAP = 200;

/**
 * The live half of a fiber pair.
 *
 * React keeps two fibers per element and swaps which is current on every
 * re-render of that subtree, so a provider fiber captured at discovery is the
 * *stale* one after an odd number of re-renders — and reading `memoizedProps`
 * off it would report the value from one render ago. That is the failure mode
 * that matters most here, because a provider re-renders precisely when its
 * value changes, which is the only time this module has anything to say.
 *
 * Deciding it is a climb to the host root: the root's `stateNode.current`
 * names the live tree, and a stale fiber's `return` chain terminates at the
 * host root fiber that is *not* it. Bounded by the tree's depth, paid once per
 * store per sample, and only for stores read through a fiber at all — the
 * recognised stores read through their own `getState`, which is never stale.
 */
function currentOf(fiber: StateFiber): StateFiber {
  const alternate = fiber.alternate;
  if (!alternate) return fiber;

  let node: StateFiber | null = fiber;
  for (let hops = 0; node && hops < CURRENT_CLIMB_CAP; hops++, node = node.return) {
    const root = (node.stateNode as { current?: StateFiber } | null)?.current;
    if (root) return root === node ? fiber : alternate;
  }
  // No root in reach — a detached subtree. The captured fiber is as good an
  // answer as the alternate, and guessing the other one is not better.
  return fiber;
}

/** The context a provider fiber provides, across the versions that differ. */
function contextOf(fiber: StateFiber): ReactContext | null {
  const type = fiber.type as ReactContext | undefined;
  if (!type || typeof type !== 'object') return null;
  // React ≤18 wraps the context in a provider object; React 19 renders the
  // context itself. `_currentValue` is what distinguishes the two.
  const context = type._context ?? type;
  return context && typeof context === 'object' && '_currentValue' in context ? context : null;
}

/**
 * Walk the tree, note every context provider, note who depends on which context.
 *
 * One traversal answers both halves, and they have to be one traversal: a
 * subscriber list built from a second walk would describe a tree that had
 * re-rendered in between, and a component would appear against a provider that
 * had been replaced.
 */
function discover(budget: StateBudget, identify: Identify): void {
  const found: KnownStore[] = [];
  const byContext = new Map<ReactContext, KnownStore>();
  const dependents = new Map<ReactContext, Set<string>>();
  let visited = 0;

  const walk = (start: StateFiber): void => {
    let fiber: StateFiber | null = start;
    // Explicit stack rather than recursion: a deep tree is ordinary and the
    // page's own stack is not this module's to spend.
    const stack: StateFiber[] = [];
    while (fiber || stack.length) {
      if (!fiber) {
        fiber = stack.pop() ?? null;
        continue;
      }
      if (++visited > DISCOVERY_NODE_CAP) return;

      if (fiber.tag === TAG_CONTEXT_PROVIDER) {
        const context = contextOf(fiber);
        if (context && !byContext.has(context)) {
          const provider = fiber;
          const value = provider.memoizedProps?.value;
          const classified = classify(value);
          const kind = classified?.kind ?? 'context';
          const store: KnownStore = {
            id: `${kind}:${found.length}`,
            kind,
            label: labelFor(kind, context, classified ? undefined : value),
            context,
            // For a recognised store the read goes through its own API, so a
            // dispatch that did not re-render the provider is still seen. For a
            // plain context the value *is* the provider's prop, and reading the
            // fiber again is what makes the next sample the current one.
            read: classified ? classified.read : () => currentOf(provider).memoizedProps?.value,
            subscribers: new Set(),
          };
          byContext.set(context, store);
          found.push(store);
        }
      }

      noteDependencies(fiber, dependents, identify);

      if (fiber.sibling) stack.push(fiber.sibling);
      fiber = fiber.child;
    }
  };

  for (const root of reactRoots<StateFiber>()) walk(root);

  for (const [context, ids] of dependents) {
    const store = byContext.get(context);
    if (store) for (const id of ids) store.subscribers.add(id);
  }

  // Innermost kept, outermost cut. `found` is in tree order, so the tail is the
  // providers nearest the route the user is actually on — more likely to be
  // what they are debugging than the theme context wrapped round the whole app
  // since boot. Ids were minted before the cut and stay unique after it.
  stores = found.slice(-Math.max(1, budget.maxStores));
}

/**
 * Record this fiber against every context it actually read.
 *
 * `dependencies.firstContext` is React's own list of the contexts a component
 * consumed during its last render, so this is observation rather than
 * inference. Being rendered *underneath* a provider is not reading it, is true
 * of almost every component in the app, and is never counted here — a
 * subscriber list that names everything answers nothing.
 */
function noteDependencies(
  fiber: StateFiber,
  dependents: Map<ReactContext, Set<string>>,
  identify: Identify,
): void {
  const first = fiber.dependencies?.firstContext;
  if (!first) return;

  let id: string | null = null;
  let dep: ContextDependency | null | undefined = first;
  // A component with no readable function has no id that joins to anything, so
  // its dependency is dropped rather than recorded under a name-only id that
  // several unrelated components would share.
  for (let hops = 0; dep && hops < 32; hops++, dep = dep.next) {
    const context = dep.context;
    if (!context) continue;
    if (id === null) {
      id = identifyFiber(fiber, identify);
      if (!id) return;
    }
    let set = dependents.get(context);
    if (!set) dependents.set(context, (set = new Set()));
    set.add(id);
  }
}

function identifyFiber(fiber: StateFiber, identify: Identify): string {
  const type = fiber.type;
  const fn =
    typeof type === 'function'
      ? (type as ComponentFn)
      : ((type as { render?: ComponentFn; type?: ComponentFn } | null)?.render ??
        (type as { type?: ComponentFn } | null)?.type);
  if (typeof fn !== 'function') return '';
  try {
    return identify(fn, getDisplayName(fiber));
  } catch {
    return '';
  }
}

// ── Sampling ─────────────────────────────────────────────────────────────────

/**
 * Read every known store once.
 *
 * `settled` is what earns a re-discovery: it runs on a timer after the
 * interaction, where a bounded tree walk is invisible, and the gesture's own
 * sample pays for nothing but the reads.
 */
export function sampleStores(
  budget: StateBudget,
  identify: Identify,
  settled: boolean,
  now: number,
): StateSample[] {
  if (!stores.length || (settled && now - discoveredAt >= REDISCOVER_MS)) {
    discover(budget, identify);
    discoveredAt = now;
  }

  const snapshotBudget: SnapshotBudget = {
    maxDepth: budget.maxDepth,
    maxKeys: budget.maxKeys,
    maxEntries: budget.maxEntries,
    stringCap: budget.stringCap,
    secretKey: isSecretStateKey,
  };

  const samples: StateSample[] = [];
  for (const store of stores) {
    let raw: unknown;
    try {
      raw = store.read();
    } catch {
      // A store whose read throws is a store that has gone — an unmounted
      // provider, a client that was torn down. Recorded as an unreadable
      // sample rather than dropped, so the pair either side of it still
      // describes the same set of stores and the diff does not read as a
      // store that vanished.
      samples.push({
        id: store.id,
        kind: store.kind,
        label: store.label,
        subscribers: [...store.subscribers],
        value: null,
        bounded: false,
      });
      continue;
    }

    const taken = snapshot(raw, snapshotBudget);
    samples.push({
      id: store.id,
      kind: store.kind,
      label: store.label,
      subscribers: [...store.subscribers],
      value: taken.value,
      bounded: taken.bounded,
    });
  }
  return samples;
}

/**
 * Whether this page has anything DevFlow can read, and what to say when it does
 * not.
 *
 * Called once per recording, for `FlowState.note`. The three answers are
 * different and a reader who cannot tell them apart assumes the worst of them:
 * a flow with no state because the page has no store looks exactly like a flow
 * with no state because capture failed.
 */
export function stateNote(): string | undefined {
  if (stores.length) return undefined;
  return 'No store was found on this page. DevFlow reads state through React contexts, so a store held in a module — a Zustand store created outside a provider — is not read.';
}
