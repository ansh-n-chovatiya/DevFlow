/**
 * The production fallback walk, and the two rules it cannot be right without.
 *
 * This walk only exists because a default production build strips
 * `__vueParentComponent` from every element and installing the devtools hook at
 * runtime does not bring it back. It is the whole of the production path, so a
 * quiet mistake in it is a quiet mistake in every attribution on every minified
 * Vue page.
 *
 * Both rules below failed in the spike before they were rules, and both failed
 * *without an error*: following `children[]` alone reached nothing on Nuxt, and
 * latching the shallowest `el` match named the parent component. So each is
 * tested by asserting the specific right answer, and each has a companion test
 * that shows what the wrong version would have returned.
 */

import { describe, expect, it } from 'vitest';
import { findOwnerOfElement, VUE_MAX_VNODE_WALK } from '../src/core/vue/tree.js';
import type { VueInstance, VueVNode } from '../src/core/vue/instance.js';
import {
  nuxtApp,
  nuxtSentinels,
  plainVueApp,
  plainVueSentinels,
} from './vue-fixtures.test.js';

describe('the deepest match wins', () => {
  /*
   * The measured mis-attribution: a component vnode and the element vnode it
   * rendered both have `el === the button`, so a walk that stops at the first
   * hit stops one level too high. The spike's first walk reported `MidLevel`
   * for a button that `DeepLeaf` rendered.
   */
  it('names DeepLeaf for the button, not the component that contains it', () => {
    const els = plainVueSentinels();
    const { rootVNode, instances } = plainVueApp(els, 'production');

    const found = findOwnerOfElement(rootVNode, els.leaf);

    expect(found.owner).toBe(instances.leaf);
    expect(found.owner).not.toBe(instances.mid);
    expect(found.exhausted).toBe(false);
  });

  it('names each of the three authoring styles for its own root element', () => {
    const els = plainVueSentinels();
    const { rootVNode, instances } = plainVueApp(els, 'production');

    expect(findOwnerOfElement(rootVNode, els.mid).owner).toBe(instances.mid);
    expect(findOwnerOfElement(rootVNode, els.optionsP).owner).toBe(instances.options);
    expect(findOwnerOfElement(rootVNode, els.renderFnDiv).owner).toBe(instances.renderFn);
  });

  it('names the enclosing component for a plain element it rendered', () => {
    const els = plainVueSentinels();
    const { rootVNode, instances } = plainVueApp(els, 'production');

    // `h1#title` is an element vnode inside App's subTree and mounts no
    // component of its own, so App is the right and only answer.
    expect(findOwnerOfElement(rootVNode, els.title).owner).toBe(instances.app);
  });

  /*
   * The companion to the rule: a component vnode claims the element it mounted
   * outright, so the answer is right even when the deeper vnode that would
   * otherwise carry it is missing — a component rendering a fragment, or a
   * subTree not yet attached.
   */
  it('lets a component claim its own root element with no subTree below it', () => {
    const button = { tag: 'BUTTON' };
    const parent: VueInstance = { uid: 0, type: { __name: 'Parent' }, parent: null };
    const child: VueInstance = { uid: 1, type: { __name: 'Child' }, parent, subTree: null };

    const childVNode: VueVNode = { type: child.type, el: button, component: child };
    const root: VueVNode = {
      type: parent.type,
      el: { tag: 'DIV' },
      component: parent,
    };
    parent.subTree = { type: 'div', el: root.el, children: [childVNode] };

    expect(findOwnerOfElement(root, button).owner).toBe(child);
  });
});

