/**
 * React fiber walking: from a DOM node to the component that rendered it.
 *
 * The one fiber walk. It existed twice, and the difference between its two
 * callers — a passive recorder listening on `document`, and a picker resolving
 * whatever the user just clicked — is the whole of D2.
 *
 *   **D2 · `force` is required and has no default.** Resolving a `React.lazy`
 *   type that has not settled means calling `_init`, which can start a dynamic
 *   `import()`. On a pick that is exactly right: the user asked for this
 *   component, and fetching its chunk is what they asked for. On the capture
 *   path it is a bug with no symptom — the act of recording changes what the
 *   page loads, and the flow stops describing the session it claims to. One copy
 *   passed `true` on every pick; the other removed the flag so that nothing
 *   could. Neither behaviour is portable to the other caller, so `getComponentFn`
 *   takes `{ force }` with no default: every call site says which of the two it
 *   is, or does not compile. `collectChain`, which is the capture path, passes
 *   `false`, and `tests/react-fiber.test.ts` asserts that `_init` is never
 *   reached through it.
 *
 * Two things the recorder's copy had learned that the picker's had not, both
 * kept here:
 *
 *   - **Shadow roots are crossed, in both directions.** `climb` hops from the
 *     top of a shadow root to its host, and `interactionTarget` reads the
 *     composed path rather than the retargeted `event.target`. A picker takes
 *     the element the user pointed at, so it meets neither problem; a passive
 *     listener on `document` meets both.
 *   - **Host fibers are never chain entries.** See `collectChain` — the bug that
 *     rule exists for is written out there, because it is the worst this feature
 *     has had.
 *
 * And one the picker's had that the recorder had no use for, kept because the
 * merged product highlights again: `getFirstDOMNode` and `getAllDOMNodes`, which
 * are what a hover highlight is sized from.
 *
 * DOM-facing but free of `chrome.*` and of module state, like `core/selector`
 * and `core/describe` — which is what lets it be tested in jsdom, and what keeps
 * it inside `core/`.
 */

import { MAX_COMPONENT_CHAIN, MAX_FIBER_WALK } from '../../shared/constants.js';
import { ANONYMOUS_NAME, UNSETTLED_LAZY_NAME } from '../locate/id.js';

