/**
 * The Vue 3 / Nuxt reader: from a DOM element to the components that rendered
 * it.
 *
 * This is the DOM half of the adapter and the only half that touches one. Every
 * decision it makes about *what a Vue instance means* lives in `src/core/vue/`,
 * which is pure and testable without a browser; what is here is the three
 * questions that need the document — is there a Vue app on this page, does this
 * element still carry a link to its component, and if not, where does the walk
 * start.
 *
 * ## Nothing is installed, patched or subscribed to
 *
 * `__VUE_DEVTOOLS_GLOBAL_HOOK__` is not read here and is certainly not written.
 * It would be tempting: Vue's reactivity makes a subscription look cheap, and
 * the hook is the documented way in. Two measurements close it off. Vue does not
 * create the hook at all — it was `undefined` on all five targets before
 * anything ran — and installing one **does not restore the element markers a
 * production build stripped**: the flag that controls them is `__VUE_PROD_DEVTOOLS__`,
 * read at build time. So installing a hook buys nothing and costs the thing
 * `v3.2.0` was reverted for, which was writing to a page global that other
 * extensions and the page itself depend on.
 *
 * ## Three paths, in this order, and the order is the point
 *
 * 1. **Inside a Nuxt island.** Checked first, because it is the one case where
 *    climbing finds a real component and that component is the wrong answer. An
 *    island's interior is raw HTML injected by `NuxtIsland`; no vnode anywhere
 *    in the tree has `el === it`, in development or in production. The nearest
 *    thing above it that *does* resolve is Nuxt's own wrapper in
 *    `nuxt/dist/app/components/nuxt-island.js`, whose `setup` source is in the
 *    bundle — so a walk that did not stop here would resolve confidently to a
 *    file inside Nuxt rather than to the island the author wrote. That is worse
 *    than a miss, so the interior is reported `absent` with the reason, beneath
 *    the chain of components that really are above it.
 * 2. **`__vueParentComponent`.** One property read. Present on every rendered
 *    element in development, and in a production build compiled with
 *    `__VUE_PROD_DEVTOOLS__`.
 * 3. **The vnode walk.** What a default production build leaves: the mount
 *    container keeps `__vue_app__` and `_vnode` when every element below it has
 *    been stripped bare. See `core/vue/tree.ts` for the two rules that walk has
 *    to obey.
 *
 * ## The budget is a parameter with a default
 *
 * `VUE_MAX_VNODE_WALK` should be a setting — the walk's cost on a real
 * application was never measured, and it is the per-click cost of the whole
 * production path. It cannot be one yet: `src/features/settings/fields.ts` is
 * owned elsewhere in this wave. So the number is threaded through as an argument
 * with the compiled-in default, which is the shape it will keep once the setting
 * exists.
 */

import type {
  FrameworkAdapter,
  FrameworkPresence,
  ResolvedChain,
  Resolution,
} from '../core/locate/adapter.js';
import { declaredFileOf, type VueApp, type VueInstance, type VueVNode } from '../core/vue/instance.js';
import { climb } from '../core/dom/walk.js';
import { chainFromInstance } from '../core/vue/chain.js';
import { findOwnerOfElement, VUE_MAX_VNODE_WALK } from '../core/vue/tree.js';
import { containerCandidates } from './roots.js';

/** The app object, on a mount container and nowhere else. */
const APP_KEY = '__vue_app__';
/** The owning instance, on every rendered element until a production build removes it. */
const PARENT_KEY = '__vueParentComponent';
/** The root vnode, on a mount container. Survives production; the element keys do not. */
const ROOT_VNODE_KEY = '_vnode';
/** Nuxt stamps this on an island's root element. Its interior is server HTML. */
const ISLAND_SELECTOR = '[data-island-uid]';

function own<T>(el: Element, key: string): T | null {
  const value = (el as unknown as Record<string, unknown>)[key];
  return value === undefined || value === null ? null : (value as T);
}



/** The mount container above `el`, with its app object, or null. */
function findMountContainer(el: Element): { container: Element; app: VueApp } | null {
  let node: Element | null = el;
  while (node && node !== node.ownerDocument.documentElement) {
    const app = own<VueApp>(node, APP_KEY);
    if (app) return { container: node, app };
    node = climb(node);
  }
  return null;
}

/** The nearest instance an element or one of its ancestors still points at. */
function findParentComponent(el: Element): VueInstance | null {
  let node: Element | null = el;
  while (node && node !== node.ownerDocument.documentElement) {
    const instance = own<VueInstance>(node, PARENT_KEY);
    if (instance?.type) return instance;
    node = climb(node);
  }
  return null;
}

function absent(reason: Extract<Resolution, { kind: 'absent' }>): ResolvedChain {
  return { framework: 'vue', chain: [reason] };
}

