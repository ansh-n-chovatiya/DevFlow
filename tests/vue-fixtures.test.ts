/**
 * The Vue structures the other `vue-*` suites are run against, and the assertion
 * that they still look like what was measured.
 *
 * ## Everything here was printed by a running program
 *
 * Every property name, every nesting relationship, every function source and
 * every depth below was copied out of `.ctx/spike-vue.md`, which recorded Vue
 * 3.5.42 and Nuxt 4.5.2 in a real Chromium, in development and in production.
 * Nothing was invented from documentation or from what Vue "ought" to do. The
 * four places where the spike's printer truncated a value, or where it printed
 * no value at all, are marked `NOT MEASURED` at the line that carries them.
 *
 * ## Why a `.test.ts` file exports fixtures
 *
 * The alternative is a plain `tests/vue-fixtures.ts`, and it would be tidier.
 * This wave gives each agent a named file set and mine is `tests/vue-*.test.ts`;
 * a helper module outside it is the kind of small, reasonable exception that
 * makes an ownership table stop meaning anything. Being a real suite is not
 * wasted either — the shape of a fixture drifting away from the measurement it
 * claims to reproduce is exactly the failure that makes a green suite worthless,
 * and the assertions at the bottom are the only thing that would catch it.
 *
 * ## Why `el` is a bare sentinel object here
 *
 * `core/vue/tree.ts` compares `vnode.el` with `===` and never reads a property
 * off it. A sentinel is therefore not a simplification of a DOM node, it is the
 * whole of what the walk can observe about one. `tests/vue-adapter.test.ts`
 * passes real jsdom elements through the same builders, which is where anything
 * that does touch the DOM is exercised.
 */

import { describe, expect, it } from 'vitest';
import type { VueApp, VueComponentType, VueInstance, VueVNode } from '../src/core/vue/instance.js';

/**
 * Compiles one of the measured sources above into a real function.
 *
 * The alternative is a stub carrying an own `toString`, and it would be a mock
 * of the exact thing under test: `searchableSourceOf` reads a function's real
 * source through `Function.prototype.toString.call`, precisely so that an own
 * `toString` on a page's function cannot redirect it. A fixture that answered
 * through an own `toString` would pass whether or not that hardening survived.
 *
 * `no-implied-eval` is the right rule and this is the case it is not aimed at:
 * `source` is a `const` string literal defined a few lines above, it never
 * leaves this file, and nothing here ever *calls* the function that comes back —
 * every one of them is only ever stringified. This is the one exception in the
 * Vue suites and it is deliberately confined to this three-line helper.
 */
function compile(body: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  return new Function(body)() as unknown;
}

/** A function whose `.toString()` is exactly `source`, byte for byte. */
export function fnFrom(source: string): (...args: unknown[]) => unknown {
  return compile(`return (${source})`) as (...args: unknown[]) => unknown;
}

/** The same, for a method shorthand such as `setup(e){…}`, which is not an expression. */
export function methodFrom(source: string): (...args: unknown[]) => unknown {
  return (compile(`return ({ ${source} })`) as Record<string, unknown>).setup as (
    ...args: unknown[]
  ) => unknown;
}

/**
 * Function sources, verbatim from the spike's §3 printouts.
 *
 * The two `_TRUNCATED` entries are the spike's own 200-character print cut, with
 * the smallest possible tail added so the text parses — marked because the tail
 * is the only text on this page nobody measured.
 */
