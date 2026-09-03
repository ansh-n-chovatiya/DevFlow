/**
 * The component chain above one element, in Vue's terms.
 *
 * ## What `instance.parent` is, and what it is not
 *
 * It is the **render-tree** parent. A component authored inside `App` and passed
 * into a wrapper as slot content climbs `DeepLeaf → MidLevel → App`, because
 * `MidLevel` is what rendered it, even though `App` is what wrote it. React's
 * fiber carries both — `return` for the render parent and `_debugOwner` for the
 * lexical one — and `core/react/owner.ts` is built on the second. Nothing
 * equivalent was found on a Vue instance in any build measured, so this chain is
 * the render tree and says so. Claiming otherwise would put a lexical answer's
 * name on a render-tree walk, and nothing downstream could tell.
 *
 * ## Why the cap counts from the element outwards
 *
 * The same reason `collectChain` gives for React: the far end of a deep tree is
 * `App` wrapped in nine providers, and on a Nuxt page it is worse — three of the
 * seven links above a leaf were measured to be `RouteProvider`, `RouterView` and
 * `NuxtPage`, and the two above those live in `node_modules/nuxt/dist/`. What
 * identifies where a click landed is the near end, so the near end is what a
 * full chain keeps.
 *
 * Framework wrappers are **not** filtered out here. Whether a resolution is
 * plumbing is decided from its resolved path, which does not exist until the
 * search has run, and deciding it early from a name is the mistake
 * `core/react/owner.ts` is written to avoid — it is a pure function over the
 * finished table for exactly this reason. Dropping `RouterView` here would
 * freeze that judgement before its evidence existed.
 *
 * Pure — no DOM, no Chrome, no network.
 */

import { MAX_COMPONENT_CHAIN } from '../../shared/constants.js';
import type { Resolution } from '../locate/adapter.js';
import { resolveInstance, type VueInstance } from './instance.js';

export interface VueChain {
  /** Outermost first, as `ResolvedChain.chain` is read. */
  chain: Resolution[];
  /** The cap was hit, so `chain[0]` is not the app root. */
  truncated: boolean;
}

/**
 * Every component from `instance` up to the app root, outermost first.
 *
 * `limit` defaults to the compiled-in `MAX_COMPONENT_CHAIN` so a caller holding
 * no settings still gets the shipped answer. It also bounds the climb outright,
 * which is the whole cycle guard this needs: each turn of the loop adds one
 * entry, so a `parent` pointer that looped could not outrun it.
 */
export function chainFromInstance(
  instance: VueInstance | null | undefined,
  limit = MAX_COMPONENT_CHAIN,
): VueChain {
  if (!instance) return { chain: [], truncated: false };

  const chain: Resolution[] = [];
  let current: VueInstance | null | undefined = instance;
  let truncated = false;

  while (current) {
    if (chain.length >= limit) {
      truncated = true;
      break;
    }
    chain.push(resolveInstance(current));
    current = current.parent;
  }

  // Built nearest-first by the climb; the chain reads outermost-first.
  chain.reverse();
  return { chain, truncated };
}
