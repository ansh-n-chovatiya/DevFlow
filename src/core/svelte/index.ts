/**
 * The Svelte adapter's judgement, with the DOM taken out of it.
 *
 * `src/injected/svelte.ts` reads the page and calls exactly these two functions.
 * The split exists so the decisions below can be tested against fixtures shaped
 * like real measured output instead of against a browser, and so `src/core/`
 * keeps the purity its bundling into `mcp-server/core.js` depends on.
 *
 * ## Why `detect()` almost never says which build this is
 *
 * The contract requires `detect()` to be "cheap enough to call on every page"
 * and to "never walk the tree", and Svelte gives it almost nothing to work with.
 * `window.__svelte` is the framework's only global — measured, the complete set
 * of `window.__*` registrations in the entire Svelte source tree is
 * `disclose-version.js`'s `((window.__svelte ??= {}).v ??= new Set()).add(…)`,
 * plus two internals — and it is `{ v: Set(["5"]) }` in **dev and prod alike**.
 * There is no devtools hook: `__SVELTE_DEVTOOLS_GLOBAL_HOOK__` and every other
 * candidate name were probed and are absent in all four measured targets.
 *
 * So `build` is `'unknown'` unless SvelteKit's own dev-only global says
 * otherwise. The tempting alternative — sample a few elements for
 * `__svelte_meta` — is a tree walk wearing a small number, and it would make the
 * one function the contract promised was cheap the one that is not. The build is
 * knowable per element, and `resolveSvelteElement` is where that is read.
 *
 * ## Why `null` is a real answer here
 *
 * `fromElement` returns `ResolvedChain | null`, and this adapter uses the null.
 * A development page proves its own dev-ness by carrying `__svelte_meta`
 * somewhere; an element on such a page with none of its own was not rendered by
 * a Svelte component, and saying `absent` about it would claim a Svelte
 * component exists and was hidden. `null` says the honest thing — this element
 * is not Svelte's — and `AbsentReason` has no fourth arm that means it.
 *
 * That escape closes in production, and the report for this unit says so
 * plainly: there, a `<div>` no Svelte component ever touched is byte-identical
 * to one a component rendered, so `stripped-by-build` is returned for both.
 *
 * Pure — no DOM, no Chrome, no clock, no `node:`.
 */

import type { FrameworkPresence, ResolvedChain } from '../locate/adapter.js';
import { classifyAbsence, type PageEvidence } from './absence.js';
import { chainFromMeta } from './chain.js';
import { readSvelteMeta } from './meta.js';

/** The O(1) globals `detect()` is allowed to look at, read by the injected half. */
export interface SvelteGlobals {
  /**
   * The contents of `window.__svelte.v`, a `Set` — measured as its only key.
   * `null` when the global is absent, which is not the same as an empty set:
   * empty means the runtime registered and disclosed nothing.
   */
  versions: string[] | null;
  /** SvelteKit's dev-only global. The single cheap tell that this is a dev build. */
  kitDev: boolean;
  /** A `data-sveltekit-*` attribute on `<body>` — server-emitted, so it precedes hydration. */
  kitMarkup: boolean;
}

/**
 * Whether this page is Svelte's, from globals alone.
 *
 * `kitMarkup` counts as detection on its own because of the case this whole
 * adapter has to keep straight: server-rendered SvelteKit markup is Svelte's
 * before `window.__svelte` exists, and an adapter that said "not detected" there
 * would report a SvelteKit page as having no framework for as long as hydration
 * took.
 */
export function detectSvelte(globals: SvelteGlobals): FrameworkPresence {
  const detected = globals.versions !== null || globals.kitMarkup;
  const version = globals.versions?.length ? globals.versions.join(', ') : undefined;

  return {
    framework: 'svelte',
    detected,
    ...(version === undefined ? {} : { version }),
    build: globals.kitDev ? 'development' : 'unknown',
  };
}

/** One element's worth of page reading, gathered by `src/injected/svelte.ts`. */
export interface SvelteElementReading {
  /** The raw value of `el.__svelte_meta`, unvalidated and possibly anything. */
  meta: unknown;
  page: PageEvidence;
}

export interface ResolveOptions {
  /** Chain cap, outward from the element. Defaults to `MAX_COMPONENT_CHAIN`. */
  chainLimit?: number;
  /** Parent-frame read cap. Defaults to `MAX_META_PARENT_WALK`. */
  frameLimit?: number;
}

/**
 * The whole adapter, as a function of what was read off the page.
 *
 * Returns `declared` resolutions and never `searchable`. That is a measured
 * refusal rather than an omission: the only element-to-function edge that
 * survives a production build yields the *event handler* for one of 23 delegated
 * events, its minified source measured at 9 characters against a
 * `MIN_NEEDLE_LEN` of 12, and even a hit would name the handler rather than the
 * component. `core/locate/` is not called at all — in dev there is nothing to
 * search for because the answer is already in hand, and in production there is
 * nothing to search *with*.
 */
export function resolveSvelteElement(
  reading: SvelteElementReading,
  options: ResolveOptions = {},
): ResolvedChain | null {
  const { page } = reading;

  // Nothing on this page says Svelte. Not an absence — not this adapter's page.
  if (!page.runtimeGlobal && !page.hydrationMarkers && !page.sveltekit) return null;

  const meta = readSvelteMeta(reading.meta, options.frameLimit);
  if (meta) {
    const { chain, truncated } = chainFromMeta(meta, options.chainLimit);
    /*
     * The build, reported from here because `detect()` cannot know it.
     *
     * `window.__svelte` is byte-identical in development and production, and
     * there is no devtools hook — so the only honest signal is this one:
     * `__svelte_meta` is emitted by the compiler in development and stripped in
     * production, so an element that has it *is* a development build. That is
     * the case `ResolvedChain.build` was added for, and it went unset until a
     * real run recorded `build: "unknown"` on a plain `vite dev` page where
     * every element carried meta.
     */
    return {
      framework: 'svelte',
      chain,
      build: 'development',
      ...(truncated ? { truncated } : {}),
    };
  }

  // A dev page proves itself by carrying meta somewhere. This element has none,
  // so no Svelte component rendered it — see the header.
  if (page.devMetaAnywhere) return null;

  const absence = classifyAbsence(page);
  /*
   * `not-hydrated` is the one absence that is not evidence about the build: the
   * markup is server-rendered and the client runtime may still be on its way,
   * so calling it production would be a guess that hardens into a stored fact.
   * Every other absence here means the compiler stripped the metadata, which
   * only a production build does.
   */
  return {
    framework: 'svelte',
    chain: [{ kind: 'absent', ...absence }],
    build: absence.reason === 'not-hydrated' ? 'unknown' : 'production',
  };
}

export { classifyAbsence, type Absence, type PageEvidence } from './absence.js';
export {
  chainFromMeta,
  componentNameFromFile,
  isUserComponentFrame,
  GENERATED_PATH_RE,
  SYNTHETIC_TAG_RE,
  type SvelteChain,
} from './chain.js';
export {
  readSvelteMeta,
  MAX_META_PARENT_WALK,
  type SvelteMetaFrame,
  type SvelteMetaLoc,
  type SvelteMetaRead,
} from './meta.js';
