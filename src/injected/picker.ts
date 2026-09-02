/**
 * The element picker, in the page's MAIN world.
 *
 * Ported from react-source-locator `src/injected/{picker,fiber}.ts` @ 6eb7a30.
 *
 * ## Lazy by construction
 *
 * This file installs nothing at import time. The agent is a manifest content
 * script on `<all_urls>` at `document_start`, so it is present in every document
 * the user opens; if arming the picker were a side effect of loading it, every
 * page on the web would be tracking `mousemove` and walking fibers on every
 * frame for a gesture nobody made. Everything below is attached by `startPick`
 * and removed again by the first of a pick, a cancel, Escape or
 * `PICK_TIMEOUT_MS` — which is what lets one agent serve the recorder and the
 * picker without the recorder paying for the picker's hover tracking.
 *
 * ## Why it does not reuse `core/react/fiber.ts` wholesale
 *
 * It reuses everything it can: `findNearestComponentFiber`, `getDisplayName`,
 * `getDebugSource` and `isElement` are all imported. What it adds is the two
 * things a *passive recorder* has no business doing, and which are therefore
 * deliberately absent from core:
 *
 *   1. **Forcing a lazy component to resolve.** `_init()` can start a dynamic
 *      `import()`. On a pick that is exactly right — the user pointed at this
 *      component and asked what it is — and it is exactly wrong on the recorder's
 *      path, where it would mean the act of recording changed what the page
 *      loaded and the flow no longer describes the session it claims to (D2).
 *      Hover does not force either: the pointer crossing a component is not a
 *      request to fetch a chunk.
 *   2. **Collecting every host node a component renders,** so a component that
 *      returns a fragment highlights as one region. Nothing in the recorder
 *      highlights.
 *
 * The local `getComponentFn` takes `{ force }` with no default, for the same
 * reason core's will: a call site that does not state its intent does not
 * compile. Keep that property if this file grows another caller.
 */

import {
  MAX_ANCESTORS,
  MAX_FIBER_WALK,
  PAGE_GLOBALS,
  PICK_TIMEOUT_MS,
} from '../shared/constants.js';
import { pos1 } from '../core/react/positions.js';
import { readStamp } from '../core/react/stamp.js';
import type { PickResult, PickedComponent, TreeGroup } from '../shared/types.js';
import {
  type ComponentFn,
  type Fiber,
  type WrapperType,
  findNearestComponentFiber,
  getDebugSource,
  getDisplayName,
  isElement,
} from '../core/react/fiber.js';
import { destroyOverlay, drawOverlay, hideOverlay } from './overlay.js';

const pageWindow = window as unknown as Record<string, unknown>;

// ── Fiber helpers the recorder deliberately does not have ────────────────────

/** A `React.lazy` type, which core describes without the `_init` that resolves it. */
type LazyType = WrapperType & { _init?: (payload: LazyPayload) => unknown };

type LazyPayload = NonNullable<WrapperType['_payload']>;

/**
 * Whether an unsettled lazy component may be resolved.
 *
 * A required option object rather than a boolean parameter, and never
 * defaulted: a bare `true` at a call site reads as nothing at all, and the cost
 * of getting it wrong here is a network request the page never asked for.
 */
export interface ForceOption {
  force: boolean;
}

function unwrapLazy(type: LazyType, { force }: ForceOption): ComponentFn | null {
  const payload = type._payload;
  if (!payload) return null;

  let resolved: unknown = null;
  if (payload._status === 1) {
    resolved = payload._result;
  } else if (force && typeof type._init === 'function') {
    try {
      resolved = type._init(payload);
    } catch {
      // Still pending, or the import rejected. Either way there is no function.
      return null;
    }
  }

  if (typeof resolved === 'function') return resolved as ComponentFn;

  const asModule = resolved as { default?: unknown } | null;
  if (asModule && typeof asModule.default === 'function') return asModule.default as ComponentFn;
  return null;
}

/** The function behind a fiber: plain, `forwardRef`, `memo` or `lazy`. */
export function getComponentFn(fiber: Fiber, options: ForceOption): ComponentFn | null {
  const type = fiber.type as LazyType | ComponentFn | null;
  if (!type) return null;

  if (typeof type === 'function') return type;
  if (type._payload) return unwrapLazy(type, options);

  if (typeof type.render === 'function') return type.render; // forwardRef
  if (typeof type.type === 'function') return type.type; // memo
  return null;
}

