// @vitest-environment jsdom

/**
 * What the Svelte adapter is allowed to touch on a page that is not Svelte's.
 *
 * `registry.ts::chainsFor` runs every adapter's `fromElement` on every recorded
 * interaction, and it does so from the capture-phase `click`/`input` listener —
 * synchronously, ahead of the page's own handlers. So the cost of this adapter
 * deciding "not my page" is paid on every keystroke by every user recording any
 * page in the world, and the overwhelming majority of those pages are not
 * Svelte. It used to be a `querySelectorAll('*')`, a `getOwnPropertySymbols` per
 * element up to `PAGE_SCAN_LIMIT`, and a whole-document comment walk — all of it
 * gathered eagerly and then discarded against three O(1) global reads.
 *
 * These assert the absence of work, which is a thing tests are usually bad at:
 * a fixture that merely returns the right answer passes just as well when the
 * document has been swept twice. So they count the document reads directly, by
 * spying on the two calls that do them. The behavioural cases either side keep
 * that honest — an assertion that nothing happened is worthless next to an
 * assertion that the right thing still does.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSvelteAdapter, readPageEvidence } from '../src/injected/svelte.js';

const win = window as unknown as Window;

/** `window.__svelte.v` — what the client runtime module writes when it evaluates. */
function discloseVersion(): void {
  (win as unknown as Record<string, unknown>).__svelte = { v: new Set(['5.57.0']) };
}

/** An element carrying its own compiler-emitted metadata, as a dev build emits. */
function elementWithMeta(id: string): Element {
  const el = document.createElement('div');
  el.id = id;
  (el as unknown as Record<string, unknown>).__svelte_meta = {
    parent: null,
    loc: { file: 'src/App.svelte', line: 10, column: 2 },
  };
  document.body.append(el);
  return el;
}

/**
 * Counts the two document reads that cost real time, without changing what they
 * answer — a stub returning nothing would make every behavioural assertion here
 * vacuous.
 */
function watchDocument() {
  const sweep = vi.spyOn(document, 'querySelectorAll');
  const walk = vi.spyOn(document, 'createTreeWalker');

  return {
    /** Sweeps of the whole document — the `'*'` selector specifically. */
    get sweeps() {
      return sweep.mock.calls.filter(([sel]) => sel === '*').length;
    },
    /*
     * Comment walks specifically. jsdom's own `querySelectorAll` builds a
     * `TreeWalker` internally, so counting every construction would charge the
     * element sweep for a walk it never asked for — and would have made the
     * memoisation assertion below read 2 for a reading taken exactly once.
     */
    get commentWalks() {
      return walk.mock.calls.filter(([, show]) => show === NodeFilter.SHOW_COMMENT).length;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  delete (win as unknown as Record<string, unknown>).__svelte;
  delete (win as unknown as Record<string, unknown>).__sveltekit_dev;
  for (const attr of [...document.body.attributes]) document.body.removeAttribute(attr.name);
});

describe('the Svelte adapter on a page that is not Svelte', () => {
  it('never sweeps the document to decide it is not its page', () => {
    const el = document.createElement('button');
    document.body.append(el);
    const seen = watchDocument();

    const resolved = createSvelteAdapter(win).fromElement(el);

    expect(resolved).toBeNull();
    expect(seen.sweeps).toBe(0);
  });

  it('still reads the hydration markers, which are the only other way in', () => {
    // Not an optimisation to be had: with no Svelte global, a server-rendered
    // page's comment markers are the one remaining signal, so this walk is the
    // irreducible cost of answering honestly rather than waste.
    const el = document.createElement('button');
    document.body.append(el);
    const seen = watchDocument();

    createSvelteAdapter(win).fromElement(el);

    expect(seen.commentWalks).toBe(1);
  });
});

describe('the Svelte adapter on a Svelte page', () => {
  it('answers from the element without sweeping, when the element carries meta', () => {
    // The common dev case, and the only build where the sweep could have said
    // anything at all: the element's own `__svelte_meta` settles it first.
    discloseVersion();
    const el = elementWithMeta('app-heading');
    const seen = watchDocument();

    const resolved = createSvelteAdapter(win).fromElement(el);

    expect(resolved?.framework).toBe('svelte');
    expect(resolved?.build).toBe('development');
    expect(seen.sweeps).toBe(0);
  });

  it('does not walk for hydration markers once a global has already said Svelte', () => {
    discloseVersion();
    const el = elementWithMeta('app-heading');
    const seen = watchDocument();

    createSvelteAdapter(win).fromElement(el);

    expect(seen.commentWalks).toBe(0);
  });

  it('still sweeps when the answer actually depends on it', () => {
    // A production page: the element has no meta, so `devMetaAnywhere` is what
    // separates "no Svelte component rendered this" from a stripped build.
    discloseVersion();
    const el = document.createElement('button');
    document.body.append(el);
    const seen = watchDocument();

    const resolved = createSvelteAdapter(win).fromElement(el);

    expect(resolved?.chain[0]?.kind).toBe('absent');
    expect(seen.sweeps).toBe(1);
  });
});

describe('the page evidence', () => {
  it('takes each reading once however often it is read', () => {
    const seen = watchDocument();
    const page = readPageEvidence(win, document);

    expect(page.devMetaAnywhere).toBe(page.devMetaAnywhere);
    expect(page.delegatedEventsAnywhere).toBe(page.delegatedEventsAnywhere);
    expect(page.hydrationMarkers).toBe(page.hydrationMarkers);

    // `devMetaAnywhere` and `delegatedEventsAnywhere` come from one sweep.
    expect(seen.sweeps).toBe(1);
    expect(seen.commentWalks).toBe(1);
  });

  it('reads nothing at all from a document nobody asks about', () => {
    const seen = watchDocument();
    readPageEvidence(win, document);

    expect(seen.sweeps).toBe(0);
    expect(seen.commentWalks).toBe(0);
  });

  it('reports the globals without touching the document', () => {
    discloseVersion();
    (win as unknown as Record<string, unknown>).__sveltekit_dev = {};
    const seen = watchDocument();

    const page = readPageEvidence(win, document);

    expect(page.runtimeGlobal).toBe(true);
    expect(page.sveltekit).toBe(true);
    expect(seen.sweeps).toBe(0);
    expect(seen.commentWalks).toBe(0);
  });
});