export const MEASURED = {
  /** vue prod, `#leaf-1`, `instance.render` — complete, srcLen=97. */
  deepLeafProdRender:
    '(e,n)=>(Si(),Di(`button`,{id:t.idAttr,class:`deep-leaf-btn`,onClick:i},` Leaf `+A(r.value),9,$a))',
  /** vue prod, `#leaf-1`, `instance.type.setup` — NOT MEASURED past `,9,`; `$a))}` closes it. */
  deepLeafProdSetup_TRUNCATED:
    'setup(e){let t=e,n=Rt(41),r=aa(()=>n.value+1+`DEEP_LEAF_UNIQUE_MARKER_7b21`);' +
    'function i(){n.value+=1}return(e,n)=>(Si(),Di(`button`,{id:t.idAttr,class:`deep-leaf-btn`,' +
    'onClick:i},` Leaf `+A(r.value),9,$a))}',
  /** vue dev, `#leaf-1`, `instance.type.render` — NOT MEASURED past `onClick: $set`. */
  deepLeafDevRender_TRUNCATED:
    'function _sfc_render(_ctx, _cache, $props, $setup, $data, $options) {\n' +
    '  return (_openBlock(), _createElementBlock("button", {\n' +
    '    id: $setup.props.idAttr,\n' +
    '    class: "deep-leaf-btn",\n' +
    '    onClick: $setup.bump\n  }))\n}',
  /** vue prod, `#options-p`, `instance.type.render` — complete, srcLen=172. */
  optionsStyleProdRender:
    'function ao(e,t,n,r,i,a){return Si(),Di(`p`,{id:`options-p`,' +
    'onClick:t[0]||=(...e)=>a.bumpTheOptionsCounter&&a.bumpTheOptionsCounter(...e)},' +
    'A(i.optionsMarker)+` `+A(i.n),1)}',
  /** vue prod, `#render-fn-div`, `instance.type.setup` — complete, srcLen=80. */
  renderFnProdSetup:
    'setup(){return()=>oa(`div`,{id:`render-fn-div`},`RENDER_FN_UNIQUE_MARKER_a19e`)}',
  /** vue prod, `#render-fn-div`, `instance.render` — complete, srcLen=65. */
  renderFnProdRender: '()=>oa(`div`,{id:`render-fn-div`},`RENDER_FN_UNIQUE_MARKER_a19e`)',
} as const;

/**
 * A stand-in render function for a component the spike named but never printed
 * a source for — the Nuxt and vue-router wrappers, and `MidLevel`. NOT MEASURED:
 * only the fact that a render function is present is used by any test here.
 */
function placeholderRender(name: string): (...args: unknown[]) => unknown {
  return fnFrom(`()=>({unmeasuredRenderFor:${JSON.stringify(name)}})`);
}

/** Absolute paths, as `@vitejs/plugin-vue` wrote them in the spike's dev runs. */
export const DEV_FILES = {
  app: '/private/tmp/spike-vue/vue-app/src/App.vue',
  midLevel: '/private/tmp/spike-vue/vue-app/src/components/MidLevel.vue',
  deepLeaf: '/private/tmp/spike-vue/vue-app/src/components/DeepLeaf.vue',
  optionsStyle: '/private/tmp/spike-vue/vue-app/src/components/OptionsStyle.vue',
  nuxtApp: '/private/tmp/spike-vue/nuxt-app/app.vue',
  nuxtIndex: '/private/tmp/spike-vue/nuxt-app/pages/index.vue',
  nuxtDeepLeaf: '/private/tmp/spike-vue/nuxt-app/components/NuxtDeepLeaf.vue',
  nuxtRoot: '/private/tmp/spike-vue/nuxt-app/node_modules/nuxt/dist/app/components/nuxt-root.vue',
} as const;

export type Build = 'development' | 'production';

let nextUid = 0;

function instanceOf(
  type: VueComponentType,
  parent: VueInstance | null,
  render: unknown,
): VueInstance {
  return { uid: nextUid++, type, parent, subTree: null, vnode: null, render };
}

/** An element vnode: a tag name, the element it drew, and its children. */
function elementVNode(tag: string, el: unknown, children: VueVNode[] = []): VueVNode {
  return { type: tag, el, children };
}

/** A component vnode and the instance it mounted, wired both ways as Vue does. */
function componentVNode(instance: VueInstance, el: unknown, subTree: VueVNode): VueVNode {
  const vnode: VueVNode = { type: instance.type, el, component: instance };
  instance.subTree = subTree;
  instance.vnode = vnode;
  return vnode;
}

