/**
 * What a component is when it is not a fiber.
 *
 * ## Why this file exists
 *
 * `core/react/` answers one question — *given an element, which component
 * rendered it, and where was that component written* — and answers it by
 * walking a fiber tree. Vue, Svelte and React Server Components each answer the
 * same question with a different runtime, and this is the shape all four agree
 * on. It was written after the three runtimes were measured, not before: the
 * spikes are `.ctx/spike-vue.md`, `.ctx/spike-svelte.md` and
 * `.ctx/spike-rsc.md`, and the argument is ADR 0027.
 *
 * ## Why a union and not a function
 *
 * The obvious contract is *"element to component function"*, and it is wrong.
 * Measured, every one of these runtimes already knows the answer in a
 * development build and simply hands it over:
 *
 *   - Svelte writes `__svelte_meta = { loc: { file, line, column }, parent }`
 *     onto the element. That is strictly more than React's own `_debugSource`.
 *   - Vue puts `type.__file` on the component.
 *   - Next.js dev puts `_debugInfo` on the fiber, carrying the name, the owner
 *     chain and a stack that resolves to the `.tsx` it was written in.
 *
 * A contract that insisted on a function would throw that away and search the
 * bundle for an answer the page was holding out. So `declared` is an arm of its
 * own, and it beats `searchable` wherever both exist.
 *
 * `ComponentSource.via` — `'debug-source' | 'bundle-search' | 'plugin'` — is
 * already this union in disguise, which is the strongest evidence the shape is
 * right: React arrived at it for one runtime before there were four.
 *
 * ## Why `absent` carries a reason
 *
 * In a production build these runtimes stop cooperating, by different amounts,
 * and one of them stops entirely. Svelte production elements have **zero** own
 * properties, and an RSC production server component leaves no name, no module
 * id and no file anywhere on the wire. For Svelte production, "we cannot tell
 * you" is the *common* path rather than the edge case.
 *
 * A silence there reads as *"this element has no component"*, which is false.
 * A reason reads as *"this build removed the evidence"*, which is true and which
 * the reader can act on. `needle.ts` already made this choice for its own
 * refusals — `needleRejection` returns `'native'` or `'too-short'` rather than
 * an empty array — and this is the same instinct one stage earlier.
 *
 * The reasons deliberately do **not** duplicate `ComponentStatus`. `no-map`,
 * `not-found` and `ambiguous` are outcomes of a search that ran; these three are
 * the cases where there is nothing to search *for*, which is a different claim
 * and a different fix.
 *
 * Pure — no DOM, no Chrome, no network. The walk that produces these lives in
 * `src/injected/`; only the vocabulary is here.
 */

import type { Pos1 } from './positions.js';

/** The runtimes DevFlow can read. A page may genuinely be more than one. */
export type Framework = 'react' | 'vue' | 'svelte' | 'rsc';

/**
 * Why a component's identity is not in this build.
 *
 * Each of these was observed in a real production build, and each has a
 * different answer for the person reading it:
 *
 *   `stripped-by-build`  the runtime removed the element-to-component link.
 *                        Svelte production elements carry nothing at all; Vue
 *                        production drops `__vueParentComponent` and cannot be
 *                        talked into restoring it by installing the hook.
 *   `server-rendered`    the markup came from a component that never ran in the
 *                        browser. An RSC production server component leaves no
 *                        trace on the wire at any price.
 *   `not-hydrated`       server-rendered markup that a client runtime has not
 *                        attached to yet. Unlike the other two this one is
 *                        temporary, which is why it is told apart from them.
 *
 * Two more arrived from Wave 2, because building the adapters found cases the
 * three above could only answer by lying:
 *
 *   `not-rendered-here`  this framework did not render this element. In a
 *                        development build an element with no metadata is
 *                        simply not this framework's, and `null` says so. In
 *                        production that escape closes: a `<div>` no component
 *                        ever touched is byte-identical to one a component
 *                        rendered, and `stripped-by-build` would claim the
 *                        framework rendered it and lost the evidence.
 *   `search-exhausted`   the walk ran and hit its budget. Vue production has no
 *                        element-to-instance link and searches the vnode tree
 *                        for one; giving up after 20,000 nodes is a different
 *                        fact from there being nothing to find, and the fix is
 *                        a bigger budget rather than a different build.
 */
export type AbsentReason =
  | 'stripped-by-build'
  | 'server-rendered'
  | 'not-hydrated'
  | 'not-rendered-here'
  | 'search-exhausted';

