// @vitest-environment jsdom

/**
 * The Svelte 5 / SvelteKit adapter, end to end.
 *
 * ## The fixtures are measured output, not mocks
 *
 * Every `__svelte_meta` object and the SSR body below are transcribed from
 * `.ctx/spike-svelte.md` — Finding 5 for the plain Vite + Svelte app, Finding 7a
 * and 7b for SvelteKit — with the exact property names, the exact nesting and
 * the exact numbers its probe scripts printed through `page.evaluate`. Svelte
 * 5.57.0, Vite 8.2.2, `@sveltejs/kit` 2.70.3.
 *
 * The distinction carries weight here. A mock of `__svelte_meta` would have been
 * invented by reading Svelte's source, and reading Svelte's source is how
 * somebody arrives at "the parent chain is a chain of components" — which is
 * false. Three of the five frames above a SvelteKit button are inside a
 * generated file, one is an `{#if}`, one is a `{#render}`, and two carry a
 * `componentTag` naming a component that exists in nobody's repository. Those
 * are the shapes the adapter has to survive, and only a measurement produces
 * them.
 *
 * ## Why one file
 *
 * The fixtures are shared by every suite here, and this unit owns only
 * `tests/svelte-*.test.ts` — so a plain `tests/svelte-fixtures.ts` module is not
 * its to create. Importing one `.test.ts` from another re-registers its suites
 * once per consumer, which inflates the count with copies rather than coverage.
 * One file with the fixtures at the top is the honest version of that. See the
 * integrator queue: a shared non-suite fixture module would let this split into
 * four focused files.
 *
 * jsdom throughout, because the two things most likely to be wrong are DOM
 * reads: whether an own property is found without walking a prototype chain, and
 * whether a comment-node walk finds the hydration markers.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MAX_COMPONENT_CHAIN } from '../src/shared/constants.js';
import { classifyAbsence, type PageEvidence } from '../src/core/svelte/absence.js';
import {
  chainFromMeta,
  componentNameFromFile,
  isUserComponentFrame,
} from '../src/core/svelte/chain.js';
import { MAX_META_PARENT_WALK, readSvelteMeta, type SvelteMetaRead } from '../src/core/svelte/meta.js';
import { createSvelteAdapter, readPageEvidence, readSvelteGlobals } from '../src/injected/svelte.js';

// ---------------------------------------------------------------------------
// Fixtures — measured output. See the header.
// ---------------------------------------------------------------------------

/** `#app-heading` in the plain dev app — a root component's own element. */
const PLAIN_DEV_APP_HEADING = {
  parent: null,
  loc: { file: 'src/App.svelte', line: 10, column: 2 },
};

/** `#counter-section`, one component deep. */
const PLAIN_DEV_COUNTER_SECTION = {
  parent: {
    type: 'component',
    file: 'src/App.svelte',
    line: 13,
    column: 2,
    parent: null,
    componentTag: 'Counter',
  },
  loc: { file: 'src/lib/Counter.svelte', line: 8, column: 0 },
};

/** `#grand-child-em`, two components deep — the deepest plain-app chain measured. */
const PLAIN_DEV_GRAND_CHILD_EM = {
  parent: {
    type: 'component',
    file: 'src/lib/DeepChild.svelte',
    line: 8,
    column: 2,
    parent: {
      type: 'component',
      file: 'src/App.svelte',
      line: 14,
      column: 2,
      parent: null,
      componentTag: 'DeepChild',
    },
    componentTag: 'GrandChild',
  },
  loc: { file: 'src/lib/GrandChild.svelte', line: 4, column: 0 },
};

/**
 * `#kit-counter-button` in the SvelteKit dev app.
 *
 * The five-frame chain, unedited. Frames 2, 4 and 5 are
 * `.svelte-kit/generated/root.svelte`; frames 2 and 4 carry `Pyramid_1` and
 * `Pyramid_0`; frame 3 is a `render` and frame 5 is an `if`.
 */