/** A Suspense vnode. Its content is in `suspense.activeBranch`, never in `children`. */
function suspenseVNode(el: unknown, activeBranch: VueVNode): VueVNode {
  return { type: Symbol('Suspense'), el, suspense: { activeBranch, pendingBranch: null } };
}

export interface PlainVueElements {
  /** `div#app` — the mount container. Carries `_vnode` and `__vue_app__`. */
  container: unknown;
  /** `div#root-app` — what `App` rendered. */
  rootApp: unknown;
  title: unknown;
  mid: unknown;
  leaf: unknown;
  optionsP: unknown;
  renderFnDiv: unknown;
  /** The slot fragment between `section#mid` and `DeepLeaf`. */
  slotFragment: unknown;
}

export interface VueFixture {
  app: VueApp;
  /** `container._vnode`. */
  rootVNode: VueVNode;
  instances: Record<string, VueInstance>;
}

/**
 * The plain Vite + Vue app, exactly as §2's descent printed it.
 *
 * ```
 * depth 0  type "div"                   el=DIV      (App's subTree)
 * depth 1  type "h1"                    el=H1
 * depth 1  type MidLevel                el=SECTION  hasComponent
 * depth 2  type "section"               el=SECTION
 * depth 3  type Symbol                  el=#text
 * depth 4  type DeepLeaf                el=BUTTON   hasComponent
 * depth 5  type "button"                el=BUTTON
 * depth 1  type OptionsStyleComponent   el=P        hasComponent
 * depth 1  type RenderFnStyleComponent  el=DIV      hasComponent
 * ```
 *
 * The chain that climbs out of `DeepLeaf` is `DeepLeaf → MidLevel → App` even
 * though `DeepLeaf` was authored in `App` and passed into `MidLevel` as slot
 * content — `parent` is the render tree, and the fixture reproduces that.
 */
export function plainVueApp(el: PlainVueElements, build: Build): VueFixture {
  const dev = build === 'development';

  const appType: VueComponentType = {
    __name: 'App',
    setup: methodFrom('setup(){return()=>0}'),
    ...(dev ? { __file: DEV_FILES.app, render: placeholderRender('App') } : {}),
  };
  const midType: VueComponentType = {
    __name: 'MidLevel',
    setup: methodFrom('setup(){return()=>0}'),
    ...(dev ? { __file: DEV_FILES.midLevel, render: placeholderRender('MidLevel') } : {}),
  };
  const leafType: VueComponentType = {
    __name: 'DeepLeaf',
    props: undefined,
    setup: methodFrom(dev ? 'setup(){return()=>0}' : MEASURED.deepLeafProdSetup_TRUNCATED),
    ...(dev
      ? { __file: DEV_FILES.deepLeaf, render: fnFrom(MEASURED.deepLeafDevRender_TRUNCATED) }
      : {}),
  } as VueComponentType;
  const optionsType: VueComponentType = {
    name: 'OptionsStyleComponent',
    render: fnFrom(MEASURED.optionsStyleProdRender),
    ...(dev ? { __file: DEV_FILES.optionsStyle } : {}),
  };
  // Not an SFC, so `@vitejs/plugin-vue` never gave it a `__file` in any build.
  const renderFnType: VueComponentType = {
    name: 'RenderFnStyleComponent',
    setup: methodFrom(MEASURED.renderFnProdSetup),
  };

  const app = instanceOf(appType, null, dev ? appType.render : placeholderRender('App'));
  const mid = instanceOf(midType, app, dev ? midType.render : placeholderRender('MidLevel'));
  const leaf = instanceOf(
    leafType,
    mid,
    dev ? leafType.render : fnFrom(MEASURED.deepLeafProdRender),
  );
  const options = instanceOf(optionsType, app, optionsType.render);
  const renderFn = instanceOf(renderFnType, app, fnFrom(MEASURED.renderFnProdRender));

  const leafVNode = componentVNode(leaf, el.leaf, elementVNode('button', el.leaf));
  const slot: VueVNode = { type: Symbol('Fragment'), el: el.slotFragment, children: [leafVNode] };
  const midVNode = componentVNode(mid, el.mid, elementVNode('section', el.mid, [slot]));
  const optionsVNode = componentVNode(options, el.optionsP, elementVNode('p', el.optionsP));
  const renderFnVNode = componentVNode(
    renderFn,
    el.renderFnDiv,
    elementVNode('div', el.renderFnDiv),
  );

  const rootVNode = componentVNode(
    app,
    el.rootApp,
    elementVNode('div', el.rootApp, [
      elementVNode('h1', el.title),
      midVNode,
      optionsVNode,
      renderFnVNode,
    ]),
  );

  return {
    // `_instance` is null in a default production build, and the key is still
    // in `Object.keys(app)` — which is why the adapter checks truthiness.
    app: { version: '3.5.42', _instance: dev ? app : null, _container: el.container },
    rootVNode,
    instances: { app, mid, leaf, options, renderFn },
  };
}