/**
 * Every host node a component renders.
 *
 * A component that returns a fragment of siblings has no single wrapper element,
 * and highlighting only the first of them draws a box around a third of what the
 * user pointed at. `limit` is a runaway guard for a list component with ten
 * thousand rows, where the union of the first sixty-four is already the whole
 * visible region.
 */
export function getAllDOMNodes(fiber: Fiber, limit = 64): Element[] {
  if (isElement(fiber.stateNode)) return [fiber.stateNode];

  const found: Element[] = [];
  const queue: (Fiber | null)[] = [fiber.child];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_FIBER_WALK && found.length < limit) {
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

// ── What the page keeps between a pick and the questions about it ────────────

/**
 * One component of the last pick result, as the page still holds it.
 *
 * This is the entirety of `__DEVFLOW_PICKED__`, and the reason that global
 * exists at all. A `PickResult` crosses to the extension by `postMessage`, which
 * structured-clones — and a function and a DOM node are the two things that
 * cannot survive that. `READ_COMPONENT_SOURCE` needs `fn.toString()` and
 * `HIGHLIGHT_COMPONENT` needs the nodes, so both are answered from here, in the
 * world where they are real.
 *
 * Upstream spread this across seven globals — the ancestor functions, the
 * sibling functions, their two sets of DOM nodes, their two sets of names, and
 * the result itself — because the panel had no channel to the page and read each
 * of them out with a separate `inspectedWindow.eval`. There is a channel now, so
 * six of those were carrying data that never needed to be in the page at all —
 * the names and the result travel in the message — and what is left is this.
 * Their prefix is on the banned list in CONTRACTS §4.5, and so is the shape.
 */
export interface PickedEntry {
  name: string;
  fn: ComponentFn;
  fiber: Fiber;
  /**
   * The host nodes as they were at pick time.
   *
   * Kept alongside the fiber rather than instead of it: a re-render between the
   * pick and a highlight detaches these, and the fiber is what lets the nodes be
   * found again. See `nodesFor` in `highlight.ts`.
   */
  nodes: Element[];
}

export interface PickedState {
  ancestry: PickedEntry[];
  sibling: PickedEntry[];
}

function pickedState(): PickedState | null {
  return (pageWindow[PAGE_GLOBALS.picked] as PickedState | undefined) ?? null;
}

/**
 * One entry of the last pick, or null if the pick is gone or the index is stale.
 *
 * Every argument is checked rather than trusted. The question arrives over
 * `window.postMessage`, which any script on the page can post to, and a bad
 * `group` would otherwise index `undefined` and throw out of the agent's message
 * listener — taking the recorder's control channel down with it.
 */
export function pickedEntry(group: TreeGroup, index: number): PickedEntry | null {
  const state = pickedState();
  const entries = state?.[group];
  if (!Array.isArray(entries)) return null;
  return entries[index] ?? null;
}

// ── Arming ───────────────────────────────────────────────────────────────────

/** How the outcome of a pick leaves this file. Set for the life of one pick. */
type Report = (result: PickResult) => void;

let activePicker: Picker | null = null;

/**
 * Arms the picker. A second call while one is armed is a no-op.
 *
 * `report` is called exactly once, with whichever of the four outcomes happens
 * first: a component, a click that found no React, Escape, or the timeout. It is
 * *not* called when `cancelPick` disarms from the outside — the surface that
 * cancelled already knows.
 */
export function startPick(report: Report): void {
  if (activePicker) return;
  activePicker = new Picker(report);
  activePicker.arm();
}

/**
 * Disarms a pick in progress without reporting a result.
 *
 * The picker outlives whatever armed it: it holds capture-phase listeners and a
 * crosshair stylesheet on the page, and nothing in page context notices that the
 * panel was closed or the popup dismissed. This is how those surfaces let go.
 */
export function cancelPick(): void {
  activePicker?.disarm();
  activePicker = null;
}

class Picker {
  /**
   * The crosshair, applied as a stylesheet rather than by an overlay element.
   *
   * A full-page overlay would swallow the scroll events the picker needs and
   * hide the very elements it needs as event targets.
   */
  private readonly style = document.createElement('style');

  /** Hover re-runs the walk every frame over the same handful of nodes. */
  private readonly fiberCache = new WeakMap<Element, Fiber | null>();

  private pendingFrame = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private hovered: Element | null = null;
  private pressHandled = false;

  /**
   * Bound once and reused, so `removeEventListener` matches what was added.
   *
   * `handlerFor(type)` returning a fresh closure per call — as upstream's did —
   * meant `arm` and `disarm` registered and unregistered *different* functions,
   * and every swallowing listener stayed on the document for the life of the
   * page. On a page where the user picked twice, the second pick's click was
   * swallowed by the first pick's orphaned handlers.
   */
  private readonly swallowers: [string, EventListener][];

  private static readonly SWALLOWED = [
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'click',
    'contextmenu',
    'dblclick',
  ];

  constructor(private readonly report: Report) {
    this.swallowers = Picker.SWALLOWED.map((type) => [
      type,
      type === 'pointerdown' || type === 'mousedown' ? this.onPress : this.swallow,
    ]);
  }

  arm(): void {
    this.style.textContent = '*{cursor:crosshair !important;}';
    document.documentElement.append(this.style);

    document.addEventListener('mousemove', this.onMouseMove, true);
    document.addEventListener('scroll', this.onScroll, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    for (const [type, handler] of this.swallowers) {
      document.addEventListener(type, handler, true);
    }

    /*
     * A ceiling on a gesture the user may simply have walked away from.
     *
     * Without it an armed picker outlives the panel that armed it, the page it
     * was armed on and every navigation after that, holding capture-phase
     * listeners that swallow every click on the document. Reported as
     * `cancelled` rather than as an error: nothing went wrong, the moment passed.
     */
    this.timer = setTimeout(() => {
      this.disarm();
      this.report({ kind: 'cancelled' });
    }, PICK_TIMEOUT_MS);
  }

  /** Tears the picker down, leaving no result behind. */
  disarm(): void {
    if (activePicker === this) activePicker = null;

    clearTimeout(this.timer);
    this.style.remove();
    destroyOverlay();
    if (this.pendingFrame) cancelAnimationFrame(this.pendingFrame);

    document.removeEventListener('mousemove', this.onMouseMove, true);
    document.removeEventListener('scroll', this.onScroll, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    for (const [type, handler] of this.swallowers) {
      document.removeEventListener(type, handler, true);
    }
  }

  // ── Hover ──────────────────────────────────────────────────────────────────

  private readonly paint = (): void => {
    this.pendingFrame = 0;
    if (!this.hovered) return hideOverlay();

    const fiber = this.nearest(this.hovered);
    if (!fiber) return hideOverlay();

    const nodes = getAllDOMNodes(fiber);
    if (nodes.length === 0) return hideOverlay();

    drawOverlay(nodes, getDisplayName(fiber));
  };

  private readonly schedulePaint = (): void => {
    if (this.pendingFrame) return;
    this.pendingFrame = requestAnimationFrame(this.paint);
  };

  private readonly onMouseMove = (e: Event): void => {
    const target = (e as MouseEvent).target;
    this.hovered = isElement(target) ? target : null;
    this.schedulePaint();
  };

  /** Scrolling moves elements out from under a stationary cursor. */
  private readonly onScroll = (): void => {
    this.schedulePaint();
  };

  private readonly onKeyDown = (e: Event): void => {
    if ((e as KeyboardEvent).key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    this.disarm();
    this.report({ kind: 'cancelled' });
  };

  /** Memoised `findNearestComponentFiber`, because hover asks per frame. */
  private nearest(el: Element): Fiber | null {
    const cached = this.fiberCache.get(el);
    if (cached !== undefined) return cached;

    const found = findNearestComponentFiber(el);
    this.fiberCache.set(el, found);
    return found;
  }

  // ── Press interception ─────────────────────────────────────────────────────

  private readonly swallow = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  /**
   * Performs the pick.
   *
   * Bound to *both* `pointerdown` and `mousedown` on purpose. Cancelling
   * `pointerdown` suppresses the compatibility mouse events, so on a
   * pointer-capable browser `mousedown` never fires and binding only to it means
   * clicks silently do nothing. Whichever arrives first wins; the flag stops the
   * other picking twice.
   */
  private readonly onPress = (e: Event): void => {
    this.swallow(e);
    if (this.pressHandled) return;
    if ((e as MouseEvent).button !== 0) return; // primary button only

    this.pressHandled = true;
    const target = (e as MouseEvent).target;
    this.disarm();
    this.blockTrailingGesture();

    if (!isElement(target)) {
      this.report({ kind: 'error', error: 'No element under the cursor.' });
      return;
    }
    this.report(this.pick(target));
  };

  /**
   * Swallows the rest of the gesture after the listeners are torn down, so the
   * release of the picking click cannot activate whatever was underneath.
   */
  private blockTrailingGesture(): void {
    const types = ['pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu'];

    const stop = (): void => {
      clearTimeout(timer);
      for (const type of types) document.removeEventListener(type, onTrailing, true);
    };

    const onTrailing = (ev: Event): void => {
      this.swallow(ev);
      // `click` ends the gesture. If it was suppressed upstream, the timer does.
      if (ev.type === 'click') stop();
    };

    for (const type of types) document.addEventListener(type, onTrailing, true);
    const timer = setTimeout(stop, 400);
  }

  // ── Pick ───────────────────────────────────────────────────────────────────

  private pick(target: Element): PickResult {
    const picked = this.nearest(target);
    if (!picked) {
      return {
        kind: 'error',
        error: 'No React component found here. Is this page built with React?',
      };
    }

    const ancestry = collectAncestors(picked);
    if (ancestry.length === 0) {
      return { kind: 'error', error: 'Found a fiber but no component function to locate.' };
    }

    const sibling = collectSiblings(picked);

    /*
     * Written before the result is reported, not after: the panel answers a
     * `HIGHLIGHT_COMPONENT` the moment the user's pointer lands on a tree row,
     * which can be the same frame the result renders in.
     *
     * A *new* pick is what replaces this. A cancelled one deliberately does not
     * — the previous result is still on screen in the panel, and its tree rows
     * must still highlight.
     */
    const state: PickedState = { ancestry, sibling };
    pageWindow[PAGE_GLOBALS.picked] = state;

    return {
      kind: 'picked',
      ancestry: ancestry.map(describePicked),
      siblings: sibling.map(describePicked),
    };
  }
}

/**
 * The ancestor chain, outermost first.
 *
 * `MAX_ANCESTORS` is 50, where the recorder's `MAX_COMPONENT_CHAIN` is 12, and
 * the two limits are deliberately different rather than accidentally so. A pick
 * draws a browsable tree that the user is looking at and scrolling through, so
 * the far end is worth keeping — the provider that owns the route is often
 * exactly what they were after. A recorded step says where a click landed, and
 * is read by an assistant that gains nothing from `App` wrapped in nine
 * providers, at the cost of a `toString()` and a hash each.
 *
 * Forcing is right here and nowhere else in the walk: the user pointed at this
 * component and asked what it is, so resolving a lazy is what they asked for.
 */
function collectAncestors(picked: Fiber): PickedEntry[] {
  const chain: PickedEntry[] = [];
  let f: Fiber | null = picked;
  let walked = 0;

  while (f && chain.length < MAX_ANCESTORS && walked < MAX_FIBER_WALK) {
    const fn = getComponentFn(f, { force: true });
    // A lazy fiber and its resolved inner fiber share one function; keep one.
    if (fn && (chain.length === 0 || chain[0].fn !== fn)) {
      chain.unshift({ name: getDisplayName(f), fn, fiber: f, nodes: getAllDOMNodes(f) });
    }
    f = f.return;
    walked++;
  }

  return chain;
}

/** Peers under the same raw parent fiber. */
function collectSiblings(picked: Fiber): PickedEntry[] {
  const siblings: PickedEntry[] = [];
  for (let sib = picked.return?.child ?? null; sib; sib = sib.sibling) {
    if (sib === picked) continue;
    const fn = getComponentFn(sib, { force: true });
    if (fn) siblings.push({ name: getDisplayName(sib), fn, fiber: sib, nodes: getAllDOMNodes(sib) });
  }
  return siblings;
}

/**
 * One entry, as it crosses to the extension.
 *
 * `debugSource` is `pos1` with **no arithmetic**. React records 1-based lines,
 * `PickedComponent.debugSource` is typed `Pos1`, and `pos1` is an assertion
 * rather than a conversion — so this is the whole of the change. Upstream
 * subtracted one here, because react-source-locator was 0-based end to end and
 * converted at its display edge instead; carrying that subtraction across would
 * have opened every file one line above the component, silently and forever.
 * That is D1, and the reason the base is a type.
 */
export function describePicked(entry: PickedEntry): PickedComponent {
  const src = getDebugSource(entry.fiber);
  return {
    name: entry.name,
    debugSource: src
      ? {
          source: src.fileName ?? '',
          line: pos1(src.lineNumber ?? 1),
          column: pos1(src.columnNumber ?? 1),
        }
      : null,
    // The component function first and the raw `fiber.type` second, exactly as
    // the recorder reads it in `agent.ts`: the plugin stamps the value a module
    // bound, so `memo(Cart)` has a stamp on the wrapper naming where it was
    // memoised and one on `Cart` naming where it was written. Picking and
    // recording answering differently about one component is the failure this
    // ordering exists to prevent.
    stamp: readStamp(entry.fn) ?? readStamp(entry.fiber.type),
  };
}
