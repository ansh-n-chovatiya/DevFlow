// @vitest-environment jsdom
/**
 * One id per component, and no id for a `<div>`.
 *
 * This is the bug that made the feature dangerous rather than merely
 * incomplete. `collectChain` emitted an entry for every *host* fiber between two
 * components — every `<div>`, `<span>` and `<button>` React rendered — and a
 * host fiber has no component function and no name, so `getDisplayName` called
 * them all `Anonymous` and `nameOnlyId` hashed them all to one id. One table row
 * then answered for all of them, minted from whichever host element was seen
 * first; on a development build that row carried a `_debugSource`, so it was
 * `status: 'resolved'`, so `pickOwner` handed it tier 1 outright and every step
 * of every flow was attributed to a `<div>` in whatever file happened to be
 * clicked in first.
 *
 * Three things had to be true for that, and each is nailed down here: host
 * fibers stay out of the chain, a fallback name never mints an id that can carry
 * a path, and an entry under such an id can never win owner selection.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { collectChain, type DebugSource, type Fiber } from '../src/core/react/fiber.js';
import { componentId, isNameOnly, isPlaceholderId, nameOnlyId } from '../src/core/react/id.js';
import { pickOwner } from '../src/core/react/owner.js';
import { mergeComponents } from '../src/core/react/table.js';
import { MAX_COMPONENT_CHAIN } from '../src/shared/constants.js';
import type { CapturedComponent } from '../src/shared/messages.js';
import type { ComponentNeedle, ComponentSource } from '../src/shared/types.js';

function fiber(type: unknown, parent: Fiber | null = null, debugSource?: DebugSource): Fiber {
  return {
    type,
    return: parent,
    child: null,
    sibling: null,
    stateNode: null,
    ...(debugSource ? { _debugSource: debugSource } : {}),
  };
}

function attach(el: Element, f: Fiber): void {
  (el as unknown as Record<string, Fiber>)['__reactFiber$k3n1p'] = f;
}

function host(): Element {
  document.body.innerHTML = '<div id="host"></div>';
  return document.getElementById('host')!;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('collectChain, over a tree with host elements in it', () => {
  it('keeps the components and drops the markup between them', () => {
    // `App → <div class="layout"> → CheckoutForm → <div> → ButtonBase`, which is
    // what any real tree looks like. The layout div carries the `_debugSource`
    // that used to be published as the location of every anonymous entry in the
    // flow.
    const el = host();
    const app = fiber(function App() {});
    const layout = fiber('div', app, { fileName: 'src/App.tsx', lineNumber: 11, columnNumber: 5 });
    const form = fiber(function CheckoutForm() {}, layout);
    const wrapper = fiber('div', form);
    const button = fiber(function ButtonBase() {}, wrapper);
    attach(el, fiber('button', button));

    const { entries } = collectChain(el);

    expect(entries.map((e) => e.name)).toEqual(['App', 'CheckoutForm', 'ButtonBase']);
    // Every entry is backed by a function, so every entry gets an id of its own.
    expect(entries.every((e) => e.fn !== null)).toBe(true);
    expect(entries.some((e) => e.debugSource?.fileName === 'src/App.tsx')).toBe(false);
  });

  it('spends the chain budget on components rather than on markup', () => {
    // Host fibers took a slot each, so a chain capped at twelve described six
    // components and truncated the rest — the outer half of the tree, which is
    // the half that names the feature the click was in.
    const el = host();
    let parent: Fiber | null = null;
    for (let i = 0; i < MAX_COMPONENT_CHAIN; i++) {
      parent = fiber({ [`C${i}`]: function () {} }[`C${i}`], parent);
      parent = fiber('div', parent);
    }
    attach(el, fiber('span', parent));

    const { entries, truncated } = collectChain(el);

    expect(entries).toHaveLength(MAX_COMPONENT_CHAIN);
    expect(entries[0].name).toBe('C0');
    expect(truncated).toBe(false);
  });

  it('still reports a fiber that has a name but no function', () => {
    // The rule is "describes nothing", not "has no function". An unsettled lazy
    // component and a raw context object both name something a reader can act
    // on, and neither has a function to build a needle from.
    const el = host();
    const app = fiber(function App() {});
    const provider = fiber({ displayName: 'CartContext.Provider' }, app);
    const lazy = fiber({ _payload: { _status: 0 } }, provider);
    const child = fiber(function Row() {}, lazy);
    attach(el, fiber('div', child));

    expect(collectChain(el).entries.map((e) => e.name)).toEqual([
      'App',
      'CartContext.Provider',
      'Lazy(loading…)',
      'Row',
    ]);
  });
});

describe('nameOnlyId', () => {
  it('marks the fallback names, which several components share', () => {
    expect(isPlaceholderId(nameOnlyId('Anonymous'))).toBe(true);
    expect(isPlaceholderId(nameOnlyId('Lazy(loading…)'))).toBe(true);

    // A real name is a real identity, and keeps an unmarked id.
    expect(isPlaceholderId(nameOnlyId('LazyCheckoutModal'))).toBe(false);
    expect(isNameOnly(nameOnlyId('Anonymous'))).toBe(true);
    expect(isPlaceholderId(componentId('Cart', 'function Cart(){return null}'))).toBe(false);
  });
});

describe('mergeComponents, given a placeholder id', () => {
  const table = (): {
    table: Record<string, ComponentSource>;
    needles: Record<string, ComponentNeedle>;
  } => ({ table: {}, needles: {} });

  it('refuses to record a JSX position under an id that is not one component', () => {
    // The first row wins — a later click never overwrites an answer — so a single
    // `_debugSource` under a shared id becomes the published location of every
    // unnamed component in the flow.
    const component: CapturedComponent = {
      id: nameOnlyId('Anonymous'),
      name: 'Anonymous',
      debugSource: { source: 'src/App.tsx', line: 11, column: 5 },
    };

    const { table: t, needles } = table();
    const { table: merged } = mergeComponents([component], 'https://shop.test', t, needles);

    expect(merged[component.id].status).not.toBe('resolved');
    expect(merged[component.id].source).toBeUndefined();
  });

  it('says what is actually true of a component React exposed no function for', () => {
    // Everything with no needle used to be explained as a lazy chunk that had
    // not arrived. For a `<div>` — or a context object — that is an invented
    // cause for a real gap, and it reads as fact.
    const { table: t, needles } = table();
    const provider: CapturedComponent = { id: 'ctx1', name: 'CartContext.Provider' };
    const lazy: CapturedComponent = { id: 'lz1', name: 'Lazy(loading…)' };

    const { table: merged } = mergeComponents([provider, lazy], 'https://shop.test', t, needles);

    expect(merged.ctx1.status).toBe('skipped');
    expect(merged.ctx1.detail).not.toMatch(/lazy/i);
    // The genuine case still reads the way it always did.
    expect(merged.lz1.status).toBe('not-found');
    expect(merged.lz1.detail).toMatch(/lazy/i);
  });
});

describe('pickOwner, with a placeholder in the chain', () => {
  it('attributes the step to the component, not to the shared row', () => {
    // The recorded case: step 1 clicked a layout div in `App.tsx`, which minted
    // the shared row; step 7 clicked a button inside `CheckoutForm`, whose chain
    // contains that same shared id. Tier 1 fired on it and the export printed
    // `⚛ Anonymous` and `| Anonymous | src/App.tsx:11 |` for a click that
    // happened in `src/CheckoutForm.tsx`.
    const anon = nameOnlyId('Anonymous');
    const chain = ['form', anon, 'mui'];
    const components: Record<string, ComponentSource> = {
      form: { name: 'CheckoutForm', status: 'pending' },
      [anon]: {
        name: 'Anonymous',
        status: 'resolved',
        via: 'debug-source',
        source: 'src/App.tsx',
        line: 11,
      },
      mui: {
        name: 'ButtonBase',
        status: 'resolved',
        via: 'bundle-search',
        source: 'node_modules/@mui/material/ButtonBase.js',
        dependency: true,
      },
    };

    expect(pickOwner(chain, components)).toBe('form');
  });

  it('leaves a placeholder the last tier, where only a name is being claimed', () => {
    const anon = nameOnlyId('Anonymous');
    const components: Record<string, ComponentSource> = {
      theme: { name: 'ThemeProvider', status: 'pending' },
      [anon]: { name: 'Anonymous', status: 'skipped', detail: 'no function' },
    };

    // Nothing here is the user's code. Naming something beats naming nothing,
    // and no path is being asserted either way.
    expect(pickOwner(['theme', anon], components)).toBe(anon);
  });
});
