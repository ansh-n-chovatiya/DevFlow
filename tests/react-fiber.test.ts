// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectChain,
  findNearestComponentFiber,
  getDisplayName,
  getFiber,
  hasReactRoot,
  interactionTarget,
  unwrapSettledLazy,
  type Fiber,
} from '../src/core/react/fiber.js';
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

describe('unwrapSettledLazy', () => {
  /*
   * The whole reason this diverges from react-source-locator: calling `_init`
   * can start a dynamic import, which would mean recording a page changes what
   * that page loads. There is no `force` flag here precisely so no call site can.
   */
  it('never initialises a payload that has not settled', () => {
    const init = vi.fn();
    expect(unwrapSettledLazy({ _payload: { _status: 0 }, _init: init } as never)).toBeNull();
    expect(init).not.toHaveBeenCalled();
  });

  it('reads a settled payload, including a module default export', () => {
    const Modal = function Modal() {};
    expect(unwrapSettledLazy({ _payload: { _status: 1, _result: { default: Modal } } })).toBe(Modal);
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
