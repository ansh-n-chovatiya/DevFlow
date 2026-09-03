/**
 * The three decisions in `core/vue/instance.ts`, and the measurements that
 * settled each one.
 *
 * The first of them is the one worth guarding hardest. `type.setup` and
 * `instance.render` are both real functions, both present in production, and
 * both found byte-for-byte in the served bundle — so nothing goes red if the
 * wrong one is chosen. What goes wrong instead is downstream and silent: fed
 * through the production source map, `setup`'s start offset named the wrong
 * *file* in 3 of 4 cases. A test that only asserted "a source was returned"
 * would pass with the choice inverted, so the ones below assert which source,
 * and assert that `setup` is not reachable as a fallback at all.
 */

import { describe, expect, it } from 'vitest';
import {
  declaredFileOf,
  displayNameOf,
  resolveInstance,
  searchableSourceOf,
  type VueComponentType,
  type VueInstance,
} from '../src/core/vue/instance.js';
import { ANONYMOUS_NAME } from '../src/core/locate/id.js';
import {
  DEV_FILES,
  MEASURED,
  fnFrom,
  methodFrom,
  plainVueApp,
  plainVueSentinels,
} from './vue-fixtures.test.js';

describe('the searchable function is instance.render', () => {
  it('takes the render function and not setup, on a production SFC', () => {
    const { instances } = plainVueApp(plainVueSentinels(), 'production');

    const source = searchableSourceOf(instances.leaf);

    expect(source).toBe(MEASURED.deepLeafProdRender);
    expect(source).not.toBe(MEASURED.deepLeafProdSetup_TRUNCATED);
    expect(source?.startsWith('setup(')).toBe(false);
  });

  /*
   * The measured production shape for a `<script setup>` SFC: `type.render` is
   * gone, the template was compiled inline, and the only route to the render
   * function is through the instance. A reader who reached for `type.render`
   * and fell back to `type.setup` would get the wrong file here, not nothing.
   */
  it('finds it even though the production SFC has no type.render', () => {
    const { instances } = plainVueApp(plainVueSentinels(), 'production');

    expect(instances.leaf.type.render).toBeUndefined();
    expect(instances.leaf.type.setup).toBeTypeOf('function');
    expect(searchableSourceOf(instances.leaf)).toBe(MEASURED.deepLeafProdRender);
  });

  /*
   * The strongest form of the same rule. A component that carries `setup` and
   * nothing else has no searchable function, and saying so is the correct
   * answer — a resolution built from `setup` would name a file the component
   * was never written in and would look exactly as confident as a right one.
   */
  it('refuses to fall back to setup when there is no render at all', () => {
    const setupOnly: VueInstance = {
      uid: 9,
      type: { __name: 'SetupOnly', setup: methodFrom(MEASURED.renderFnProdSetup) },
      parent: null,
      render: undefined,
    };

    expect(searchableSourceOf(setupOnly)).toBeNull();

    const resolution = resolveInstance(setupOnly);
    expect(resolution.kind).toBe('absent');
    expect(JSON.stringify(resolution)).not.toContain('setup(');
  });

  it('keeps the Options-API render, which the instance and the type share', () => {
    const { instances } = plainVueApp(plainVueSentinels(), 'production');
    expect(searchableSourceOf(instances.options)).toBe(MEASURED.optionsStyleProdRender);
  });

  /*
   * §3 names two traps by measurement: `instance.update` is `bound run`, whose
   * source is `[native code]`, and `instance.effect.fn` is Vue's shared
   * `componentUpdateFn` — the same function for every component on the page,
   * which hits the runtime chunk and never the component. Neither is reachable
   * from here, because only `render` is read.
   */
  it('reads nothing but render off the instance', () => {
    const trap = {
      uid: 3,
      type: { __name: 'Trapped' },
      parent: null,
      update: (function bound() { /* stands in for `bound run` */ }),
      effect: { fn: function componentUpdateFn() { /* Vue's, not the component's */ } },
    } as unknown as VueInstance;

    expect(searchableSourceOf(trap)).toBeNull();
  });
});