export interface DebugSource {
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface Fiber {
  type: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  stateNode: unknown;
  _debugSource?: DebugSource | null;
  _debugOwner?: unknown;
  _debugHookTypes?: unknown;
}

export type ComponentFn = ((...args: unknown[]) => unknown) & {
  displayName?: string;
  name?: string;
};

interface LazyPayload {
  _status?: number;
  _result?: unknown;
}

export interface WrapperType {
  _payload?: LazyPayload;
  /** `React.lazy`'s initialiser. Calling it can start a dynamic import — see D2. */
  _init?: (payload: LazyPayload) => unknown;
  displayName?: string;
  render?: ComponentFn;
  type?: ComponentFn;
}

/**
 * Whether an unsettled `React.lazy` payload may be initialised.
 *
 * There is no default, and that is the mechanism rather than an oversight: the
 * two callers of this module want opposite answers and both are right, so the
 * only safe shape is one that does not compile until a call site has said which
 * it is. See D2 in the header.
 */
export interface LazyOptions {
  /**
   * True only when a person asked for this component and is waiting on it — the
   * picker. False everywhere the walk is a side effect of something else the
   * page was already doing.
   */
  force: boolean;
}

/** Keys React stamps on a host node, and on a root container. */
const FIBER_KEY_RE = /^__reactFiber\$|^__reactInternalInstance\$/;
const CONTAINER_KEY_RE = /^__reactContainer\$|^_reactRootContainer$/;

export function isElement(node: unknown): node is Element {
  return !!node && (node as Node).nodeType === 1;
}

export function getFiber(el: Element): Fiber | null {
  for (const key of Object.keys(el)) {
    if (FIBER_KEY_RE.test(key)) return (el as unknown as Record<string, Fiber>)[key];
  }
  return null;
}

/**
 * Resolves a `React.lazy` type to the component behind it.
 *
 * `_status === 1` means the payload settled on its own, and reading it costs
 * nothing. Anything else needs `_init`, which is the call D2 is about — so it
 * happens only where a caller has asked for it in so many words.
 *
 * An `_init` that throws is a payload still pending or already rejected, and
 * comes back as "no function" rather than propagating: the walk describes what
 * is on the page, and a chunk that has not arrived is a fact about the page
 * rather than a failure of the walk.
 */
export function unwrapLazy(type: WrapperType, { force }: LazyOptions): ComponentFn | null {
  const payload = type._payload;
  if (!payload) return null;

  let resolved: unknown = null;
  if (payload._status === 1) {
    resolved = payload._result;
  } else if (force && typeof type._init === 'function') {
    try {
      resolved = type._init(payload);
    } catch {
      return null;
    }
  }

  if (!resolved) return null;
  if (typeof resolved === 'function') return resolved as ComponentFn;

  const asModule = resolved as { default?: unknown };
  if (typeof asModule.default === 'function') return asModule.default as ComponentFn;
  return null;
}

export function getComponentFn(fiber: Fiber, options: LazyOptions): ComponentFn | null {
  const type = fiber.type as WrapperType | ComponentFn | null;
  if (!type) return null;

  if (typeof type === 'function') return type;
  if (type._payload) return unwrapLazy(type, options);

  if (typeof type.render === 'function') return type.render; // forwardRef
  if (typeof type.type === 'function') return type.type; // memo
  return null;
}

export function getDisplayName(fiber: Fiber): string {
  const type = fiber.type as WrapperType | ComponentFn | null;
  if (!type) return ANONYMOUS_NAME;

  if (typeof type === 'function') return type.displayName || type.name || ANONYMOUS_NAME;

  if (type._payload) {
    // Never forces, whatever the caller of `getComponentFn` decided. Putting a
    // name on a screen is not a reason to make the page fetch a chunk, and if a
    // pick already forced it the payload has settled by the time this reads it.
    const inner = unwrapLazy(type, { force: false });
    return inner ? inner.displayName || inner.name || ANONYMOUS_NAME : UNSETTLED_LAZY_NAME;
  }

  if (type.displayName) return type.displayName;
  if (type.render) return type.render.displayName || type.render.name || 'ForwardRef';
  if (type.type) return type.type.displayName || type.type.name || 'Memo';
  return ANONYMOUS_NAME;
}

/**
 * `_debugSource` — the exact JSX location, on React 18 and earlier development
 * builds. React 19 dropped it, which is why bundle search is the primary path
 * rather than the fallback.
 */
export function getDebugSource(fiber: Fiber): DebugSource | null {
  const src = fiber._debugSource;
  if (!src || typeof src.fileName !== 'string') return null;
  return src;
}

/**
 * Whether this fiber came from a development build.
 *
 * Reads `_debugOwner`/`_debugHookTypes` rather than `_debugSource`, because
 * those survive into React 19 where `_debugSource` does not — so the answer
 * stays right across versions.
 */
export function isDevelopmentFiber(fiber: Fiber): boolean {
  return fiber._debugOwner !== undefined || fiber._debugHookTypes !== undefined;
}

/** Is there a React root anywhere on this page? Distinct from "did this click land in a component". */
export function hasReactRoot(doc: Document): boolean {
  const candidates: Element[] = [];
  if (doc.body) {
    candidates.push(doc.body);
    // A React app is nearly always mounted into a direct child of <body>.
    for (const child of Array.from(doc.body.children)) candidates.push(child);
  }
  for (const id of ['root', 'app', '__next', '__nuxt']) {
    const el = doc.getElementById(id);
    if (el) candidates.push(el);
  }

  for (const el of candidates) {
    for (const key of Object.keys(el)) {
      if (CONTAINER_KEY_RE.test(key) || FIBER_KEY_RE.test(key)) return true;
    }
  }
  return false;
}

/**
 * The next element up, crossing out of a shadow root when it has to.
 *
 * `parentElement` is null on the top node inside a shadow root, which would end
 * the walk one hop short of the component that rendered the host. Web components
 * wrapping React — and React rendering *into* a shadow root — are both real, and
 * in both cases the answer the reader wants is on the other side of the boundary.
 */
function climb(node: Element): Element | null {
  if (node.parentElement) return node.parentElement;

  const root = node.getRootNode();
  const host = (root as ShadowRoot | null)?.host;
  return isElement(host) ? host : null;
}

/**
 * The element an interaction actually happened on.
 *
 * `event.target` is retargeted to the shadow *host* for anything inside a shadow
 * root, so it cannot see React mounted in there at all. `composedPath()[0]` is
 * the node that was really hit. Falls back to `target` where `composedPath` is
 * missing — an old browser, or a synthetic event dispatched without it.
 */
export function interactionTarget(event: Event): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const first = path[0];
  if (isElement(first)) return first;

