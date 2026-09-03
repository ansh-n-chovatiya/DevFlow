/**
 * Finding the component that rendered an element when the element itself has
 * stopped saying.
 *
 * ## Why this walk exists at all
 *
 * In development every rendered element carries `__vueParentComponent`, and the
 * answer costs one property read. A default production build removes it — from
 * every element, in plain Vue and in Nuxt alike — and it cannot be talked into
 * putting it back: installing `__VUE_DEVTOOLS_GLOBAL_HOOK__` at runtime changes
 * nothing, because `__VUE_PROD_DEVTOOLS__` is a compile-time flag. That was
 * measured directly: Vue wrote an `enabled` key onto the hook object in
 * development and in a `__VUE_PROD_DEVTOOLS__` build, and did not touch it in a
 * default production build.
 *
 * What survives on a production page is the mount container, which keeps
 * `__vue_app__` and `_vnode`. So the fallback is to walk down from there looking
 * for the vnode whose `el` **is** the element — O(tree) per click, which is why
 * the contract says `fromElement` is permitted to be expensive.
 *
 * ## Two rules that were learned the hard way, and are not optional
 *
 * **Suspense is not in `children`.** Nuxt wraps the app root *and* every page in
 * a `<Suspense>`, and a Suspense vnode keeps its content in
 * `suspense.activeBranch`. A walk that follows only `component.subTree` and
 * `children[]` reaches literally nothing on a Nuxt page — not the wrong
 * component, no component — because both hops out of the root are through a
 * boundary it cannot see. Following `activeBranch` recovered the whole
 * thirteen-level tree.
 *
 * **The deepest match wins, not the shallowest.** A component vnode and the
 * element vnode it renders both have `el === target`, so a walk that latches on
 * the first hit stops one level too high and names the *parent* component: it
 * reported `MidLevel` for a button that `DeepLeaf` rendered. Depth is compared
 * rather than trusting arrival order, and a component vnode additionally claims
 * its own root element outright — a component owns the element it mounted, and
 * a fragment root can otherwise leave the deepest hit unreachable.
 *
 * ## Why the budget is a parameter
 *
 * The cost of this walk on a large application was not measured; the spike's
 * trees were thirteen vnodes deep. A cap that cannot be moved without a release
 * is the wrong shape for a number nobody has measured yet, and a click that
 * hangs the page is the failure it guards. `VUE_MAX_VNODE_WALK` is compiled in
 * as the default so every caller with no settings in hand still gets the shipped
 * answer, exactly as `MAX_FIBER_WALK` does for the React walk.
 *
 * Pure — no DOM, no Chrome, no network. `el` is compared by identity and is
 * never read from, which is what lets a walk over live DOM-bearing objects sit
 * inside `core/`.
 */

import type { VueInstance, VueVNode } from './instance.js';

export { VUE_MAX_VNODE_WALK } from '../../shared/constants.js';
import { VUE_MAX_VNODE_WALK } from '../../shared/constants.js';

export interface VNodeWalkResult {
  /** The component that rendered the element, or null if it was never reached. */
  owner: VueInstance | null;
  /** Vnodes visited. Reported so a caller can tell a miss from a give-up. */
  visited: number;
  /** The walk ran out of budget. `owner` may be null only because of that. */
  exhausted: boolean;
}

interface Step {
  vnode: VueVNode;
  /** The component whose `subTree` this vnode is part of. */
  owner: VueInstance | null;
  depth: number;
}

function isVNode(value: unknown): value is VueVNode {
  return typeof value === 'object' && value !== null;
}

/**
 * The component that rendered `target`, by walking down from a root vnode.
 *
 * `target` is the DOM element, and is `unknown` on purpose: it is compared with
 * `===` and nothing else.
 */
export function findOwnerOfElement(
  root: VueVNode | null | undefined,
  target: unknown,
  budget = VUE_MAX_VNODE_WALK,
): VNodeWalkResult {
  if (!isVNode(root) || target === null || target === undefined) {
    return { owner: null, visited: 0, exhausted: false };
  }

  // The root vnode has no enclosing component; whatever it mounted becomes the
  // owner one hop down, and it claims its own element at match time.
  const stack: Step[] = [{ vnode: root, owner: null, depth: 0 }];
  let best: { owner: VueInstance | null; depth: number } | null = null;
  let visited = 0;

  while (stack.length > 0) {
    if (visited >= budget) return { owner: best?.owner ?? null, visited, exhausted: true };

    const step = stack.pop();
    if (!step) break;
    visited++;

    const { vnode, depth } = step;

    if (vnode.el === target) {
      // A component vnode owns the element it mounted, whatever the enclosing
      // component context is at this point in the descent.
      const owner = vnode.component ?? step.owner;
      if (best === null || depth > best.depth) best = { owner, depth };
    }

    // A component: continue inside what it rendered, and the owner becomes it.
    if (vnode.component) {
      const subTree = vnode.component.subTree;
      if (isVNode(subTree)) {
        stack.push({ vnode: subTree, owner: vnode.component, depth: depth + 1 });
      }
    }

    // A Suspense boundary. Without this hop a Nuxt page yields nothing at all.
    const suspense = vnode.suspense;
    if (suspense) {
      const branch = suspense.activeBranch ?? suspense.pendingBranch;
      if (isVNode(branch)) stack.push({ vnode: branch, owner: step.owner, depth: depth + 1 });
      else if (isVNode(vnode.ssContent)) {
        stack.push({ vnode: vnode.ssContent, owner: step.owner, depth: depth + 1 });
      }
    }

    if (Array.isArray(vnode.children)) {
      for (const child of vnode.children as unknown[]) {
        if (isVNode(child)) stack.push({ vnode: child, owner: step.owner, depth: depth + 1 });
      }
    }
  }

  return { owner: best?.owner ?? null, visited, exhausted: false };
}
