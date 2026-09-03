// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectChain,
  findNearestComponentFiber,
  getAllDOMNodes,
  getComponentFn,
  getDisplayName,
  getFiber,
  getFirstDOMNode,
  hasReactRoot,
  unwrapLazy,
  type Fiber,
} from '../src/core/react/fiber.js';
import { interactionTarget } from '../src/core/dom/walk.js';
import { MAX_COMPONENT_CHAIN } from '../src/shared/constants.js';

/** A fiber as React would leave it: a type, and a parent link. */
function fiber(type: unknown, parent: Fiber | null = null): Fiber {
  return { type, return: parent, child: null, sibling: null, stateNode: null };
}

/** Stamp a fiber onto a node the way React does — an expando, not an attribute. */
function attach(el: Element, f: Fiber): void {
  (el as unknown as Record<string, Fiber>)['__reactFiber$k3n1p'] = f;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('getFiber', () => {
  it('finds React 17+ and React 16 keys', () => {
    const el = document.createElement('div');
    const f = fiber(function Cart() {});
    (el as unknown as Record<string, Fiber>)['__reactInternalInstance$abc'] = f;
    expect(getFiber(el)).toBe(f);
  });

  it('is null on a node React never touched', () => {
    expect(getFiber(document.createElement('div'))).toBeNull();
  });
});

describe('getDisplayName', () => {
  it('prefers displayName, then name', () => {
    const named = function Cart() {};
    expect(getDisplayName(fiber(named))).toBe('Cart');
    const aliased = Object.assign(function c() {}, { displayName: 'Cart' });
    expect(getDisplayName(fiber(aliased))).toBe('Cart');
  });

  it('unwraps forwardRef and memo', () => {
    expect(getDisplayName(fiber({ render: function Inner() {} }))).toBe('Inner');
    expect(getDisplayName(fiber({ type: function Inner() {} }))).toBe('Inner');
  });

  it('says a lazy component is still loading rather than inventing a name', () => {
    expect(getDisplayName(fiber({ _payload: { _status: 0 } }))).toBe('Lazy(loading…)');
  });

  it('names a lazy component that already settled', () => {
    const settled = { _payload: { _status: 1, _result: function Modal() {} } };
    expect(getDisplayName(fiber(settled))).toBe('Modal');
  });
});

describe('unwrapLazy, and D2', () => {
  /*
   * The divergence the merged core had to resolve. Calling `_init` can start a
   * dynamic import: on a pick that is what the user asked for, and on the
   * recorder's capture path it means the act of recording changes what the page
   * loads. One extension always forced and the other could not, so `force` is
   * now required with no default and every call site says which it is.
   */
  it('never initialises a payload that has not settled, unless forced', () => {
    const init = vi.fn();
    const lazy = { _payload: { _status: 0 }, _init: init };

    expect(unwrapLazy(lazy as never, { force: false })).toBeNull();
    expect(init).not.toHaveBeenCalled();
  });

  it('initialises an unsettled payload when a pick asks it to', () => {
    const Modal = function Modal() {};
    const init = vi.fn(() => Modal);

    expect(unwrapLazy({ _payload: { _status: 0 }, _init: init }, { force: true })).toBe(Modal);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('reports a still-pending payload as no function rather than throwing', () => {
    // `_init` throws the promise React suspends on. That is a fact about the
    // page — the chunk has not arrived — not a failure of the walk.
    const init = vi.fn(() => {
      throw new Error('pending');
    });
    expect(unwrapLazy({ _payload: { _status: 0 }, _init: init }, { force: true })).toBeNull();
  });

  it('reads a settled payload, including a module default export', () => {
    const Modal = function Modal() {};
    expect(unwrapLazy({ _payload: { _status: 1, _result: { default: Modal } } }, { force: false })).toBe(
      Modal,
    );
  });

  it('forces through getComponentFn only when told to', () => {
    const init = vi.fn(() => function Modal() {});
    const f = fiber({ _payload: { _status: 0 }, _init: init });

    expect(getComponentFn(f, { force: false })).toBeNull();
    expect(init).not.toHaveBeenCalled();

    expect(getComponentFn(f, { force: true })).toBeTypeOf('function');
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('does not force merely to put a name on screen', () => {
    // `getDisplayName` takes no options on purpose: naming a component is not a
    // reason to make the page fetch a chunk, whatever the caller of
    // `getComponentFn` decided a moment earlier.
    const init = vi.fn();
    expect(getDisplayName(fiber({ _payload: { _status: 0 }, _init: init }))).toBe('Lazy(loading…)');
    expect(init).not.toHaveBeenCalled();
  });
});

describe('the capture path never forces', () => {
  /*
   * D2's standing proof, and the one that matters: not that `force: false`
   * exists, but that the path a recording actually takes passes it. A flow has
   * to describe the session it claims to, and a lazy chunk fetched because
   * somebody clicked while recording is a page load the user never caused.
   */
  it('walks a chain past an unsettled lazy component without initialising it', () => {
    const init = vi.fn(() => function Modal() {});

    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host')!;
    const app = fiber(function App() {});
    const lazy = fiber({ _payload: { _status: 0 }, _init: init }, app);
    const inner = fiber(function Modal() {}, lazy);
    attach(host, fiber('div', inner));

    const { entries } = collectChain(host);

    expect(init).not.toHaveBeenCalled();
    // Still reported, by name, with no function to build a needle from.
    expect(entries.map((e) => e.name)).toEqual(['App', 'Lazy(loading…)', 'Modal']);
    expect(entries[1].fn).toBeNull();
  });

  it('does not force while searching for the nearest component either', () => {
    const init = vi.fn(() => function Modal() {});
    document.body.innerHTML = '<div id="host"><span id="icon"></span></div>';
    attach(document.getElementById('host')!, fiber({ _payload: { _status: 0 }, _init: init }));

    findNearestComponentFiber(document.getElementById('icon')!);
    expect(init).not.toHaveBeenCalled();
  });
});

describe('findNearestComponentFiber', () => {
  it('walks up from the clicked node to the nearest component', () => {
    document.body.innerHTML = '<div id="host"><span id="icon"></span></div>';
    const host = document.getElementById('host')!;
    const cart = fiber(function Cart() {});
    attach(host, fiber('div', cart));

    const found = findNearestComponentFiber(document.getElementById('icon')!);
    expect(found).toBe(cart);
  });

  it('is null when nothing above the element is React', () => {
    document.body.innerHTML = '<div><span id="icon"></span></div>';
    expect(findNearestComponentFiber(document.getElementById('icon')!)).toBeNull();
  });

  it('answers a repeat from the caller\'s cache without walking again', () => {
    // The highlight re-runs this on every animation frame over the same nodes.
    // The cache is the caller's because `core/` holds no module state.
    document.body.innerHTML = '<div id="host"><span id="icon"></span></div>';
    const host = document.getElementById('host')!;
    const icon = document.getElementById('icon')!;
    const cart = fiber(function Cart() {});
    attach(host, fiber('div', cart));

    const cache = new WeakMap<Element, Fiber | null>();
    expect(findNearestComponentFiber(icon, undefined, cache)).toBe(cart);

    // Detaching the fiber would change the answer, so a second call that still
    // returns it can only have come from the cache.
    delete (host as unknown as Record<string, Fiber>)['__reactFiber$k3n1p'];
    expect(findNearestComponentFiber(icon, undefined, cache)).toBe(cart);
    expect(findNearestComponentFiber(icon)).toBeNull();
  });

  it('caches a miss too, so a non-React subtree is not re-walked', () => {
    document.body.innerHTML = '<div><span id="icon"></span></div>';
    const icon = document.getElementById('icon')!;
    const cache = new WeakMap<Element, Fiber | null>();

    expect(findNearestComponentFiber(icon, undefined, cache)).toBeNull();
    expect(cache.get(icon)).toBeNull();
  });
});

describe('host nodes, which a highlight is sized from', () => {
  /** A fiber whose stateNode is a real element, as React leaves a host fiber. */
  function host(el: Element, child: Fiber | null = null, sibling: Fiber | null = null): Fiber {
    return { type: el.tagName.toLowerCase(), return: null, child, sibling, stateNode: el };
  }

  it('takes the component\'s own node when it has one', () => {
    const el = document.createElement('div');
    expect(getFirstDOMNode(host(el))).toBe(el);
  });

  it('finds the nearest host node below a component that renders one', () => {
    const inner = document.createElement('span');
    const component = fiber(function Cart() {});
    component.child = host(inner);

    expect(getFirstDOMNode(component)).toBe(inner);
  });

  it('is null for a component that rendered nothing at all', () => {
    expect(getFirstDOMNode(fiber(function Empty() {}))).toBeNull();
  });

  it('collects every top-level node of a fragment, not just the first', () => {
    // The case the single-node version gets wrong: a component that returns
    // siblings would be highlighted as though it were only its first child.
    const a = document.createElement('p');
    const b = document.createElement('p');
    const component = fiber(function Rows() {});
    component.child = host(a, null, host(b));

    expect(getAllDOMNodes(component)).toEqual([a, b]);
  });

  it('stops at the limit rather than outlining a thousand rows', () => {
    let first: Fiber | null = null;
    for (let i = 0; i < 10; i++) first = host(document.createElement('li'), null, first);
    const component = fiber(function List() {});
    component.child = first;

    expect(getAllDOMNodes(component, 3)).toHaveLength(3);
  });
});

describe('collectChain', () => {
  function mountChain(names: string[]): Element {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host')!;
    let parent: Fiber | null = null;
    // Build outermost → innermost, so `names[0]` ends up the root.
    for (const name of names) {
      parent = fiber({ [name]: function () {} }[name], parent);
    }
    attach(host, fiber('div', parent));
    return host;
  }

  it('reads outermost first, so the chain is a path', () => {
    const host = mountChain(['App', 'ProductPage', 'AddToCartButton']);
    const { entries, truncated } = collectChain(host);
    expect(entries.map((e) => e.name)).toEqual(['App', 'ProductPage', 'AddToCartButton']);
    expect(truncated).toBe(false);
  });

  it('keeps the nearest components and flags the truncation', () => {
    const names = Array.from({ length: MAX_COMPONENT_CHAIN + 5 }, (_, i) => `C${i}`);
    const { entries, truncated } = collectChain(mountChain(names));

    expect(entries).toHaveLength(MAX_COMPONENT_CHAIN);
    expect(truncated).toBe(true);
    // The far end of a deep tree is providers; the near end is where the click was.
    expect(entries[entries.length - 1].name).toBe(`C${names.length - 1}`);
    expect(entries[0].name).not.toBe('C0');
  });

  it('collapses a lazy fiber and the fiber it resolved to into one entry', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host')!;
    const Modal = function Modal() {};
    const outer = fiber({ _payload: { _status: 1, _result: Modal } }, null);
    const inner = fiber(Modal, outer);
    attach(host, fiber('div', inner));

    expect(collectChain(host).entries.map((e) => e.name)).toEqual(['Modal']);
  });

  it('returns nothing, and does not throw, outside a React tree', () => {
    document.body.innerHTML = '<div id="host"></div>';
    expect(collectChain(document.getElementById('host')!)).toEqual({ entries: [], truncated: false });
  });
});

describe('hasReactRoot', () => {
  /*
   * Distinct from "did this click land in a component". A click can miss the
   * root on a page that is React everywhere else, and giving up on that would
   * lose the rest of the recording.
   */
  it('finds a container marked on a mount node', () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById('root')!;
    (root as unknown as Record<string, unknown>)['__reactContainer$xyz'] = {};
    expect(hasReactRoot(document)).toBe(true);
  });

  it('is false on a page with no React anywhere', () => {
    document.body.innerHTML = '<div id="root"><p>plain</p></div>';
    expect(hasReactRoot(document)).toBe(false);
  });
});

/**
 * Shadow roots.
 *
 * Two things break at the boundary and both are fixed the same way. `parentElement`
 * is null on the top node inside a shadow root, so an upward walk stops one hop
 * short of the component that rendered the host; and a document-level listener
 * only ever sees `event.target` retargeted *to* that host, so React mounted
 * inside the root is invisible from the outside.
 */
describe('crossing a shadow boundary', () => {
  it('walks out of a shadow root to the component that rendered the host', () => {
    const host = document.createElement('my-widget');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('button');
    root.append(inner);

    // React is outside: the host is what it rendered, and the button is the web
    // component's own markup, which no fiber points at.
    const f = fiber(function Toolbar() {});
    attach(host, f);

    expect(findNearestComponentFiber(inner)).toBe(f);
  });

  it('finds React that is mounted inside the shadow root', () => {
    const host = document.createElement('my-widget');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('button');
    root.append(inner);

    const f = fiber(function Toolbar() {});
    attach(inner, f);

    expect(findNearestComponentFiber(inner)).toBe(f);
  });

  it('takes the composed target, not the host the event was retargeted to', () => {
    const host = document.createElement('my-widget');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('button');
    root.append(inner);

    let seen: Element | null = null;
    document.addEventListener('click', (event) => {
      // What a document listener is handed, and why `event.target` is not enough.
      expect(event.target).toBe(host);
      seen = interactionTarget(event);
    });
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(seen).toBe(inner);
  });

  it('falls back to the target for an event with no composed path', () => {
    const el = document.createElement('button');
    // A synthetic event, as a test harness or an old browser might dispatch it.
    const event = { target: el } as unknown as Event;
    expect(interactionTarget(event)).toBe(el);
  });

  it('is null for an event on nothing that is an element', () => {
    expect(interactionTarget({ target: null } as unknown as Event)).toBeNull();
  });
});