  return isElement(event.target) ? event.target : null;
}

/**
 * Walks up from a DOM element to the nearest fiber backed by a component.
 *
 * Never forces a lazy payload, on either caller's behalf. This is the search for
 * *which* fiber to ask about rather than the answer, and a component nobody has
 * chosen yet is no reason to fetch a chunk. A picker forces afterwards, on the
 * one fiber it settled on.
 *
 * `walkLimit` is `react.maxFiberWalk`, defaulted to the compiled-in constant so
 * that every caller with no settings in hand — the tests, and the walk's own
 * recursion — still gets the shipped answer. The agent passes its pushed config;
 * see `chainFor` in `injected/agent.ts`.
 *
 * `cache` belongs to the caller, not to this module: `core/` holds no module
 * state, and a hover highlight re-runs this on every animation frame over the
 * same handful of nodes. It is keyed by element alone, so a caller that changes
 * `walkLimit` between calls must not carry one across the change.
 */
export function findNearestComponentFiber(
  el: Element,
  walkLimit = MAX_FIBER_WALK,
  cache?: WeakMap<Element, Fiber | null>,
): Fiber | null {
  const cached = cache?.get(el);
  if (cached !== undefined) return cached;

  let result: Fiber | null = null;
  let node: Element | null = el;

  outer: while (node && node !== node.ownerDocument.documentElement) {
    const fiber = getFiber(node);
    if (fiber) {
      let f: Fiber | null = fiber;
      let walked = 0;
      while (f && walked < walkLimit) {
        if (getComponentFn(f, { force: false })) {
          result = f;
          break outer;
        }
        f = f.return;
        walked++;
      }
    }
    node = climb(node);
  }

  cache?.set(el, result);
  return result;
}

/**
 * The first host DOM node a component fiber renders, used to size a highlight.
 *
 * Breadth-first from the fiber's children, because the nearest host node down
 * any branch is the one whose box covers what the component drew. A depth-first
 * walk would return a deeply nested leaf of the first child instead, and outline
 * a word where the reader expected a card.
 */
export function getFirstDOMNode(fiber: Fiber, walkLimit = MAX_FIBER_WALK): Element | null {
  if (isElement(fiber.stateNode)) return fiber.stateNode;

  const queue: (Fiber | null)[] = [fiber.child];
  let visited = 0;

  while (queue.length > 0 && visited < walkLimit) {
    const f = queue.shift();
    visited++;
    if (!f) continue;
    if (isElement(f.stateNode)) return f.stateNode;
    queue.push(f.child, f.sibling);
  }
  return null;
}

/**
 * Every host node a component renders, so a highlight can cover a component that
 * returns a fragment of siblings rather than one wrapper element.
 *
 * `limit` bounds the drawing rather than the walk: a component that renders a
 * thousand rows does not need a thousand outlines to be recognisable, and the
 * highlight has to stay cheap enough to redraw as the pointer moves.
 */