/**
 * Is there a Vue app on this page, and can it still say what rendered what?
 *
 * Never walks the tree — it reads at most one property off each of a handful of
 * candidate containers, which is the same candidate set `hasReactRoot` uses and
 * for the same reason: an app is nearly always mounted into `<body>` or a direct
 * child of it, and scanning every element to find out would cost more than the
 * walk this feeds.
 *
 * `build` is inferred from two measured facts and reports `'unknown'` rather
 * than guessing past them. `app._instance` is **`null` in a default production
 * build** and populated in development and under `__VUE_PROD_DEVTOOLS__` — the
 * key is always present in `Object.keys(app)`, so this is a truthiness check and
 * not an `in` check. That separates default production from the other two. What
 * separates those two is the shape of `__file` on the root component: an
 * absolute filesystem path in development, a bare basename under
 * `__VUE_PROD_DEVTOOLS__`. A root with no `__file` at all — a non-SFC root — is
 * `'unknown'`, which is true.
 */
export function detectVue(): FrameworkPresence {
  for (const el of containerCandidates()) {
    const app = own<VueApp>(el, APP_KEY);
    if (!app) continue;

    const version = typeof app.version === 'string' ? app.version : undefined;
    const root = app._instance;
    const build: FrameworkPresence['build'] = !root
      ? 'production'
      : declaredFileOf(root.type)
        ? 'development'
        : 'unknown';

    return { framework: 'vue', detected: true, ...(version ? { version } : {}), build };
  }

  return { framework: 'vue', detected: false };
}

/**
 * The components above one element, outermost first, or null if the element is
 * not inside a Vue app at all.
 *
 * Null and `absent` are different answers and both are needed. Null means *"this
 * is not mine"* — most of the web is not a Vue page and the agent is injected
 * into all of it. `absent` means *"this is mine and this build will not tell
 * you"*, which is a fact about the page the reader can act on.
 */
export function vueChainFromElement(el: Element, budget = VUE_MAX_VNODE_WALK): ResolvedChain | null {
  const mount = findMountContainer(el);
  if (!mount) return null;

  const islandRoot = el.closest(ISLAND_SELECTOR);
  if (islandRoot && islandRoot !== el) {
    // Everything above the island is a real client component and is worth
    // reporting; the interior itself is not one, and says so as the innermost
    // link rather than by being missing.
    const above = vueChainFromElement(islandRoot, budget);
    const interior: Resolution = {
      kind: 'absent',
      reason: 'server-rendered',
      detail:
        'This markup came from a Nuxt server component (island). Its interior is HTML injected by ' +
        'NuxtIsland — no vnode in the client tree renders it, in development or in production — so ' +
        'the component that wrote it never ran in this browser.',
    };
    return {
      framework: 'vue',
      chain: [...(above?.chain ?? []), interior],
      ...(above?.truncated ? { truncated: true } : {}),
    };
  }

  const linked = findParentComponent(el);
  if (linked) {
    const { chain, truncated } = chainFromInstance(linked);
    return { framework: 'vue', chain, ...(truncated ? { truncated: true } : {}) };
  }

  const root =
    own<VueVNode>(mount.container, ROOT_VNODE_KEY) ??
    mount.app._instance?.vnode ??
    mount.app._instance?.subTree ??
    null;

  if (!root) {
    return absent({
      kind: 'absent',
      reason: 'not-hydrated',
      detail:
        'A Vue app is mounted on this container but has rendered nothing into it yet: it carries ' +
        '__vue_app__ and no _vnode. Server-rendered markup below it has no client component until ' +
        'hydration runs.',
    });
  }

  const found = findOwnerOfElement(root, el, budget);

  if (found.owner) {
    const { chain, truncated } = chainFromInstance(found.owner);
    return { framework: 'vue', chain, ...(truncated ? { truncated: true } : {}) };
  }

  if (found.exhausted) {
    /*
     * The contract has no reason that means "the search ran and gave up" — by
     * its own argument those belong to `ComponentStatus`, which `fromElement`
     * does not return. `stripped-by-build` is nonetheless true and is the reason
     * this expensive path was taken at all: the build removed the link, and its
     * replacement did not finish. The detail carries what actually happened, and
     * a fourth reason is written up for the integrator.
     */
    return absent({
      kind: 'absent',
      reason: 'stripped-by-build',
      detail:
        `This build removed the element-to-component link, and the vnode walk that replaces it ` +
        `visited ${found.visited} vnodes without reaching this element before its budget ran out.`,
    });
  }

  return absent({
    kind: 'absent',
    reason: 'server-rendered',
    detail:
      `The Vue app on this page rendered ${found.visited} vnodes and none of them owns this ` +
      'element, so no component in this browser drew it. Server-rendered markup left outside the ' +
      'client tree reads exactly like this.',
  });
}

/**
 * Vue's reader, as the frozen contract asks for it.
 *
 * The budget cannot be passed through `fromElement` — the interface takes an
 * element and nothing else — so it is the compiled-in default here and an
 * argument on `vueChainFromElement` for anything that has a number in hand.
 */
export const vueAdapter: FrameworkAdapter = {
  framework: 'vue',
  detect: detectVue,
  fromElement: (el: Element) => vueChainFromElement(el),
};
