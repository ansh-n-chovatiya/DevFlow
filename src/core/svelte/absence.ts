/**
 * Why this Svelte element has no component, said in a way a reader can act on.
 *
 * ## This is the common path, not the edge case
 *
 * For React, an absence is a miss. For Svelte production it is the *answer*, and
 * the adapter's honesty depends entirely on this file. Measured
 * (`.ctx/spike-svelte.md`, Finding 1 and Finding 5): a production Svelte element
 * has zero own properties, the production bundle contains zero occurrences of
 * `__svelte_meta`, `add_locations`, `componentTag` or `FILENAME`, and there is no
 * global element-to-component map anywhere on `window`. There is nothing to
 * search for and nothing to guess from. An adapter that produced a file anyway —
 * by chasing `element[Symbol('events')]` to the *event handler* and needling a
 * 9-character minified arrow through a megabyte of bundle — would be confidently
 * wrong far more often than right, and a confident wrong file is worse than a
 * blank.
 *
 * ## Why two reasons and not one
 *
 * The two states look identical from the DOM — no `__svelte_meta`, nothing
 * attached — and they have opposite fixes:
 *
 *   `not-hydrated`       the server sent this markup and the client runtime has
 *                        not run yet. **Waiting fixes it.** SvelteKit ships
 *                        fully-rendered HTML with hydration comment markers, so
 *                        an element genuinely exists before anything attaches to
 *                        it; Finding 7a calls this out as a case the adapter has
 *                        to tolerate.
 *   `stripped-by-build`  the runtime is running and this build kept nothing.
 *                        **Waiting never fixes it**, and telling somebody to wait
 *                        for a page that has already finished is the worst
 *                        outcome available here.
 *
 * ## What tells them apart, and why it is this signal
 *
 * `window.__svelte` is registered by `internal/disclose-version.js`, which the
 * client runtime imports unconditionally. The spike measured it present in all
 * four targets — plain dev, plain prod, Kit dev, Kit prod — so its *absence* on
 * a page that is plainly Svelte markup means the client bundle has not evaluated.
 * That is the discriminator: server markup on the page, client runtime not yet
 * present.
 *
 * The alternative was to infer hydration from `Symbol(events)` appearing on
 * elements. Rejected, and rejected on a measurement: that symbol lands only on
 * elements bound to one of the 23 delegated events, so an app that uses none —
 * or a page of an app where none is on screen — would be reported as
 * permanently un-hydrated. It is kept below as a *veto* rather than a test,
 * because its presence proves the client ran even though its absence proves
 * nothing.
 *
 * Pure — no DOM, no Chrome, no clock. `src/injected/svelte.ts` gathers the
 * evidence; the judgement is here so it can be tested without a browser.
 */

import type { AbsentReason } from '../locate/adapter.js';

/**
 * What the page as a whole said, gathered once per resolution.
 *
 * Deliberately a record of booleans rather than a `Document`: every field is one
 * measured observation, which is what makes the rule below readable as a rule
 * and testable without a DOM.
 */
export interface PageEvidence {
  /** `window.__svelte` exists — the client runtime module has evaluated. */
  runtimeGlobal: boolean;
  /** Some element carries `__svelte_meta`. Development builds only. */
  devMetaAnywhere: boolean;
  /** Some element carries Svelte's delegated-event symbol — so the client ran. */
  delegatedEventsAnywhere: boolean;
  /** SSR hydration comment markers are in the document. */
  hydrationMarkers: boolean;
  /** The markup is SvelteKit's, from its server-emitted `data-sveltekit-*`. */
  sveltekit: boolean;
}

export interface Absence {
  reason: AbsentReason;
  detail: string;
}

/**
 * `build.sourcemap` is named because it is the one thing the reader can change
 * in their own repository, and because SvelteKit's default is measurably the
 * wrong one: a default Kit production build ships **0** `.map` files and no
 * `sourceMappingURL`, and 8 maps the moment `build.sourcemap: true` is set.
 *
 * The sentence is careful not to promise that source maps alone will do it. They
 * are necessary and not sufficient — the element-to-component link is stripped
 * whether or not maps exist — and a sentence that implied otherwise would send
 * somebody to rebuild their app for nothing.
 */
const KIT_DETAIL =
  'Svelte strips __svelte_meta from production builds, so this element carries no link to the ' +
  'component that rendered it. SvelteKit also ships no source maps by default: set ' +
  'build.sourcemap: true in your Vite config so production positions are recoverable at all, ' +
  'and open the page on a dev server to get the component itself.';

const PLAIN_DETAIL =
  'Svelte strips __svelte_meta from production builds, so this element carries no link to the ' +
  'component that rendered it. Only a development build carries that link; set build.sourcemap: ' +
  'true in your Vite config if you also need production positions to be recoverable.';

const NOT_HYDRATED_DETAIL =
  'This markup was rendered on the server and the Svelte client runtime has not attached to it ' +
  'yet. Nothing on the page links an element to a component until hydration runs, so this one ' +
  'should resolve once it has.';

/**
 * The reason, and the sentence that goes with it.
 *
 * The veto is first on purpose. Anything attached anywhere on the page proves the
 * client runtime ran, and once it has run, "not hydrated yet" is a claim about
 * the future that will never come true.
 */
export function classifyAbsence(evidence: PageEvidence): Absence {
  const clientRan = evidence.runtimeGlobal || evidence.devMetaAnywhere || evidence.delegatedEventsAnywhere;

  if (!clientRan && evidence.hydrationMarkers) {
    return { reason: 'not-hydrated', detail: NOT_HYDRATED_DETAIL };
  }

  return {
    reason: 'stripped-by-build',
    detail: evidence.sveltekit ? KIT_DETAIL : PLAIN_DETAIL,
  };
}