describe('a declared file', () => {
  it('beats searching when the runtime wrote an absolute path', () => {
    const { instances } = plainVueApp(plainVueSentinels(), 'development');

    const resolution = resolveInstance(instances.leaf);

    expect(resolution.kind).toBe('declared');
    expect(resolution.kind === 'declared' && resolution.source).toBe(DEV_FILES.deepLeaf);
    expect(resolution.kind === 'declared' && resolution.name).toBe('DeepLeaf');
  });

  /*
   * A `__VUE_PROD_DEVTOOLS__` build puts `__file` back as a bare basename —
   * `"DeepLeaf.vue"`, no directory. Taking it would mean `declared` beating
   * `searchable` with a string no editor URL can be built from and that cannot
   * be told apart from the same-named file in another folder.
   */
  it('refuses a bare basename and falls through to the render function', () => {
    const type: VueComponentType = { __name: 'DeepLeaf', __file: 'DeepLeaf.vue' };
    const instance: VueInstance = {
      uid: 1,
      type,
      parent: null,
      render: fnFrom(MEASURED.deepLeafProdRender),
    };

    expect(declaredFileOf(type)).toBeNull();
    const resolution = resolveInstance(instance);
    expect(resolution.kind).toBe('searchable');
    expect(resolution.kind === 'searchable' && resolution.fnSource).toBe(
      MEASURED.deepLeafProdRender,
    );
  });

  it('accepts a Windows path, which has the other separator', () => {
    expect(declaredFileOf({ __file: 'C:\\src\\components\\DeepLeaf.vue' })).toBe(
      'C:\\src\\components\\DeepLeaf.vue',
    );
  });

  /*
   * Vue records a file and never a line. `line` is required by the frozen
   * contract, so it is the file's first line — where an editor opens a file it
   * was given no position for — and it is not a number read off the runtime.
   * Asserted so that the day the contract makes `line` optional, this is the
   * test that says what to change.
   */
  it('reports the first line, because Vue records no line anywhere', () => {
    const { instances } = plainVueApp(plainVueSentinels(), 'development');
    const resolution = resolveInstance(instances.leaf);

    expect(resolution.kind === 'declared' && resolution.line).toBe(1);
    expect(resolution.kind === 'declared' && resolution.column).toBeUndefined();
  });
});

describe('the display name', () => {
  it('is __name, then name, then nothing', () => {
    expect(displayNameOf({ __name: 'DeepLeaf', name: 'Other' })).toBe('DeepLeaf');
    expect(displayNameOf({ name: 'OptionsStyleComponent' })).toBe('OptionsStyleComponent');
    expect(displayNameOf({})).toBeNull();
    expect(displayNameOf(null)).toBeNull();
  });

  /*
   * A template-only SFC — no `<script>` block at all — gets no name in any
   * build. It still has a file, so it is still fully identified; the shared
   * placeholder from `core/locate/id.ts` is what fills the contract's required
   * `name`, and `isPlaceholderName` is already how the rest of the tree knows
   * that string identifies nothing.
   */
  it('falls back to the shared placeholder for a template-only SFC', () => {
    const instance: VueInstance = {
      uid: 2,
      type: { __file: DEV_FILES.nuxtApp },
      parent: null,
    };

    const resolution = resolveInstance(instance);
    expect(resolution.kind === 'declared' && resolution.name).toBe(ANONYMOUS_NAME);
  });

  /* An absence with no name at all omits the key rather than inventing one. */
  it('omits the name on an absence that has none', () => {
    const resolution = resolveInstance({ uid: 4, type: {}, parent: null });

    expect(resolution.kind).toBe('absent');
    expect(resolution.kind === 'absent' && 'name' in resolution).toBe(false);
    expect(resolution.kind === 'absent' && resolution.reason).toBe('stripped-by-build');
    expect(resolution.kind === 'absent' && resolution.detail.length).toBeGreaterThan(0);
  });
});