const KIT_DEV_COUNTER_BUTTON = {
  parent: {
    type: 'component',
    file: 'src/routes/+page.svelte',
    line: 9,
    column: 2,
    parent: {
      type: 'component',
      file: '.svelte-kit/generated/root.svelte',
      line: 52,
      column: 10,
      parent: {
        type: 'render',
        file: 'src/routes/+layout.svelte',
        line: 5,
        column: 69,
        parent: {
          type: 'component',
          file: '.svelte-kit/generated/root.svelte',
          line: 50,
          column: 7,
          parent: {
            type: 'if',
            file: '.svelte-kit/generated/root.svelte',
            line: 47,
            column: 0,
            parent: null,
          },
          componentTag: 'Pyramid_0',
        },
      },
      componentTag: 'Pyramid_1',
    },
    componentTag: 'KitCounter',
  },
  loc: { file: 'src/lib/KitCounter.svelte', line: 8, column: 2 },
};

/**
 * The SvelteKit production response body, verbatim from Finding 7a.
 *
 * Used to build a jsdom document that is *server markup before hydration* — the
 * state the `not-hydrated` reason exists for. Its comment nodes are the only
 * structural trace of component boundaries a production page has, and they are
 * unlabelled — `[`, `]`, `[0`, `[-1` delimit blocks, not named components.
 */
const KIT_PROD_SSR_BODY =
  '<div><!--[--><!--[0--><!--[--><div id="kit-layout">' +
  '<span id="kit-layout-span">kit-layout-unique-marker-5512</span><!--[--><main id="kit-main">' +
  '<h1 id="kit-heading">Kit Page Title</h1> <button id="kit-button">kit click 0</button>' +
  '<section id="kit-counter"><span id="kit-counter-value">3</span>' +
  '<button id="kit-counter-button">inc</button></section><!----></main><!--]--><!----></div>' +
  '<!--]--><!--]--> <!--[-1--><!--]--><!--]-->';

describe('the fixtures are the shapes that were measured', () => {
  it('keeps the SvelteKit chain at five frames, three of them generated', () => {
    const files: string[] = [];
    let frame: { file: string; parent?: unknown } | null = KIT_DEV_COUNTER_BUTTON.parent;

    while (frame) {
      files.push(frame.file);
      frame = (frame.parent ?? null) as { file: string; parent?: unknown } | null;
    }

    expect(files).toHaveLength(5);
    expect(files.filter((f) => f.includes('.svelte-kit/generated/'))).toHaveLength(3);
  });

  /*
   * The two facts that make the chain filter necessary rather than tidy. If a
   * future edit removes either, the filter's tests would still pass while
   * testing nothing.
   */
  it('keeps the synthetic tags and the non-component frame types', () => {
    const json = JSON.stringify(KIT_DEV_COUNTER_BUTTON);
    expect(json).toContain('"componentTag":"Pyramid_0"');
    expect(json).toContain('"componentTag":"Pyramid_1"');
    expect(json).toContain('"type":"render"');
    expect(json).toContain('"type":"if"');
  });

  /*
   * The base mismatch the adapter has to reconcile: `#counter-section` is the
   * first thing on line 8 of its file, and the compiler recorded `column: 0`.
   * A 1-based column would have been 1.
   */
  it('keeps 1-based lines beside 0-based columns', () => {
    expect(PLAIN_DEV_COUNTER_SECTION.loc).toEqual({
      file: 'src/lib/Counter.svelte',
      line: 8,
      column: 0,
    });
  });

  /*
   * Twelve, not the thirteen the spike's probe reported: the probe counted
   * comment *nodes* in the live document and this is the *response body* it
   * quoted, and the two differ by one empty comment the client inserts. The
   * fixture is the body verbatim; the number is what the body actually holds.
   */
  it('keeps the SSR comment markers of the response body', () => {
    const comments = KIT_PROD_SSR_BODY.match(/<!--.*?-->/g) ?? [];

    expect(comments).toHaveLength(12);
    expect(comments).toContain('<!--[0-->');
    expect(comments).toContain('<!--[-1-->');
  });
});