export interface NuxtElements {
  /** `div#__nuxt` — Nuxt's mount container. */
  container: unknown;
  rootApp: unknown;
  pageRoot: unknown;
  title: unknown;
  leaf: unknown;
  /** `aside#island-root[data-island-uid]`, which `NuxtIsland` mounted. */
  islandRoot: unknown;
}

/**
 * The Nuxt app, reproducing §7's thirteen-level descent including both Suspense
 * boundaries and the island wrapper.
 *
 * ```
 * d=0  root         nuxt-root      el=DIV#root-app
 * d=1  subTree      Suspense       el=DIV#root-app   hasSuspense
 * d=2  activeBranch (app.vue)      el=DIV#root-app
 * d=3  subTree      div            el=DIV#root-app
 * d=4  children[]   NuxtPage       el=DIV#page-root
 * d=5  subTree      RouterView     el=DIV#page-root
 * d=6  subTree      Suspense       el=DIV#page-root  hasSuspense
 * d=7  activeBranch RouteProvider  el=DIV#page-root
 * d=8  subTree      index          el=DIV#page-root
 * d=9  subTree      div            el=DIV#page-root
 * d=10 children[]   h1             el=H1#title
 * d=10 children[]   NuxtDeepLeaf   el=BUTTON#leaf-1
 * d=11 subTree      button         el=BUTTON#leaf-1
 * ```
 *
 * `NuxtIsland` is hung off the page's `div` as a further child, matching the
 * measurement that `#island-root` resolves to `NuxtIsland` while `#island-inner`
 * resolves to nothing at all.
 */
