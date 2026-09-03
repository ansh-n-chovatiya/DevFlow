/**
 * The climb out of one instance, and the two things it deliberately does not do.
 *
 * It does not claim to be a lexical chain — `instance.parent` is the render tree
 * and Vue has no `_debugOwner` — and it does not drop framework wrappers, even
 * though five of the seven links above a Nuxt leaf are Nuxt's and vue-router's.
 * Both are decisions with a cost, so both are asserted here rather than left to
 * a header nobody reads twice.
 */

import { describe, expect, it } from 'vitest';
import { chainFromInstance } from '../src/core/vue/chain.js';
import type { VueInstance } from '../src/core/vue/instance.js';
import { MAX_COMPONENT_CHAIN } from '../src/shared/constants.js';
import {
  DEV_FILES,
  MEASURED,
  nuxtApp,
  nuxtSentinels,
  plainVueApp,
  plainVueSentinels,
} from './vue-fixtures.test.js';

function names(chain: { name?: string }[]): (string | undefined)[] {
  return chain.map((entry) => entry.name);
}

describe('the chain reads outermost first', () => {
  it('is App, MidLevel, DeepLeaf in development, all of them declared', () => {
    const { instances } = plainVueApp(plainVueSentinels(), 'development');

    const { chain, truncated } = chainFromInstance(instances.leaf);

    expect(names(chain)).toEqual(['App', 'MidLevel', 'DeepLeaf']);
    expect(chain.map((entry) => entry.kind)).toEqual(['declared', 'declared', 'declared']);
    expect(chain[2].kind === 'declared' && chain[2].source).toBe(DEV_FILES.deepLeaf);
    expect(truncated).toBe(false);
  });

  /*
   * The same three components in a default production build. `__file` is gone
   * from all of them, so every link is a needle taken from its render function
   * — and the innermost one is the render function, not the setup beside it.
   */
  it('is the same three components as searchable functions in production', () => {
    const { instances } = plainVueApp(plainVueSentinels(), 'production');

    const { chain } = chainFromInstance(instances.leaf);

    expect(names(chain)).toEqual(['App', 'MidLevel', 'DeepLeaf']);
    expect(chain.map((entry) => entry.kind)).toEqual(['searchable', 'searchable', 'searchable']);
    expect(chain[2].kind === 'searchable' && chain[2].fnSource).toBe(MEASURED.deepLeafProdRender);
  });

  /*
   * `DeepLeaf` is authored in `App` and passed into `MidLevel` as slot content.
   * React's fiber would give the lexical owner through `_debugOwner`; nothing on
   * a Vue instance does, in any build measured, so `MidLevel` is in the chain
   * and this adapter does not pretend otherwise.
   */
  it('is the render tree, so the slot wrapper is in it', () => {
    const { instances } = plainVueApp(plainVueSentinels(), 'development');
    expect(names(chainFromInstance(instances.leaf).chain)).toContain('MidLevel');
  });
});

describe('framework wrappers stay in', () => {
  /*
   * Whether a component is plumbing is decided from its resolved path, which
   * does not exist until the search has run — `core/react/owner.ts` is a pure
   * function over the finished table for exactly this reason. Dropping
   * `RouterView` here would freeze that judgement before its evidence existed,
   * and would do it on a name, which says nothing on a minified build.
   */
  it('keeps all five Nuxt and router links above a page leaf', () => {
    const { instances } = nuxtApp(nuxtSentinels(), 'development');

    const { chain, truncated } = chainFromInstance(instances.leaf);

    expect(names(chain)).toEqual([
      'nuxt-root',
      'Anonymous', // app.vue: a template-only SFC has no name in any build
      'NuxtPage',
      'RouterView',
      'RouteProvider',
      'index',
      'NuxtDeepLeaf',
    ]);
    expect(truncated).toBe(false);
  });
});

describe('the cap', () => {
  it('counts from the element outwards and says when it bit', () => {
    const { instances } = nuxtApp(nuxtSentinels(), 'development');

    const { chain, truncated } = chainFromInstance(instances.leaf, 3);

    // The three nearest the element, still read outermost first — the far end
    // of the chain is what gets dropped, because `nuxt-root` and `app.vue`
    // identify nothing about where the click landed.
    expect(names(chain)).toEqual(['RouteProvider', 'index', 'NuxtDeepLeaf']);
    expect(truncated).toBe(true);
  });

  it('defaults to the shipped constant', () => {
    const { instances } = nuxtApp(nuxtSentinels(), 'development');
    expect(chainFromInstance(instances.leaf).chain.length).toBeLessThanOrEqual(
      MAX_COMPONENT_CHAIN,
    );
  });

  /* The cap is also the cycle guard: one entry per turn means it cannot run on. */
  it('bounds a parent pointer that loops', () => {
    const a: VueInstance = { uid: 0, type: { __name: 'A' }, parent: null };
    const b: VueInstance = { uid: 1, type: { __name: 'B' }, parent: a };
    a.parent = b;

    const { chain, truncated } = chainFromInstance(b, 5);

    expect(chain).toHaveLength(5);
    expect(truncated).toBe(true);
  });

  it('is empty for no instance at all', () => {
    expect(chainFromInstance(null)).toEqual({ chain: [], truncated: false });
    expect(chainFromInstance(undefined)).toEqual({ chain: [], truncated: false });
  });
});