describe('readSvelteMeta', () => {
  it('reads a root component element, which has no parent chain at all', () => {
    const read = readSvelteMeta(PLAIN_DEV_APP_HEADING);

    expect(read).not.toBeNull();
    expect(read?.loc).toEqual({ file: 'src/App.svelte', line: 10, column: 2 });
    expect(read?.frames).toEqual([]);
    expect(read?.truncated).toBe(false);
  });

  it('flattens the parent linked list nearest-first', () => {
    const read = readSvelteMeta(PLAIN_DEV_GRAND_CHILD_EM);

    expect(read?.frames.map((f) => f.file)).toEqual([
      'src/lib/DeepChild.svelte',
      'src/App.svelte',
    ]);
    expect(read?.frames.map((f) => f.componentTag)).toEqual(['GrandChild', 'DeepChild']);
  });

  it('keeps every frame of the SvelteKit chain, including the ones it will not use', () => {
    const read = readSvelteMeta(KIT_DEV_COUNTER_BUTTON);

    expect(read?.frames.map((f) => f.type)).toEqual([
      'component',
      'component',
      'render',
      'component',
      'if',
    ]);
  });

  /*
   * Narrowing, not casting. Every one of these reached `pos1()` as `undefined`
   * in the version of this module that used a cast, came out as `1`, and sent a
   * reader to the first line of a file with no indication anything was wrong.
   */
  it.each([
    ['not an object', 1],
    ['null', null],
    ['no loc', { parent: null }],
    ['loc is not an object', { loc: 'src/App.svelte' }],
    ['no file', { loc: { line: 10, column: 2 } }],
    ['empty file', { loc: { file: '', line: 10, column: 2 } }],
    ['line is a string', { loc: { file: 'src/App.svelte', line: '10', column: 2 } }],
    ['line is NaN', { loc: { file: 'src/App.svelte', line: Number.NaN, column: 2 } }],
    ['line is zero, and lines are 1-based', { loc: { file: 'src/App.svelte', line: 0, column: 2 } }],
  ])('refuses a meta that %s', (_label, value) => {
    expect(readSvelteMeta(value)).toBeNull();
  });

  it('defaults a missing column to zero rather than dropping the element', () => {
    const read = readSvelteMeta({ loc: { file: 'src/App.svelte', line: 10 } });
    expect(read?.loc).toEqual({ file: 'src/App.svelte', line: 10, column: 0 });
  });

  /*
   * A gap in an ancestry is not closed silently: presenting a grandparent as a
   * parent is a wrong answer, where stopping short is an incomplete one.
   */
  it('stops the walk at the first unreadable frame instead of skipping it', () => {
    const read = readSvelteMeta({
      loc: { file: 'src/lib/Child.svelte', line: 3, column: 0 },
      parent: {
        type: 'component',
        file: 'src/App.svelte',
        line: 5,
        column: 2,
        componentTag: 'Child',
        parent: { type: 'component', file: 'src/Root.svelte', componentTag: 'App' },
      },
    });

    expect(read?.frames.map((f) => f.file)).toEqual(['src/App.svelte']);
  });

  /*
   * The chain is read out of page memory, so it has no guaranteed end. Without
   * the cap this hangs on the click path.
   */
  it('survives a cyclic parent chain', () => {
    const frame: Record<string, unknown> = {
      type: 'component',
      file: 'src/App.svelte',
      line: 5,
      column: 2,
      componentTag: 'Loop',
    };
    frame.parent = frame;

    const read = readSvelteMeta({ loc: { file: 'src/Loop.svelte', line: 1, column: 0 }, parent: frame });

    expect(read?.frames).toHaveLength(MAX_META_PARENT_WALK);
    expect(read?.truncated).toBe(true);
  });

  it('takes the frame cap as a parameter', () => {
    const read = readSvelteMeta(KIT_DEV_COUNTER_BUTTON, 2);

    expect(read?.frames).toHaveLength(2);
    expect(read?.truncated).toBe(true);
  });
});

function read(meta: unknown): SvelteMetaRead {
  const value = readSvelteMeta(meta);
  if (!value) throw new Error('fixture did not narrow');
  return value;
}