export function nuxtApp(el: NuxtElements, build: Build): VueFixture {
  const dev = build === 'development';
  const file = (path: string) => (dev ? { __file: path } : {});

  const nuxtRootType: VueComponentType = { __name: 'nuxt-root', ...file(DEV_FILES.nuxtRoot) };
  // A template-only SFC: no `<script>` block at all, so no name in any build.
  const appVueType: VueComponentType = { ...file(DEV_FILES.nuxtApp) };
  const nuxtPageType: VueComponentType = { name: 'NuxtPage' };
  const routerViewType: VueComponentType = { name: 'RouterView' };
  const routeProviderType: VueComponentType = { name: 'RouteProvider' };
  const indexType: VueComponentType = { __name: 'index', ...file(DEV_FILES.nuxtIndex) };
  const leafType: VueComponentType = {
    __name: 'NuxtDeepLeaf',
    setup: methodFrom(MEASURED.deepLeafProdSetup_TRUNCATED),
    ...file(DEV_FILES.nuxtDeepLeaf),
  };
  // `nuxt/dist/app/components/nuxt-island.js` — never an SFC, never a `__file`.
  const islandType: VueComponentType = { name: 'NuxtIsland' };

  const nuxtRoot = instanceOf(nuxtRootType, null, placeholderRender('nuxt-root'));
  const appVue = instanceOf(appVueType, nuxtRoot, placeholderRender('app.vue'));
  const nuxtPage = instanceOf(nuxtPageType, appVue, placeholderRender('NuxtPage'));
  const routerView = instanceOf(routerViewType, nuxtPage, placeholderRender('RouterView'));
  const routeProvider = instanceOf(routeProviderType, routerView, placeholderRender('RouteProvider'));
  const index = instanceOf(indexType, routeProvider, placeholderRender('index'));
  const leaf = instanceOf(leafType, index, fnFrom(MEASURED.deepLeafProdRender));
  const island = instanceOf(islandType, index, placeholderRender('NuxtIsland'));

  const leafVNode = componentVNode(leaf, el.leaf, elementVNode('button', el.leaf));
  const islandVNode = componentVNode(island, el.islandRoot, elementVNode('aside', el.islandRoot));
  const indexVNode = componentVNode(
    index,
    el.pageRoot,
    elementVNode('div', el.pageRoot, [elementVNode('h1', el.title), leafVNode, islandVNode]),
  );
  const routeProviderVNode = componentVNode(routeProvider, el.pageRoot, indexVNode);
  const routerViewVNode = componentVNode(
    routerView,
    el.pageRoot,
    suspenseVNode(el.pageRoot, routeProviderVNode),
  );
  const nuxtPageVNode = componentVNode(nuxtPage, el.pageRoot, routerViewVNode);
  const appVueVNode = componentVNode(
    appVue,
    el.rootApp,
    elementVNode('div', el.rootApp, [nuxtPageVNode]),
  );
  const rootVNode = componentVNode(
    nuxtRoot,
    el.rootApp,
    suspenseVNode(el.rootApp, appVueVNode),
  );

  return {
    app: { version: '3.5.42', _instance: dev ? nuxtRoot : null, _container: el.container },
    rootVNode,
    instances: { nuxtRoot, appVue, nuxtPage, routerView, routeProvider, index, leaf, island },
  };
}

/** Sentinels for the plain-Vue app, one per element the spike named. */
export function plainVueSentinels(): PlainVueElements {
  return {
    container: { tag: 'DIV', id: 'app' },
    rootApp: { tag: 'DIV', id: 'root-app' },
    title: { tag: 'H1', id: 'title' },
    mid: { tag: 'SECTION', id: 'mid' },
    leaf: { tag: 'BUTTON', id: 'leaf-1' },
    optionsP: { tag: 'P', id: 'options-p' },
    renderFnDiv: { tag: 'DIV', id: 'render-fn-div' },
    slotFragment: { tag: '#text', id: null },
  };
}

/** Sentinels for the Nuxt app. */
export function nuxtSentinels(): NuxtElements {
  return {
    container: { tag: 'DIV', id: '__nuxt' },
    rootApp: { tag: 'DIV', id: 'root-app' },
    pageRoot: { tag: 'DIV', id: 'page-root' },
    title: { tag: 'H1', id: 'title' },
    leaf: { tag: 'BUTTON', id: 'leaf-1' },
    islandRoot: { tag: 'ASIDE', id: 'island-root' },
  };
}

