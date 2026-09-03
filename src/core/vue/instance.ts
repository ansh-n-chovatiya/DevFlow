/**
 * What a Vue 3 component instance is willing to say about itself.
 *
 * The vocabulary half of the Vue adapter: the shapes that were measured on a
 * real instance, and the three decisions that turn one into a `Resolution`.
 * Every property name below was printed by the spike in `.ctx/spike-vue.md`
 * against Vue 3.5.42 and Nuxt 4.5.2, in development and in production, and none
 * of it was read off documentation.
 *
 * ## Why the searchable function is `instance.render`, and never `type.setup`
 *
 * `instance.type` is an **object**, not a function. That is the structural
 * difference from React, where `fiber.type` *is* the component, and it means the
 * thing that identifies a component and the thing whose `.toString()` can be
 * searched for are two different objects. There are two candidate functions on
 * that object and they are not interchangeable.
 *
 * `type.setup` is the tempting one: it exists in every build and in every
 * authoring style, and its source is found byte-for-byte in the served bundle.
 * It is still wrong. Fed through the production source map, the offset of the
 * *first character* of a minified `setup(` resolved to the wrong file in 3 of 4
 * cases — once to `runtime-dom.esm-bundler.js`, once to `src/main.js`, once to
 * a different component's `.vue` file. The cause was measured by stepping the
 * offset forward a character at a time: `setup(`'s first character sits inside
 * the trailing mapping segment of whatever the minifier emitted before it, and
 * the mapping only becomes correct about sixteen characters later. So the
 * failure is not "an approximate line" — it is a confident answer naming a file
 * the component was never written in, which is worse than no answer at all.
 *
 * `instance.render` resolved to the right file 4 of 4, because in the
 * inline-compiled output it begins at a token that carries its own segment. It
 * is also the one property that is present across all three authoring styles
 * and both builds: an Options-API component keeps `type.render` and
 * `instance.render` is the same function; a `<script setup>` SFC in development
 * has `type.render` (`_sfc_render`) and `instance.render` is again the same
 * function; the same SFC in production loses `type.render` entirely, because
 * `@vitejs/plugin-vue` switches to inline template compilation and the render
 * function becomes the arrow that `setup` returns — reachable only as
 * `instance.render`.
 *
 * One rule covers all six of those cells, so there is no fallback to `setup`
 * here. A component with no `instance.render` resolves to `absent` rather than
 * to a plausible wrong file.
 *
 * ## Why a bare-basename `__file` is refused
 *
 * `type.__file` is the runtime handing over the answer, which is what the
 * `declared` arm of the contract exists for. It comes in two forms and only one
 * of them is usable: `@vitejs/plugin-vue` writes an **absolute filesystem path**
 * in development, and a **bare basename** — `"DeepLeaf.vue"`, no directory — in
 * a build compiled with `__VUE_PROD_DEVTOOLS__`. A basename cannot be turned
 * into an editor URL and cannot be told apart from the same-named file in
 * another directory, so taking it would mean `declared` beating `searchable`
 * with something less useful than the search it suppressed. It is refused here
 * and the component falls through to its render function.
 *
 * Pure — no DOM, no Chrome, no network. A vnode's `el` is typed `unknown` and
 * is only ever compared by identity, which is what keeps the tree walk in
 * `tree.ts` inside `core/`.
 */

import type { Resolution } from '../locate/adapter.js';
import { ANONYMOUS_NAME } from '../locate/id.js';
import { pos1 } from '../locate/positions.js';

/**
 * The component definition — `instance.type`. An object in every build.
 *
 * Only the keys the adapter reads are named. The measured key set is larger and
 * differs per authoring style: `["__name","props","setup","__hmrId","render","__file"]`
 * for a development `<script setup>` SFC, `["__name","props","setup"]` for the
 * same component in production, `["name","data","methods","render"]` for an
 * Options-API component.
 */
export interface VueComponentType {
  /** Injected by `@vitejs/plugin-vue` from the filename. Survives minification. */
  __name?: string;
  /** An explicit `name:` option, on an Options-API or `defineComponent` component. */
  name?: string;
  /** Absolute path in dev, bare basename under `__VUE_PROD_DEVTOOLS__`, absent otherwise. */
  __file?: string;
  render?: unknown;
  setup?: unknown;
}

/** A Suspense boundary's two branches. Nuxt wraps the app root and every page in one. */
export interface VueSuspenseBoundary {
  activeBranch?: VueVNode | null;
  pendingBranch?: VueVNode | null;
}