describe('Suspense', () => {
  /*
   * The one that decided the shape of this walk. Nuxt wraps the app root *and*
   * every page in a `<Suspense>`, and a Suspense vnode keeps its content in
   * `suspense.activeBranch` — never in `children`, which is `undefined` on it.
   * Following `component.subTree` and `children[]` alone reached nothing at all
   * on a Nuxt page: `instanceSource=NONE`, not a wrong component.
   */
  it('reaches a Nuxt leaf through both boundaries', () => {
    const els = nuxtSentinels();
    const { rootVNode, instances } = nuxtApp(els, 'production');

    expect(findOwnerOfElement(rootVNode, els.leaf).owner).toBe(instances.leaf);
    expect(findOwnerOfElement(rootVNode, els.title).owner).toBe(instances.index);
    expect(findOwnerOfElement(rootVNode, els.islandRoot).owner).toBe(instances.island);
  });

  /*
   * What the walk that does not hop the boundary would have returned. Blanking
   * both branches leaves the boundary with nothing else to follow — no
   * `children`, no `ssContent` — and everything under it becomes unreachable,
   * which is the `instanceSource=NONE` the spike printed.
   */
  it('reaches nothing below a boundary whose branches are gone', () => {
    const els = nuxtSentinels();
    const { rootVNode, instances } = nuxtApp(els, 'production');

    const outer = instances.nuxtRoot.subTree;
    expect(outer?.suspense).toBeTruthy();
    outer!.suspense = { activeBranch: null, pendingBranch: null };

    expect(findOwnerOfElement(rootVNode, els.leaf).owner).toBeNull();
  });

  it('takes the pending branch when nothing has resolved yet', () => {
    const els = nuxtSentinels();
    const { rootVNode, instances } = nuxtApp(els, 'production');

    const outer = instances.nuxtRoot.subTree;
    const branch = outer!.suspense!.activeBranch!;
    outer!.suspense = { activeBranch: null, pendingBranch: branch };

    expect(findOwnerOfElement(rootVNode, els.leaf).owner).toBe(instances.leaf);
  });

  it('falls back to ssContent when neither branch has been chosen', () => {
    const els = nuxtSentinels();
    const { rootVNode, instances } = nuxtApp(els, 'production');

    const outer = instances.nuxtRoot.subTree;
    const branch = outer!.suspense!.activeBranch!;
    outer!.suspense = { activeBranch: null, pendingBranch: null };
    outer!.ssContent = branch;

    expect(findOwnerOfElement(rootVNode, els.leaf).owner).toBe(instances.leaf);
  });
});

describe('the budget', () => {
  /*
   * The cost of this walk on a real application was never measured — the
   * spike's trees were thirteen vnodes deep — and it runs on every click of the
   * whole production path. Running out is reported rather than returned as a
   * miss, because "no component drew this" and "we stopped looking" are
   * different facts about the page.
   */
  it('reports exhaustion rather than a silent miss', () => {
    const els = plainVueSentinels();
    const { rootVNode } = plainVueApp(els, 'production');

    const found = findOwnerOfElement(rootVNode, els.leaf, 3);

    expect(found.exhausted).toBe(true);
    expect(found.owner).toBeNull();
    expect(found.visited).toBe(3);
  });

  it('finishes well inside the shipped default', () => {
    const els = plainVueSentinels();
    const { rootVNode, instances } = plainVueApp(els, 'production');

    const found = findOwnerOfElement(rootVNode, els.leaf, VUE_MAX_VNODE_WALK);

    expect(found.owner).toBe(instances.leaf);
    expect(found.exhausted).toBe(false);
    expect(found.visited).toBeLessThan(32);
  });
});

describe('nothing to walk', () => {
  it('reports a clean miss for an element no vnode owns', () => {
    const els = plainVueSentinels();
    const { rootVNode } = plainVueApp(els, 'production');

    const found = findOwnerOfElement(rootVNode, { tag: 'SPAN', id: 'island-inner' });

    expect(found.owner).toBeNull();
    expect(found.exhausted).toBe(false);
    expect(found.visited).toBeGreaterThan(0);
  });

  it('walks nothing when there is no root or no target', () => {
    const els = plainVueSentinels();
    const { rootVNode } = plainVueApp(els, 'production');

    expect(findOwnerOfElement(null, els.leaf)).toEqual({
      owner: null,
      visited: 0,
      exhausted: false,
    });
    expect(findOwnerOfElement(rootVNode, null)).toEqual({
      owner: null,
      visited: 0,
      exhausted: false,
    });
  });
});