export function getAllDOMNodes(fiber: Fiber, limit = 64, walkLimit = MAX_FIBER_WALK): Element[] {
  if (isElement(fiber.stateNode)) return [fiber.stateNode];

  const found: Element[] = [];
  const queue: (Fiber | null)[] = [fiber.child];
  let visited = 0;

  while (queue.length > 0 && visited < walkLimit && found.length < limit) {
    const f = queue.shift();
    visited++;
    if (!f) continue;

    if (isElement(f.stateNode)) {
      // Descendants are inside this node already; only follow siblings.
      found.push(f.stateNode);
      queue.push(f.sibling);
      continue;
    }
    queue.push(f.child, f.sibling);
  }

  return found;
}

export interface ChainEntry {
  name: string;
  /** Null for a lazy component that has not settled — name only, no needle. */
  fn: ComponentFn | null;
  /**
   * The raw `fiber.type`, before `getComponentFn` unwraps it.
   *
   * Carried because a build stamp lands on the value the module bound, and for
   * `forwardRef(fn)` and `memo(fn)` that is the wrapper object rather than the
   * function inside it — which is the only thing `fn` above holds. Required
   * rather than optional so a new construction site cannot quietly drop it and
   * leave every wrapped component unstamped with nothing going red.
   */
  type: unknown;
  debugSource: DebugSource | null;
  development: boolean;
}

export interface ChainResult {
  entries: ChainEntry[];
  /** The walk hit `MAX_COMPONENT_CHAIN`, so the outermost entry is not the root. */
  truncated: boolean;
}

/**
 * The component chain above an element, **outermost first**.
 *
 * Capped at `MAX_COMPONENT_CHAIN`, counting from the element outwards, so what
 * is kept is the nearest — which is the part that identifies where a click
 * landed. The far end of a deep tree is `App` wrapped in nine providers, and is
 * worth nothing to whoever reads the flow.
 *
 * Only fibers that describe *something* are kept. The host fibers between two
 * components — every `<div>`, `<span>` and `<button>` React rendered, and the
 * `Fragment`s and `Suspense` boundaries around them — have no component function
 * and no name of their own, so `getDisplayName` calls them all `Anonymous`.
 * Emitting them was this feature's worst bug: they all hash to the one id
 * `nameOnlyId('Anonymous')`, whose single table row is minted from whichever of
 * them was seen first, so a `<div>` in `App.tsx` answered for a click inside
 * `CheckoutForm` and the flow named a file the click never went near. They also
 * spent `MAX_COMPONENT_CHAIN` slots that real components needed — roughly half
 * of them — and each one that reached `table.ts` was explained to the reader as
 * a lazy component that had not finished loading.
 */
export function collectChain(
  el: Element,
  limit = MAX_COMPONENT_CHAIN,
  walkLimit = MAX_FIBER_WALK,
): ChainResult {
  const nearest = findNearestComponentFiber(el, walkLimit);
  if (!nearest) return { entries: [], truncated: false };

  const entries: ChainEntry[] = [];
  let f: Fiber | null = nearest;
  let walked = 0;
  let truncated = false;

  while (f && walked < walkLimit) {
    // The capture path, and the reason `force` has no default: a passive
    // recorder that initialised a lazy payload would make the act of recording
    // change what the page loads.
    const fn = getComponentFn(f, { force: false });
    // A lazy fiber and the fiber it resolved to share one function; keep one.
    const duplicate = fn !== null && entries.length > 0 && entries[entries.length - 1].fn === fn;

    if (!duplicate) {
      const name = getDisplayName(f);
      // No function *and* no name is a host fiber, and it names nothing the
      // reader can act on. A fiber with one or the other still does: an
      // unsettled lazy component is `Lazy(loading…)`, and a raw context object
      // is `CartContext.Provider`.
      if (fn !== null || name !== ANONYMOUS_NAME) {
        if (entries.length >= limit) {
          truncated = true;
          break;
        }
        entries.push({
          name,
          fn,
          type: f.type,
          debugSource: getDebugSource(f),
          development: isDevelopmentFiber(f),
        });
      }
    }

    f = f.return;
    walked++;
  }

  // Built nearest-first by the walk; the chain reads outermost-first.
  entries.reverse();
  return { entries, truncated };
}