describe('chainFromMeta on a plain Svelte app', () => {
  it('names a root component from its own file when there is no parent frame', () => {
    expect(chainFromMeta(read(PLAIN_DEV_APP_HEADING)).chain).toEqual([
      { kind: 'declared', name: 'App', source: 'src/App.svelte', line: 10, column: 3 },
    ]);
  });

  /*
   * The innermost name comes from the nearest frame's `componentTag` — the frame
   * says "a Counter was instantiated at App.svelte:13", and the element's own
   * `loc` says where inside Counter it sits. Reading the frame's `file` as the
   * innermost component's file instead would name this element `App`.
   */
  it('names the innermost component from the nearest frame tag, not its file', () => {
    expect(chainFromMeta(read(PLAIN_DEV_COUNTER_SECTION)).chain).toEqual([
      { kind: 'declared', name: 'App', source: 'src/App.svelte', line: 13, column: 3 },
      { kind: 'declared', name: 'Counter', source: 'src/lib/Counter.svelte', line: 8, column: 1 },
    ]);
  });

  it('reads outermost first', () => {
    const { chain } = chainFromMeta(read(PLAIN_DEV_GRAND_CHILD_EM));

    expect(chain.map((r) => (r.kind === 'declared' ? r.name : r.kind))).toEqual([
      'App',
      'DeepChild',
      'GrandChild',
    ]);
    expect(chain.map((r) => (r.kind === 'declared' ? r.source : ''))).toEqual([
      'src/App.svelte',
      'src/lib/DeepChild.svelte',
      'src/lib/GrandChild.svelte',
    ]);
  });

  /*
   * `#counter-section` is the first character of line 8 and the compiler recorded
   * `column: 0`. A 1-based column reads as 1, so this asserting `1` is the only
   * thing standing between the adapter and every editor jump landing a character
   * early — a wrong number that looks entirely plausible.
   */
  it('carries the 0-based column across the one bridge and the 1-based line straight through', () => {
    const [entry] = chainFromMeta(read(PLAIN_DEV_APP_HEADING)).chain;

    expect(entry.kind === 'declared' && entry.line).toBe(10);
    expect(entry.kind === 'declared' && entry.column).toBe(3);
  });
});

describe('chainFromMeta on SvelteKit, where the filter earns its keep', () => {
  const { chain, truncated } = chainFromMeta(read(KIT_DEV_COUNTER_BUTTON));
  const sources = chain.map((r) => (r.kind === 'declared' ? r.source : ''));
  const names = chain.map((r) => (r.kind === 'declared' ? r.name : ''));

  it('keeps only the two components a person wrote, outermost first', () => {
    expect(names).toEqual(['+page', 'KitCounter']);
    expect(sources).toEqual(['src/routes/+page.svelte', 'src/lib/KitCounter.svelte']);
    expect(truncated).toBe(false);
  });

  /*
   * The failure this filter exists for. `.svelte-kit/generated/root.svelte` is
   * regenerated on every `vite dev`, so a chain entry pointing into it sends a
   * reader to a build artefact; `Pyramid_0` and `Pyramid_1` are names that exist
   * in no repository on earth and would sit in a flow beside real components.
   */
  it('drops every generated frame and every synthetic tag', () => {
    expect(sources.some((s) => s.includes('.svelte-kit/generated/'))).toBe(false);
    expect(names.some((n) => n.startsWith('Pyramid_'))).toBe(false);
  });

  it('drops the non-component frame types', () => {
    // The `render` frame's file is `src/routes/+layout.svelte` — a real file, and
    // still not a component instantiation. Losing a real ancestor is the priced
    // cost of never inventing one.
    expect(sources).not.toContain('src/routes/+layout.svelte');
  });
});

