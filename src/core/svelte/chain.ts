/**
 * Turning `__svelte_meta` into a chain of components a person actually wrote.
 *
 * ## Why a filter is not optional here
 *
 * `fiber.ts` has one rule of this kind — *host fibers are never chain entries* —
 * and its header calls the bug it exists for the worst this feature has had: a
 * `<div>` and a `<span>` both resolve to the name `Anonymous`, hash to one id,
 * and one row minted from whichever was seen first then answers for clicks it
 * never went near.
 *
 * Svelte's version of that bug is worse, because the frames are not anonymous —
 * they are *confidently named after files the user has never opened*. Measured
 * on SvelteKit dev (`.ctx/spike-svelte.md`, Finding 7b), the chain above a
 * button in `src/lib/KitCounter.svelte` runs:
 *
 * ```
 * component  src/routes/+page.svelte              componentTag: KitCounter
 * component  .svelte-kit/generated/root.svelte    componentTag: Pyramid_1
 * render     src/routes/+layout.svelte
 * component  .svelte-kit/generated/root.svelte    componentTag: Pyramid_0
 * if         .svelte-kit/generated/root.svelte
 * ```
 *
 * Three of those five frames are inside a file SvelteKit generated, and two of
 * them carry a component tag — `Pyramid_0`, `Pyramid_1` — that exists nowhere in
 * anyone's source. Passing them through would put `Pyramid_0` in a flow beside
 * `Checkout`, and send a reader to a build artefact that is regenerated on every
 * `vite dev`. So two rules:
 *
 *   1. **Only `type === 'component'` frames are entries.** `'if'` and `'render'`
 *      are block constructs, not components. The alternative — keeping them
 *      because their `file` is often a real one — names a `{#if}` as though a
 *      person had written a component called `+layout`.
 *   2. **Generated files and synthetic tags are never entries.** Matched on the
 *      path `.svelte-kit/generated/`, which is SvelteKit's own output directory,
 *      and on the `Pyramid_N` tag shape.
 *
 * **What rule 1 costs, stated rather than buried.** The `render` frame above is
 * `src/routes/+layout.svelte`, a file the user did write, and dropping it means
 * the layout does not appear in the chain. That is the honest trade: a `render`
 * frame is a snippet render site, so treating it as a component instantiation
 * would report a component boundary where the compiler recorded none. The chain
 * loses a real ancestor rather than gaining a fictional one, which is the
 * direction this repository has already chosen once in `collectChain`.
 *
 * ## What a `declared` entry's position means
 *
 * For the innermost entry it is where the **element** is written; for every
 * entry above it, where the **child component is instantiated**. Both are inside
 * the file the entry is named after, and both are what a person wants to open —
 * but they are not the component's declaration line, and nothing here pretends
 * otherwise. React's `_debugSource` has exactly the same property.
 *
 * Pure — no DOM, no Chrome. Imports `core/locate/` freely and `core/react/`
 * never; `scripts/check-locate.mjs` guards the neutrality that makes that
 * possible.
 */

import { MAX_COMPONENT_CHAIN } from '../../shared/constants.js';
import type { Resolution } from '../locate/adapter.js';
import { ANONYMOUS_NAME } from '../locate/id.js';
import { pos0, pos1, toOneBased } from '../locate/positions.js';
import type { SvelteMetaFrame, SvelteMetaRead } from './meta.js';

/**
 * SvelteKit's own output directory.
 *
 * Anchored to a path segment so a user's `src/lib/.svelte-kit-notes/` cannot
 * match, and a bare `root.svelte` in someone's own tree is left alone — the
 * generated file is only ever reached through this directory.
 */
export const GENERATED_PATH_RE = /(^|\/)\.svelte-kit\/generated\//;

/**
 * The synthetic component tags SvelteKit's generated root uses for its layout
 * nesting. Measured as `Pyramid_0` and `Pyramid_1`; the index is unbounded
 * because the depth is the number of nested layouts.
 */
export const SYNTHETIC_TAG_RE = /^Pyramid_\d+$/;

/** True for a frame that names a component in a file somebody wrote. */
export function isUserComponentFrame(frame: SvelteMetaFrame): boolean {
  if (frame.type !== 'component') return false;
  if (GENERATED_PATH_RE.test(frame.file)) return false;
  if (frame.componentTag !== undefined && SYNTHETIC_TAG_RE.test(frame.componentTag)) return false;
  return true;
}

/**
 * The component name a `.svelte` path implies.
 *
 * SvelteKit's route files keep their `+` — `+page`, `+layout` — because that is
 * what they are called on disk and in every SvelteKit document. Renaming them to
 * something prettier would mean a name the reader cannot grep for.
 */
export function componentNameFromFile(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? '';
  const name = base.endsWith('.svelte') ? base.slice(0, -'.svelte'.length) : base;
  return name === '' ? ANONYMOUS_NAME : name;
}

/**
 * The name of the component the element itself sits in.
 *
 * Taken from the nearest frame's `componentTag`, and **only** the nearest: the
 * tag on a frame names the component instantiated at that call site, so
 * `frames[0]` is the one whose tag describes `loc.file` and every frame above it
 * describes something else. Falling back to the filename covers the two measured
 * cases where there is no usable tag — a root component with no parent at all,
 * and a nearest frame that is a block rather than a component.
 */
function innermostName(read: SvelteMetaRead): string {
  const nearest = read.frames[0];
  if (
    nearest?.type === 'component' &&
    nearest.componentTag !== undefined &&
    !SYNTHETIC_TAG_RE.test(nearest.componentTag)
  ) {
    return nearest.componentTag;
  }
  return componentNameFromFile(read.loc.file);
}

export interface SvelteChain {
  /** Outermost first, as `ResolvedChain.chain` is read. */
  chain: Resolution[];
  truncated: boolean;
}

/**
 * The component chain above one element, **outermost first**.
 *
 * Built nearest-first and reversed, and capped from the element outwards for the
 * reason `collectChain` gives: the far end of a deep tree is `App` wrapped in
 * providers, and the near end is where the click landed.
 *
 * `limit` defaults to `MAX_COMPONENT_CHAIN` rather than to a second Svelte-only
 * budget — a chain that truncates at 12 in React and at some other number in
 * Svelte is one product behaving as two.
 */
export function chainFromMeta(read: SvelteMetaRead, limit = MAX_COMPONENT_CHAIN): SvelteChain {
  const chain: Resolution[] = [];
  let truncated = read.truncated;

  /*
   * The one place the two bases of `__svelte_meta` are reconciled, and the
   * reason `SvelteMetaLoc` keeps them as plain numbers until here.
   *
   * `line` is already 1-based, so `pos1` is an assertion — rule 4 of
   * `positions.ts`, "a number a runtime recorded". `column` is 0-based, so it
   * needs the bridge, and `pos0` + `toOneBased` is the only way across. The
   * failure of the obvious `pos1(column)` is silent: every column one short,
   * every editor jump landing a character early, and no test that does not
   * check the number itself going red.
   */
  const push = (name: string, source: string, line: number, column: number): boolean => {
    if (chain.length >= limit) {
      truncated = true;
      return false;
    }
    chain.push({
      kind: 'declared',
      name,
      source,
      line: pos1(line),
      column: toOneBased(pos0(column)),
    });
    return true;
  };

  if (push(innermostName(read), read.loc.file, read.loc.line, read.loc.column)) {
    for (const frame of read.frames) {
      if (!isUserComponentFrame(frame)) continue;
      if (!push(componentNameFromFile(frame.file), frame.file, frame.line, frame.column)) break;
    }
  }

  chain.reverse();
  return { chain, truncated };
}
