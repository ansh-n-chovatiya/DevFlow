/**
 * Which runtimes this page is, and what each says about one element.
 *
 * ## Why this returns a list and not a winner
 *
 * A page is not one framework. Every Next.js App Router page is React *and*
 * RSC — the same element has a fiber and a flight row — and a React island
 * inside a Vue application is a shipped pattern rather than a curiosity. A
 * registry that picked a winner would have to decide which of two true answers
 * to throw away, and would throw away a different one depending on the order
 * the adapters happened to be listed in.
 *
 * So every adapter that resolves the element gets to say so, and the flow
 * carries each under its own key. That is the same shape `Flow.react` already
 * has: additive, absent entirely when the page was not that framework, and not
 * a `schemaVersion` bump, because a reader that predates a key ignores it.
 *
 * **`preferResolution` is not used here**, and the roadmap said it would be.
 * That was wrong and is corrected: `preferResolution` chooses between a
 * `declared` and a `searchable` answer for *one* component, which is a decision
 * inside one adapter. Two frameworks describing one element are not two
 * candidate answers to one question — they are two true facts that belong in
 * two places.
 *
 * ## React is not in this list
 *
 * React keeps the dedicated path it has always had in `agent.ts`. It reads
 * more than this interface carries — needles, ids, stamps, `_debugSource`,
 * development-build detection — and routing it through a narrower contract to
 * look symmetrical would lose all of that for nothing. The adapters are
 * siblings of the React path, not replacements for it.
 */

import type { FrameworkAdapter, FrameworkPresence, ResolvedChain } from '../core/locate/adapter.js';
import { rscAdapter } from './rsc.js';
import { createSvelteAdapter } from './svelte.js';
import { vueAdapter } from './vue.js';

/**
 * Built once per page rather than per interaction.
 *
 * `createSvelteAdapter` takes the window it reads, so it is constructed rather
 * than imported as a constant; the other two read the document directly.
 */
export function buildAdapters(win: Window = window): readonly FrameworkAdapter[] {
  return [vueAdapter, createSvelteAdapter(win), rscAdapter];
}

/**
 * What each adapter says about the page, before any element is picked.
 *
 * Only the ones that say they are present. `detect()` is contractually cheap —
 * it reads a global and never walks a tree — so this can run on every page.
 */
export function detectFrameworks(adapters: readonly FrameworkAdapter[]): FrameworkPresence[] {
  const found: FrameworkPresence[] = [];
  for (const adapter of adapters) {
    try {
      const presence = adapter.detect();
      if (presence.detected) found.push(presence);
    } catch {
      // One runtime's detector must never cost the others their page. Nothing
      // about a framework adapter may fail a recording — the same rule
      // `arkgTry`, `gitTry` and `otelTry` hold on the server.
    }
  }
  return found;
}

/**
 * Every chain a detected framework can produce for this element.
 *
 * `fromElement` is contractually allowed to be expensive — Vue production has
 * no upward edge and searches the vnode tree — so this runs on the interaction
 * path and not on hover.
 */
export function chainsFor(
  el: Element,
  adapters: readonly FrameworkAdapter[],
): ResolvedChain[] {
  const chains: ResolvedChain[] = [];
  for (const adapter of adapters) {
    try {
      const chain = adapter.fromElement(el);
      if (chain && chain.chain.length > 0) chains.push(chain);
    } catch {
      // As above: a thrown adapter is a missing key, never a lost recording.
    }
  }
  return chains;
}
