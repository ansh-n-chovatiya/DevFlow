// @vitest-environment jsdom
/**
 * The adapter as the page sees it: real elements, the real property names, and
 * the three paths in the order `src/injected/vue.ts` tries them.
 *
 * The DOM here is the markup the spike printed — `div#app` and `div#__nuxt` as
 * mount containers, `button#leaf-1` inside `section#mid`, and the island's
 * `aside#island-root[data-island-uid]` wrapping a `span#island-inner`. The
 * objects hung off those elements come from `vue-fixtures.test.ts`, which is
 * where the measurement they reproduce is written down.
 *
 * What this suite is for that the pure ones are not: the *order* of the three
 * paths. Each of them can produce an answer for an island interior and only one
 * of those answers is right, so trying them in the wrong order is a bug no
 * amount of testing the pieces would find.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { detectVue, vueAdapter, vueChainFromElement } from '../src/injected/vue.js';
import type { VueInstance } from '../src/core/vue/instance.js';
import {
  DEV_FILES,
  MEASURED,
  type Build,
  nuxtApp,
  plainVueApp,
} from './vue-fixtures.test.js';

function stamp(el: Element, key: string, value: unknown): void {
  (el as unknown as Record<string, unknown>)[key] = value;
}

function need(id: string): Element {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fixture is missing #${id}`);
  return el;
}

/** The plain Vite + Vue page, wired the way the build under test wires it. */
function mountPlainVue(build: Build): ReturnType<typeof plainVueApp> {
  document.body.innerHTML = `
    <div id="app">
      <div id="root-app">
        <h1 id="title">t</h1>
        <section id="mid"><button id="leaf-1">Leaf</button></section>
        <p id="options-p">p</p>
        <div id="render-fn-div">d</div>
        <span id="ssr-leftover">left over</span>
      </div>
    </div>`;

  const fixture = plainVueApp(
    {
      container: need('app'),
      rootApp: need('root-app'),
      title: need('title'),
      mid: need('mid'),
      leaf: need('leaf-1'),
      optionsP: need('options-p'),
      renderFnDiv: need('render-fn-div'),
      slotFragment: document.createTextNode(''),
    },
    build,
  );

  stamp(need('app'), '__vue_app__', fixture.app);
  stamp(need('app'), '_vnode', fixture.rootVNode);

  if (build === 'development') {
    // §1: in development every rendered element carries both keys. In a default
    // production build it carries neither, and installing the devtools hook at
    // runtime does not bring them back.
    stamp(need('root-app'), '__vueParentComponent', fixture.instances.app);
    stamp(need('title'), '__vueParentComponent', fixture.instances.app);
    stamp(need('mid'), '__vueParentComponent', fixture.instances.mid);
    stamp(need('leaf-1'), '__vueParentComponent', fixture.instances.leaf);
    stamp(need('options-p'), '__vueParentComponent', fixture.instances.options);
    stamp(need('render-fn-div'), '__vueParentComponent', fixture.instances.renderFn);
  }

  return fixture;
}

/** The Nuxt page, including the island's SSR markup. */
function mountNuxt(build: Build): ReturnType<typeof nuxtApp> {
  document.body.innerHTML = `
    <div id="__nuxt">
      <div id="root-app">
        <div id="page-root">
          <h1 id="title">t</h1>
          <button id="leaf-1">Leaf</button>
          <aside id="island-root" class="spike-island" data-island-uid="463aafe1-0000-4000-8000-000000000000">
            ISLAND_UNIQUE_MARKER_d51c<span id="island-inner">inner</span>
          </aside>
        </div>
      </div>
    </div>`;

  const fixture = nuxtApp(
    {
      container: need('__nuxt'),
      rootApp: need('root-app'),
      pageRoot: need('page-root'),
      title: need('title'),
      leaf: need('leaf-1'),
      islandRoot: need('island-root'),
    },
    build,
  );

  stamp(need('__nuxt'), '__vue_app__', fixture.app);
  stamp(need('__nuxt'), '_vnode', fixture.rootVNode);

  if (build === 'development') {
    stamp(need('leaf-1'), '__vueParentComponent', fixture.instances.leaf);
    stamp(need('island-root'), '__vueParentComponent', fixture.instances.island);
    stamp(need('page-root'), '__vueParentComponent', fixture.instances.index);
  }

  return fixture;
}