describe('isUserComponentFrame', () => {
  const base = { type: 'component', file: 'src/routes/+page.svelte', line: 9, column: 2 };

  it('keeps a component frame in a file somebody wrote', () => {
    expect(isUserComponentFrame({ ...base, componentTag: 'KitCounter' })).toBe(true);
  });

  it.each([
    ['a render frame', { ...base, type: 'render' }],
    ['an if frame', { ...base, type: 'if' }],
    ['a generated file', { ...base, file: '.svelte-kit/generated/root.svelte' }],
    ['a nested generated file', { ...base, file: 'apps/web/.svelte-kit/generated/root.svelte' }],
    ['a synthetic tag', { ...base, componentTag: 'Pyramid_12' }],
  ])('drops %s', (_label, frame) => {
    expect(isUserComponentFrame(frame)).toBe(false);
  });

  /*
   * The path pattern is anchored to a segment so a user's own directory that
   * merely starts with the same letters is not swallowed by the framework rule.
   */
  it('leaves a user file whose name only resembles the generated one', () => {
    expect(isUserComponentFrame({ ...base, file: 'src/lib/.svelte-kit-notes/root.svelte' })).toBe(true);
    expect(isUserComponentFrame({ ...base, file: 'src/lib/root.svelte' })).toBe(true);
  });

  it('leaves a component a person happened to call something pyramid-shaped', () => {
    expect(isUserComponentFrame({ ...base, componentTag: 'Pyramid' })).toBe(true);
    expect(isUserComponentFrame({ ...base, componentTag: 'PyramidChart' })).toBe(true);
  });
});

describe('componentNameFromFile', () => {
  it.each([
    ['src/lib/KitCounter.svelte', 'KitCounter'],
    ['src/App.svelte', 'App'],
    // SvelteKit route files keep their `+`: it is what they are called on disk.
    ['src/routes/+page.svelte', '+page'],
    ['src/routes/+layout.svelte', '+layout'],
    ['App.svelte', 'App'],
    ['src\\lib\\Counter.svelte', 'Counter'],
  ])('%s is %s', (file, name) => {
    expect(componentNameFromFile(file)).toBe(name);
  });

  it('falls back to a placeholder rather than an empty name', () => {
    expect(componentNameFromFile('src/lib/')).toBe('Anonymous');
  });
});

describe('the chain cap', () => {
  /** A chain deeper than any cap, built the shape the runtime builds them. */
  function deepMeta(depth: number): unknown {
    let parent: unknown = null;
    for (let i = depth; i > 0; i--) {
      parent = {
        type: 'component',
        file: `src/lib/C${i}.svelte`,
        line: i,
        column: 0,
        componentTag: `C${i + 1}`,
        parent,
      };
    }
    return { loc: { file: 'src/lib/Leaf.svelte', line: 1, column: 0 }, parent };
  }

  it('defaults to MAX_COMPONENT_CHAIN rather than a second Svelte-only budget', () => {
    const { chain, truncated } = chainFromMeta(read(deepMeta(40)));

    expect(chain).toHaveLength(MAX_COMPONENT_CHAIN);
    expect(truncated).toBe(true);
  });

  /*
   * Capped from the element outwards, so what survives is the near end. The far
   * end of a deep tree is a root wrapped in providers and identifies nothing.
   */
  it('keeps the nearest components and drops the outermost', () => {
    const { chain } = chainFromMeta(read(deepMeta(40)), 3);
    const names = chain.map((r) => (r.kind === 'declared' ? r.name : ''));

    expect(names[names.length - 1]).toBe('C2');
    expect(names).toHaveLength(3);
  });

  it('carries a truncation from the frame walk through to the chain', () => {
    const read2 = readSvelteMeta(deepMeta(40), 2);
    expect(read2 && chainFromMeta(read2).truncated).toBe(true);
  });
});

/** A hydrated production page: runtime present, no dev metadata anywhere. */
const PROD_HYDRATED: PageEvidence = {
  runtimeGlobal: true,
  devMetaAnywhere: false,
  delegatedEventsAnywhere: true,
  hydrationMarkers: true,
  sveltekit: true,
};

/**
 * Server markup that no client bundle has evaluated against yet.
 *
 * The measured difference from the state above, and the only one available from
 * the DOM: `window.__svelte` is registered by the client runtime's
 * `disclose-version` import, so its absence beside SSR markers is the evidence.
 */