/**
 * One component, as much as its runtime is willing to say about it.
 *
 * `declared` beats `searchable` when both are available: it is what the runtime
 * itself recorded, and it costs no bundle fetch, no map decode and no search.
 *
 * `moduleId` rides beside all three kinds rather than inside one of them, and
 * that is deliberate: it is not a *kind* of answer, it is a join key that an
 * answer of any kind may or may not have picked up. Only `core/rsc/` sets it —
 * see `ComponentSource.moduleId`, which is where it ends up.
 */
export type Resolution = ResolutionKind & {
  /**
   * A bundler module id the runtime published for this component, kept as a
   * string because the wire sends an integer and two distinct string ids can
   * parse to one number (`mcp-server/rsc.js`, `ENTRY`).
   */
  moduleId?: string;
};

type ResolutionKind =
  | {
      kind: 'declared';
      name: string;
      /** As the runtime recorded it — normalisation is the caller's job. */
      source: string;
      /**
       * Absent when the runtime recorded a file and no position, which is not
       * hypothetical: Vue attaches `__file` and nothing else — `__source` was
       * null on every component in every build measured, and `__hmrId` is an
       * opaque hash.
       *
       * This was required until Wave 2, and the cost of that was a component
       * resolving to line 1 — a number no runtime had said, indistinguishable
       * in the output from one it had. Optional is the honest shape: an editor
       * opens a file at the top when given no line, and now does so because the
       * line is missing rather than because it was invented.
       */
      line?: Pos1;
      column?: Pos1;
      /**
       * Whether `source` is where the component was *defined* or where it was
       * *used*. Only ever set when the runtime made the difference knowable.
       *
       * RSC forces this: `_debugInfo.stack[0]` is the call site, so a server
       * component's reachable frame names the parent's file and line, and the
       * declaration is only on a websocket `src/injected/` may not subscribe
       * to. Reporting a call site as a declaration would be wrong in exactly
       * the way `ComponentSource.via` exists to prevent, and the distinction is
       * one `core/react/attribution.ts` already carries as `stepOwner` against
       * `stepEnclosing`.
       */
      at?: 'declaration' | 'call-site';
    }
  | {
      kind: 'searchable';
      name: string;
      /**
       * `Function.prototype.toString()` of the component, which is what
       * `buildNeedle` takes. A string rather than the function, so that this
       * whole contract stays outside the DOM and outside any one runtime's
       * object graph.
       *
       * Which function this is, is a per-runtime decision with a measured
       * answer: on Vue it is `instance.render` and never `type.setup`, because
       * `setup`'s start resolved to the wrong file in 3 of 4 production cases.
       */
      fnSource: string;
    }
  | { kind: 'absent'; name?: string; reason: AbsentReason; detail: string };

/** A chain of components above one element, outermost first. */
export interface ResolvedChain {
  framework: Framework;
  chain: Resolution[];
  /** The walk hit its cap, so `chain[0]` is not the root. */
  truncated?: boolean;
  /**
   * What the walk learned about the build, when `detect()` could not know.
   *
   * Svelte is why this is here. `window.__svelte` is byte-identical in
   * development and production, there is no devtools hook, and the only real
   * signal — `__svelte_meta` — is per-element, which `detect()` is forbidden to
   * go looking for because it must stay cheap enough to run on every page. So
   * the build is a thing the first element walk discovers, not a property of
   * the page that can be read up front.
   */
  build?: 'development' | 'production' | 'unknown';
}

/** What a page said about the runtime when asked, before any element was picked. */
export interface FrameworkPresence {
  framework: Framework;
  detected: boolean;
  version?: string;
  build?: 'development' | 'production' | 'unknown';
}

/**
 * One runtime's reader.
 *
 * `fromElement` is permitted to be expensive and is permitted to fail with a
 * reason. Both are measured requirements rather than politeness: Vue production
 * has no element-to-instance link and needs an O(tree) walk down from
 * `__vue_app__` — which must follow `suspense.activeBranch` or it reaches
 * nothing on Nuxt — and a Nuxt island interior has no client vnode to find at
 * the end of it.
 */
export interface FrameworkAdapter {
  readonly framework: Framework;
  /** Cheap enough to call on every page. Never walks the tree. */
  detect(): FrameworkPresence;
  fromElement(el: Element): ResolvedChain | null;
}

/** `declared` beats `searchable`, and anything beats `absent`. */
export function preferResolution(a: Resolution, b: Resolution): Resolution {
  const rank = (r: Resolution): number =>
    r.kind === 'declared' ? 2 : r.kind === 'searchable' ? 1 : 0;
  return rank(b) > rank(a) ? b : a;
}
