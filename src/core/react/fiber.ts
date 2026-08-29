/**
 * React fiber walking, for the MAIN-world agent.
 *
 * Ported from react-source-locator `src/injected/fiber.ts` @ 6eb7a30.
 *
 * Deliberate divergences from upstream, all because this runs inside a *passive
 * recorder* rather than behind an explicit "pick this element" action:
 *
 *   1. **Lazy components are never forced.** Upstream passes `force = true` on a
 *      pick, which calls `_init()` and can start a dynamic `import()`. Here that
 *      would mean the act of recording changes what the page loads, so the flow
 *      no longer describes the session it claims to. An unresolved lazy
 *      component is reported by name and nothing more.
 *   2. **No DOM-node collection.** Upstream needs every host node a component
 *      renders in order to draw hover highlights. Nothing here highlights.
 *   3. **Shadow roots are crossed, in both directions.** `climb` hops from the
 *      top of a shadow root to its host, and `interactionTarget` reads the
 *      composed path rather than the retargeted `event.target`. Upstream picks
 *      an element the user pointed at, so it never meets either problem; a
 *      passive listener on `document` meets both. Worth back-porting.
 *
 * DOM-facing but free of `chrome.*` and module state, like `core/selector` and
 * `core/describe` — which is what lets it be tested in jsdom.
 */

import { MAX_COMPONENT_CHAIN, MAX_FIBER_WALK } from '../../shared/constants.js';
import { ANONYMOUS_NAME, UNSETTLED_LAZY_NAME } from './id.js';

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
  displayName?: string;
  render?: ComponentFn;
  type?: ComponentFn;
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
 * Resolves an already-settled `React.lazy` type, and only that.
 *
 * Upstream takes a `force` flag; this deliberately has none, so there is no call
 * site that can start an import by accident. `_status === 1` means the payload
 * resolved on its own, which is the only case we read.
 */
export function unwrapSettledLazy(type: WrapperType): ComponentFn | null {
  const payload = type._payload;
  if (!payload || payload._status !== 1) return null;

  const resolved: unknown = payload._result;
  if (typeof resolved === 'function') return resolved as ComponentFn;

  const asModule = resolved as { default?: unknown } | null;
  if (asModule && typeof asModule.default === 'function') return asModule.default as ComponentFn;
  return null;
}

export function getComponentFn(fiber: Fiber): ComponentFn | null {
  const type = fiber.type as WrapperType | ComponentFn | null;
  if (!type) return null;

  if (typeof type === 'function') return type;
  if (type._payload) return unwrapSettledLazy(type);

  if (typeof type.render === 'function') return type.render; // forwardRef
  if (typeof type.type === 'function') return type.type; // memo
  return null;
}

export function getDisplayName(fiber: Fiber): string {
  const type = fiber.type as WrapperType | ComponentFn | null;
  if (!type) return ANONYMOUS_NAME;

  if (typeof type === 'function') return type.displayName || type.name || ANONYMOUS_NAME;

  if (type._payload) {
    const inner = unwrapSettledLazy(type);
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
 * `walkLimit` is `react.maxFiberWalk`, defaulted to the compiled-in constant so
 * that every caller that has no settings in hand — the tests, and the fiber
 * walk's own recursion — still gets the shipped answer. The agent passes its
 * pushed config; see `chainFor` in `injected/agent.ts`.
 */
export function findNearestComponentFiber(el: Element, walkLimit = MAX_FIBER_WALK): Fiber | null {
  let node: Element | null = el;

  while (node && node !== node.ownerDocument.documentElement) {
    const fiber = getFiber(node);
    if (fiber) {
      let f: Fiber | null = fiber;
      let walked = 0;
      while (f && walked < walkLimit) {
        if (getComponentFn(f)) return f;
        f = f.return;
        walked++;
      }
    }
    node = climb(node);
  }

  return null;
}

export interface ChainEntry {
  name: string;
  /** Null for a lazy component that has not settled — name only, no needle. */
  fn: ComponentFn | null;
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
    const fn = getComponentFn(f);
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