const SSR_BEFORE_HYDRATION: PageEvidence = {
  runtimeGlobal: false,
  devMetaAnywhere: false,
  delegatedEventsAnywhere: false,
  hydrationMarkers: true,
  sveltekit: true,
};

describe('classifyAbsence', () => {
  it('calls server markup with no client runtime not-hydrated', () => {
    expect(classifyAbsence(SSR_BEFORE_HYDRATION).reason).toBe('not-hydrated');
  });

  it('calls a running production build stripped-by-build', () => {
    expect(classifyAbsence(PROD_HYDRATED).reason).toBe('stripped-by-build');
  });

  /*
   * The two states are one boolean apart, which is exactly why this is asserted
   * as a pair rather than as two independent facts.
   */
  it('turns on the client runtime alone', () => {
    expect(classifyAbsence({ ...SSR_BEFORE_HYDRATION, runtimeGlobal: true }).reason).toBe(
      'stripped-by-build',
    );
  });

  /*
   * `Symbol(events)` lands only on elements bound to one of Svelte's 23
   * delegated events, so its *absence* proves nothing — which is why it is a
   * veto and not a test. Its presence does prove the client ran.
   */
  it.each([
    ['dev metadata', 'devMetaAnywhere'],
    ['delegated events', 'delegatedEventsAnywhere'],
  ] as const)('lets %s veto not-hydrated even with the global missing', (_label, key) => {
    expect(classifyAbsence({ ...SSR_BEFORE_HYDRATION, [key]: true }).reason).toBe(
      'stripped-by-build',
    );
  });

  /*
   * Without markers there is no evidence the markup came from a server, so
   * "hydration has not run" is not a claim the page supports.
   */
  it('does not reach for not-hydrated on a page with no server markup', () => {
    expect(classifyAbsence({ ...SSR_BEFORE_HYDRATION, hydrationMarkers: false }).reason).toBe(
      'stripped-by-build',
    );
  });
});