/**
 * One vnode.
 *
 * `el` is the DOM node this vnode rendered, and is deliberately `unknown`: the
 * walk compares it by identity and never calls a method on it, which is the only
 * reason a tree walk over live DOM-bearing objects is allowed to live in
 * `core/`.
 */
export interface VueVNode {
  /** A tag name, a Symbol for text and fragments, or a `VueComponentType`. */
  type?: unknown;
  el?: unknown;
  /** Set when this vnode is a component; the instance it mounted. */
  component?: VueInstance | null;
  /** An array for an element vnode; a string for a text vnode. */
  children?: unknown;
  /** Set on a Suspense vnode. Its content is here, not in `children`. */
  suspense?: VueSuspenseBoundary | null;
  /** Suspense's default slot content, before a branch has been chosen. */
  ssContent?: VueVNode | null;
}

/**
 * One component instance.
 *
 * The measured instance has 61 keys; these are the six the adapter reads.
 * `parent` is the **render-tree** parent and not the lexical owner: a component
 * passed into a wrapper as slot content, authored in `App`, climbs
 * `DeepLeaf → MidLevel → App` rather than `DeepLeaf → App`. React's fiber
 * carries `_debugOwner` for the lexical answer; nothing equivalent was found on
 * a Vue instance in any build, so this adapter does not claim one.
 */
export interface VueInstance {
  uid?: number;
  type: VueComponentType;
  parent?: VueInstance | null;
  subTree?: VueVNode | null;
  vnode?: VueVNode | null;
  render?: unknown;
}

/** The app object on a mount container — `container.__vue_app__`. */
export interface VueApp {
  version?: string;
  /**
   * The root instance — **`null` in a default production build**, and populated
   * in development and under `__VUE_PROD_DEVTOOLS__`. The key is always present
   * in `Object.keys(app)`, so this needs a truthiness check and not `in`.
   */
  _instance?: VueInstance | null;
  _container?: unknown;
}

/** `type.__name ?? type.name`, which matched every component measured. */
export function displayNameOf(type: VueComponentType | null | undefined): string | null {
  if (!type) return null;
  return type.__name ?? type.name ?? null;
}

/**
 * The path the runtime recorded, or null.
 *
 * A path separator is the whole test, and it is the one that tells the two
 * measured forms apart — see the header on why the basename form is refused.
 */
export function declaredFileOf(type: VueComponentType | null | undefined): string | null {
  const file = type?.__file;
  if (typeof file !== 'string' || file.length === 0) return null;
  return file.includes('/') || file.includes('\\') ? file : null;
}

/**
 * The function whose source is searched for in the bundle.
 *
 * `instance.render` or nothing. `type.setup` is deliberately unreachable from
 * here; see the header.
 */
export function searchableSourceOf(instance: VueInstance | null | undefined): string | null {
  const render = instance?.render;
  if (typeof render !== 'function') return null;
  return Function.prototype.toString.call(render);
}

/**
 * One instance, as much as its build is willing to say.
 *
 * The source text is handed on unexamined. `buildNeedle` already refuses a
 * `[native code]` or too-short source and says which it was, and re-deciding
 * that here would mean a second rejection vocabulary answering the same
 * question — and there is no `AbsentReason` that means "the search would have
 * been pointless", so inventing one of those would be worse than passing the
 * string along to the module that owns the question.
 */
export function resolveInstance(instance: VueInstance): Resolution {
  const type: VueComponentType | null = instance.type ?? null;
  const name = displayNameOf(type);

  const file = declaredFileOf(type);
  if (file !== null) {
    return {
      kind: 'declared',
      name: name ?? ANONYMOUS_NAME,
      source: file,
      /*
       * Vue records a file and no line. There is nothing else on the instance
       * that carries one — `__hmrId` is an opaque hash and `__source` was null
       * on every component in every build measured.
       *
       * `pos1(1)` is the file's first line and stands for "this file, position
       * unrecorded", which is also where an editor opens a file given no line.
       * It is not a line read off the runtime, and the contract has no way to
       * say that: `Resolution.declared.line` is required. That is a defect in
       * the frozen contract rather than a fact about Vue, and it is written up
       * for the integrator.
       */
      line: pos1(1),
    };
  }

  const fnSource = searchableSourceOf(instance);
  if (fnSource !== null) {
    return { kind: 'searchable', name: name ?? ANONYMOUS_NAME, fnSource };
  }

  return {
    kind: 'absent',
    ...(name === null ? {} : { name }),
    reason: 'stripped-by-build',
    detail:
      'This build recorded no file on the component and left it no render function to search for. ' +
      'Vue drops __file from every component unless __VUE_PROD_DEVTOOLS__ was true when the bundle was built.',
  };
}