function kinds(chain: { kind: string }[]): string[] {
  return chain.map((entry) => entry.kind);
}

function names(chain: { name?: string }[]): (string | undefined)[] {
  return chain.map((entry) => entry.name);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('detect', () => {
  it('says no on a page with no Vue app', () => {
    document.body.innerHTML = '<div id="root"><p id="p">not vue</p></div>';
    expect(detectVue()).toEqual({ framework: 'vue', detected: false });
  });

  it('reads the version off the app object', () => {
    mountPlainVue('development');
    expect(detectVue().version).toBe('3.5.42');
  });

  /*
   * `app._instance` is the whole discriminator for a default production build:
   * measured `null` there, populated in development and under
   * `__VUE_PROD_DEVTOOLS__`. The key is in `Object.keys(app)` either way, so a
   * truthiness check is required and an `in` check would call every build
   * development.
   */
  it('calls a default production build production', () => {
    mountPlainVue('production');
    expect(detectVue()).toMatchObject({ detected: true, build: 'production' });
  });

  it('calls a build with an absolute __file on its root development', () => {
    mountPlainVue('development');
    expect(detectVue()).toMatchObject({ detected: true, build: 'development' });
  });

  /*
   * A `__VUE_PROD_DEVTOOLS__` build has a populated `_instance` like development
   * and a bare-basename `__file` unlike it. Nothing cheap tells those two apart,
   * so this says `unknown` instead of guessing — the honest answer, and the one
   * that stops a caller trusting `build` for something it cannot support.
   */
  it('says unknown when the root file is a bare basename', () => {
    const fixture = mountPlainVue('production');
    const root: VueInstance = {
      uid: 0,
      type: { __name: 'App', __file: 'App.vue' },
      parent: null,
    };
    fixture.app._instance = root;

    expect(detectVue()).toMatchObject({ detected: true, build: 'unknown' });
  });

  it('never walks the tree', () => {
    const fixture = mountPlainVue('production');
    // Nothing below the container can be reached without `_vnode`; detect still
    // answers, which is what "cheap enough to call on every page" means.
    stamp(need('app'), '_vnode', undefined);
    expect(detectVue()).toMatchObject({ detected: true });
    expect(fixture.rootVNode.component).toBeTruthy();
  });
});

describe('the development path', () => {
  it('reads __vueParentComponent off the element and stops', () => {
    const fixture = mountPlainVue('development');

    const resolved = vueChainFromElement(need('leaf-1'));

    expect(resolved?.framework).toBe('vue');
    expect(names(resolved!.chain)).toEqual(['App', 'MidLevel', 'DeepLeaf']);
    expect(kinds(resolved!.chain)).toEqual(['declared', 'declared', 'declared']);
    expect(resolved!.chain[2].kind === 'declared' && resolved!.chain[2].source).toBe(
      DEV_FILES.deepLeaf,
    );
    expect(fixture.instances.leaf.type.__file).toBe(DEV_FILES.deepLeaf);
  });

  it('climbs to the nearest ancestor that still carries one', () => {
    mountPlainVue('development');
    // A node the runtime never stamped — a text-only wrapper, or markup a
    // directive inserted. The nearest stamped ancestor is the right answer.
    const extra = document.createElement('em');
    need('leaf-1').appendChild(extra);

    expect(names(vueChainFromElement(extra)!.chain)).toEqual(['App', 'MidLevel', 'DeepLeaf']);
  });
});

describe('the production path', () => {
  it('walks the vnode tree when the element carries nothing', () => {
    mountPlainVue('production');
    expect(Object.keys(need('leaf-1'))).toEqual([]);

    const resolved = vueChainFromElement(need('leaf-1'));

    expect(names(resolved!.chain)).toEqual(['App', 'MidLevel', 'DeepLeaf']);
    expect(kinds(resolved!.chain)).toEqual(['searchable', 'searchable', 'searchable']);
    expect(resolved!.chain[2].kind === 'searchable' && resolved!.chain[2].fnSource).toBe(
      MEASURED.deepLeafProdRender,
    );
  });

  it('crosses both Suspense boundaries on a Nuxt page', () => {
    mountNuxt('production');

    const resolved = vueChainFromElement(need('leaf-1'));

    expect(names(resolved!.chain).at(-1)).toBe('NuxtDeepLeaf');
    expect(names(resolved!.chain)).toContain('RouterView');
  });

  /*
   * Markup inside the app container that no vnode owns. Server-rendered HTML
   * left outside the client tree reads exactly like this, and calling it
   * "stripped by the build" would send the reader after a build flag that would
   * not help.
   */
  it('reports server-rendered markup no client vnode owns', () => {
    mountPlainVue('production');

    const resolved = vueChainFromElement(need('ssr-leftover'));

    expect(kinds(resolved!.chain)).toEqual(['absent']);
    expect(resolved!.chain[0].kind === 'absent' && resolved!.chain[0].reason).toBe(
      'server-rendered',
    );
  });

  it('reports a container Vue has not rendered into yet as not hydrated', () => {
    const fixture = mountPlainVue('production');
    stamp(need('app'), '_vnode', undefined);
    fixture.app._instance = null;

    const resolved = vueChainFromElement(need('leaf-1'));

    expect(resolved!.chain[0].kind === 'absent' && resolved!.chain[0].reason).toBe('not-hydrated');
  });

  it('says how far it got when the walk runs out of budget', () => {
    mountPlainVue('production');

    const resolved = vueChainFromElement(need('leaf-1'), 2);
    const first = resolved!.chain[0];

    expect(first.kind).toBe('absent');
    expect(first.kind === 'absent' && first.reason).toBe('stripped-by-build');
    expect(first.kind === 'absent' && first.detail).toContain('2 vnodes');
  });
});

describe('a Nuxt island', () => {
  /*
   * The interior is checked before either of the other two paths, because both
   * of them find something for it and both are wrong. In development the
   * interior's nearest stamped ancestor is `NuxtIsland`; in production the walk
   * reaches the same wrapper. Its `setup` source *is* in the bundle, so the
   * resolver would go on to name `nuxt/dist/app/components/nuxt-island.js` with
   * full confidence — a wrong file, which is worse than no file.
   */
  it.each<Build>(['development', 'production'])(
    'reports the interior as server-rendered in %s',
    (build) => {
      mountNuxt(build);

      const resolved = vueChainFromElement(need('island-inner'));
      const innermost = resolved!.chain.at(-1)!;

      expect(innermost.kind).toBe('absent');
      expect(innermost.kind === 'absent' && innermost.reason).toBe('server-rendered');
      // The components genuinely above it are still reported, so the reader
      // learns which island it was as well as that it is one.
      expect(names(resolved!.chain)).toContain('NuxtIsland');
    },
  );

  /* The island's own root element is a real client component and resolves. */
  it.each<Build>(['development', 'production'])('resolves the island root in %s', (build) => {
    mountNuxt(build);

    const resolved = vueChainFromElement(need('island-root'));

    expect(names(resolved!.chain).at(-1)).toBe('NuxtIsland');
    expect(kinds(resolved!.chain).at(-1)).not.toBe('absent');
  });
});

describe('not a Vue page', () => {
  /*
   * Null and `absent` are different answers. Most of the web is not a Vue page
   * and this runs on all of it, so "not mine" has to be distinguishable from
   * "mine, and this build will not say".
   */
  it('returns null for an element in no Vue app', () => {
    mountPlainVue('production');
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    expect(vueChainFromElement(outside)).toBeNull();
  });
});

describe('the frozen interface', () => {
  it('is implemented, and reports the framework it is', () => {
    mountPlainVue('development');

    expect(vueAdapter.framework).toBe('vue');
    expect(vueAdapter.detect()).toMatchObject({ framework: 'vue', detected: true });
    expect(names(vueAdapter.fromElement(need('leaf-1'))!.chain).at(-1)).toBe('DeepLeaf');
  });
});