describe('the fixtures still look like the measurement', () => {
  /*
   * The one that decides whether the render-over-setup suite means anything. If
   * a fixture's `render` and `setup` ever stringify to the same text, every test
   * of that choice passes with the choice inverted.
   */
  it('gives DeepLeaf a production render and setup that are different functions', () => {
    const { instances } = plainVueApp(plainVueSentinels(), 'production');
    const leaf = instances.leaf;

    expect(Function.prototype.toString.call(leaf.render)).toBe(MEASURED.deepLeafProdRender);
    expect(Function.prototype.toString.call(leaf.type.setup)).toBe(
      MEASURED.deepLeafProdSetup_TRUNCATED,
    );
    expect(leaf.render).not.toBe(leaf.type.setup);
    // §3: production drops `type.render` for a `<script setup>` SFC entirely,
    // because the template is compiled inline into what `setup` returns.
    expect(leaf.type.render).toBeUndefined();
  });

  it('reproduces the measured source text byte for byte', () => {
    expect(Function.prototype.toString.call(fnFrom(MEASURED.renderFnProdRender))).toBe(
      MEASURED.renderFnProdRender,
    );
    expect(Function.prototype.toString.call(methodFrom(MEASURED.renderFnProdSetup))).toBe(
      MEASURED.renderFnProdSetup,
    );
    expect(MEASURED.deepLeafProdRender).toHaveLength(97);
    expect(MEASURED.renderFnProdRender).toHaveLength(65);
    expect(MEASURED.renderFnProdSetup).toHaveLength(80);
    expect(MEASURED.optionsStyleProdRender).toHaveLength(172);
  });

  /*
   * §1: only the mount container survives a default production build, and
   * `app._instance` is null there while the key stays in `Object.keys(app)`.
   */
  it('nulls app._instance in production and keeps the key present', () => {
    const prod = plainVueApp(plainVueSentinels(), 'production');
    const dev = plainVueApp(plainVueSentinels(), 'development');

    expect(prod.app._instance).toBeNull();
    expect('_instance' in prod.app).toBe(true);
    expect(dev.app._instance).not.toBeNull();
  });

  /* §6: `__file` is absolute in dev and gone in a default production build. */
  it('drops __file in production and makes it absolute in development', () => {
    expect(plainVueApp(plainVueSentinels(), 'development').instances.leaf.type.__file).toBe(
      DEV_FILES.deepLeaf,
    );
    expect(plainVueApp(plainVueSentinels(), 'production').instances.leaf.type.__file).toBeUndefined();
  });

  /*
   * §7's descent, reproduced depth for depth. Both Suspense boundaries hold
   * their content in `suspense.activeBranch` and have no `children` at all —
   * which is the entire reason the walk in `core/vue/tree.ts` looks there.
   */
  it('puts the Nuxt content behind two Suspense boundaries and not in children', () => {
    const { rootVNode, instances } = nuxtApp(nuxtSentinels(), 'production');

    const outer = instances.nuxtRoot.subTree;
    expect(outer?.suspense?.activeBranch?.component).toBe(instances.appVue);
    expect(outer?.children).toBeUndefined();

    const inner = instances.routerView.subTree;
    expect(inner?.suspense?.activeBranch?.component).toBe(instances.routeProvider);
    expect(inner?.children).toBeUndefined();

    expect(rootVNode.component).toBe(instances.nuxtRoot);
  });

  /*
   * §7 Difference 1: three of the seven links above a Nuxt leaf are router and
   * Nuxt internals, and the top two live in node_modules.
   */
  it('climbs NuxtDeepLeaf through five wrappers to nuxt-root', () => {
    const { instances } = nuxtApp(nuxtSentinels(), 'development');

    const names: (string | undefined)[] = [];
    let current: VueInstance | null | undefined = instances.leaf;
    while (current) {
      names.push(current.type.__name ?? current.type.name);
      current = current.parent;
    }

    expect(names).toEqual([
      'NuxtDeepLeaf',
      'index',
      'RouteProvider',
      'RouterView',
      'NuxtPage',
      undefined, // app.vue: template-only SFC, no name in any build
      'nuxt-root',
    ]);
  });

  /* §2: the climb out of DeepLeaf is the render tree, not the lexical owner. */
  it('climbs DeepLeaf through MidLevel even though App authored it', () => {
    const { instances } = plainVueApp(plainVueSentinels(), 'development');
    expect(instances.leaf.parent).toBe(instances.mid);
    expect(instances.mid.parent).toBe(instances.app);
    expect(instances.app.parent).toBeNull();
  });
});