describe('the sentence that comes with the reason', () => {
  /*
   * A default SvelteKit production build ships 0 `.map` files and no
   * `sourceMappingURL`, and 8 maps the moment `build.sourcemap: true` is set.
   * That is a one-line fix in the reader's own repository, so it is named.
   */
  it('names build.sourcemap on a SvelteKit page', () => {
    expect(classifyAbsence(PROD_HYDRATED).detail).toContain('build.sourcemap: true');
  });

  /*
   * And does not promise it will be enough. The element-to-component link is
   * stripped whether or not maps exist, so a sentence that stopped at the
   * source-map advice would send somebody to rebuild their app for nothing.
   */
  it('still says a development build is what restores the link', () => {
    expect(classifyAbsence(PROD_HYDRATED).detail).toContain('dev server');
    expect(classifyAbsence({ ...PROD_HYDRATED, sveltekit: false }).detail).toContain(
      'development build',
    );
  });

  it('tells the temporary case that it is temporary', () => {
    const detail = classifyAbsence(SSR_BEFORE_HYDRATION).detail;

    expect(detail).toContain('hydration');
    expect(detail).not.toContain('build.sourcemap');
  });

  it('always carries a sentence, whatever the evidence', () => {
    for (const runtimeGlobal of [true, false]) {
      for (const hydrationMarkers of [true, false]) {
        for (const sveltekit of [true, false]) {
          const absence = classifyAbsence({
            ...SSR_BEFORE_HYDRATION,
            runtimeGlobal,
            hydrationMarkers,
            sveltekit,
          });
          expect(absence.detail.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

type Win = Window & Record<string, unknown>;

const win = window as unknown as Win;

afterEach(() => {
  delete win.__svelte;
  delete win.__sveltekit_dev;
  document.body.innerHTML = '';
  for (const attr of [...document.body.attributes]) document.body.removeAttribute(attr.name);
});

/** `window.__svelte = { v: Set(["5"]) }` — Svelte's only global, dev and prod alike. */
function discloseVersion(version = '5'): void {
  win.__svelte = { v: new Set([version]) };
}

function element(id: string, meta?: unknown): Element {
  const el = document.createElement('div');
  el.id = id;
  if (meta !== undefined) Object.assign(el, { __svelte_meta: meta });
  document.body.append(el);
  return el;
}

/** An element bound to a delegated event, as Svelte leaves it in production. */
function delegated(id: string): Element {
  const el = document.createElement('button');
  el.id = id;
  (el as unknown as Record<symbol, unknown>)[Symbol('events')] = { click: () => undefined };
  document.body.append(el);
  return el;
}

describe('detect', () => {
  it('finds Svelte from its one global, and reports the version out of the Set', () => {
    discloseVersion();
    expect(createSvelteAdapter(win).detect()).toEqual({
      framework: 'svelte',
      detected: true,
      version: '5',
      build: 'unknown',
    });
  });

  /*
   * `window.__svelte` is present in dev *and* prod — measured in all four
   * targets — so it cannot tell the builds apart. SvelteKit's own dev global is
   * the only O(1) tell, and `detect()` may not walk the tree to do better.
   */
  it('says development only when SvelteKit says so, and unknown otherwise', () => {
    discloseVersion();
    win.__sveltekit_dev = { base: '', env: {} };
    expect(createSvelteAdapter(win).detect().build).toBe('development');
  });

  it('finds SvelteKit from server markup before the client runtime exists', () => {
    document.body.setAttribute('data-sveltekit-preload-data', 'hover');
    const presence = createSvelteAdapter(win).detect();

    expect(presence.detected).toBe(true);
    expect(presence.version).toBeUndefined();
  });

  it('says no on a page that is not Svelte', () => {
    expect(createSvelteAdapter(win).detect().detected).toBe(false);
  });
});

describe('fromElement in development', () => {
  it('resolves an element to a declared chain with no bundle search at all', () => {
    discloseVersion();
    const el = element('grand-child-em', PLAIN_DEV_GRAND_CHILD_EM);

    const resolved = createSvelteAdapter(win).fromElement(el);

    expect(resolved?.framework).toBe('svelte');
    expect(resolved?.chain.map((r) => r.kind)).toEqual(['declared', 'declared', 'declared']);
    expect(resolved?.chain.map((r) => (r.kind === 'declared' ? r.name : ''))).toEqual([
      'App',
      'DeepChild',
      'GrandChild',
    ]);
  });

  it('reads the metadata as an own property, not through the prototype chain', () => {
    discloseVersion();
    // A page that put `__svelte_meta` on Element.prototype would otherwise make
    // every element in the document look like a Svelte component.
    Object.defineProperty(Element.prototype, '__svelte_meta', {
      value: PLAIN_DEV_APP_HEADING,
      configurable: true,
    });

    try {
      const el = element('plain-div');
      const resolved = createSvelteAdapter(win).fromElement(el);

      // Not `declared`: the prototype's metadata was never read, so this page
      // still looks like a production build rather than like a dev one where
      // every element in the document was rendered by `App`.
      expect(resolved?.chain.map((r) => r.kind)).toEqual(['absent']);
    } finally {
      delete (Element.prototype as unknown as Record<string, unknown>).__svelte_meta;
    }
  });

  /*
   * The case `AbsentReason` has no word for, and the reason this adapter uses
   * the contract's `null`. A dev page proves its own dev-ness by carrying
   * metadata somewhere; an element with none of its own was not rendered by a
   * Svelte component, and calling that `stripped-by-build` would claim a
   * component exists and was hidden.
   */
  it('returns null for an element no Svelte component rendered', () => {
    discloseVersion();
    element('svelte-one', PLAIN_DEV_APP_HEADING);
    const foreign = element('not-svelte');

    expect(createSvelteAdapter(win).fromElement(foreign)).toBeNull();
  });

  it('resolves SvelteKit dev without the generated frames', () => {
    discloseVersion();
    win.__sveltekit_dev = { base: '', env: {} };
    document.body.setAttribute('data-sveltekit-preload-data', 'hover');
    const el = element('kit-counter-button', KIT_DEV_COUNTER_BUTTON);

    const resolved = createSvelteAdapter(win).fromElement(el);

    expect(resolved?.chain.map((r) => (r.kind === 'declared' ? r.source : ''))).toEqual([
      'src/routes/+page.svelte',
      'src/lib/KitCounter.svelte',
    ]);
  });
});

describe('fromElement in production, which is where this adapter does almost nothing', () => {
  /*
   * The measured production page: every element has zero own properties, and the
   * only ones carrying anything at all carry `Symbol(events)`.
   */
  it('says stripped-by-build, with a reason and a sentence', () => {
    discloseVersion();
    document.body.setAttribute('data-sveltekit-preload-data', 'hover');
    document.body.insertAdjacentHTML('beforeend', KIT_PROD_SSR_BODY);
    delegated('kit-counter-button');
    const el = document.querySelector('#kit-heading');

    const resolved = createSvelteAdapter(win).fromElement(el!);
    const [entry] = resolved!.chain;

    expect(entry.kind).toBe('absent');
    expect(entry.kind === 'absent' && entry.reason).toBe('stripped-by-build');
    expect(entry.kind === 'absent' && entry.detail).toContain('build.sourcemap: true');
  });

  /*
   * Same markup, same elements, one difference: the client bundle has not
   * evaluated, so `window.__svelte` is not there. This is the distinction the
   * spike singled out as one an adapter must be able to make.
   */
  it('says not-hydrated for the identical markup before the client runtime loads', () => {
    document.body.setAttribute('data-sveltekit-preload-data', 'hover');
    document.body.insertAdjacentHTML('beforeend', KIT_PROD_SSR_BODY);
    const el = document.querySelector('#kit-heading');

    const resolved = createSvelteAdapter(win).fromElement(el!);
    const [entry] = resolved!.chain;

    expect(entry.kind === 'absent' && entry.reason).toBe('not-hydrated');
  });

  it('returns null on a page with no Svelte on it at all', () => {
    const el = element('ordinary');
    expect(createSvelteAdapter(win).fromElement(el)).toBeNull();
  });

  /*
   * Never `searchable`. The one production element-to-function edge yields the
   * *event handler* for one of 23 delegated events; its minified source measured
   * 9 characters against a MIN_NEEDLE_LEN of 12, and a hit would name the
   * handler rather than the component.
   */
  it('never offers a function to search for', () => {
    discloseVersion();
    const el = delegated('counter-button');

    const resolved = createSvelteAdapter(win).fromElement(el);

    expect(resolved?.chain.every((r) => r.kind !== 'searchable')).toBe(true);
  });
});

describe('the page evidence', () => {
  it('finds the SSR hydration markers among the comment nodes', () => {
    document.body.insertAdjacentHTML('beforeend', KIT_PROD_SSR_BODY);
    expect(readPageEvidence(win, document).hydrationMarkers).toBe(true);
  });

  it('does not mistake an ordinary comment for a marker', () => {
    document.body.insertAdjacentHTML('beforeend', '<div><!-- a note --><!--build:123--></div>');
    expect(readPageEvidence(win, document).hydrationMarkers).toBe(false);
  });

  it('sees the delegated-event symbol by its description', () => {
    delegated('counter-button');
    expect(readPageEvidence(win, document).delegatedEventsAnywhere).toBe(true);
  });

  it('caps the element sweep', () => {
    for (let i = 0; i < 50; i++) element(`filler-${i}`);
    element('has-meta', PLAIN_DEV_APP_HEADING);

    expect(readPageEvidence(win, document, { pageScanLimit: 10 }).devMetaAnywhere).toBe(false);
    expect(readPageEvidence(win, document).devMetaAnywhere).toBe(true);
  });

  it('distinguishes an absent global from an empty version set', () => {
    expect(readSvelteGlobals(win, document).versions).toBeNull();
    win.__svelte = { v: new Set() };
    expect(readSvelteGlobals(win, document).versions).toEqual([]);
  });
});
