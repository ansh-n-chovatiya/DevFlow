// @vitest-environment jsdom

/**
 * The card that three surfaces render.
 *
 * G, H and K all import `resultCard`, so a regression here is a regression in
 * the DevTools panel, the popup and the flow review at once. What these tests
 * pin is the behaviour the merge plan named rather than the markup:
 *
 *   - **All nine statuses render.** Eight of them are not `resolved`, and the
 *     failure this guards against is a card that quietly shows a name and
 *     nothing else — which reads as "this component has no source" when the
 *     truth is "it is in a chunk that was never loaded".
 *   - **The detail sentence is always there when the status is not `resolved`,**
 *     including for a record that arrived without one.
 *   - **A null editor link is not a failure.** It is the common case, and the
 *     path must still be shown.
 *   - **`matchCount > 1` warns.**
 *
 * Positions are exercised on both sides of the `Pos0`/`Pos1` bridge: an original
 * source is stored 1-based and displayed as stored, a compiled position is
 * stored 0-based and must be displayed one higher. A card that showed the raw
 * `compiled.line` would look entirely plausible and be off by one forever, which
 * is the exact failure CONTRACTS §1 exists to prevent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pos0, pos1 } from '../src/core/locate/positions.js';
import type { ComponentSource, ComponentStatus } from '../src/shared/types.js';
import {
  actionFor,
  ambiguityText,
  detailText,
  pathText,
  resultCard,
  STATUS_ACTION,
  STATUS_DETAIL,
  viaLabel,
} from '../src/ui/components/result-card.js';

/** Every value of `ComponentStatus`, listed so the tests fail when one is added. */
const ALL_STATUSES: ComponentStatus[] = [
  'resolved',
  'compiled-only',
  'ambiguous',
  'not-found',
  'no-map',
  'map-error',
  'unfetchable',
  'skipped',
  'pending',
];

function component(over: Partial<ComponentSource> = {}): ComponentSource {
  return { name: 'CartSummary', status: 'resolved', ...over };
}

/** A fully resolved component: an original file, a 1-based position, a bundle. */
function resolved(over: Partial<ComponentSource> = {}): ComponentSource {
  return component({
    status: 'resolved',
    via: 'bundle-search',
    source: 'src/checkout/CartSummary.tsx',
    line: pos1(42),
    column: pos1(7),
    compiled: {
      url: 'https://shop.example/assets/main.a1b2c3.js',
      line: pos0(0),
      column: pos0(9184),
    },
    ...over,
  });
}

const LINK = { projectRoot: '/Users/dev/shop', template: 'vscode://file/{path}:{line1}:{col1}' };

function text(card: HTMLElement, selector: string): string {
  return card.querySelector(selector)?.textContent ?? '';
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('viaLabel', () => {
  /*
   * §1.1 rule 3: every attribution says which path answered it, so no recording
   * can depend on `@devflow/compiler-plugin` without a reader being able to
   * tell. A stamped answer that read as `dev build` would be exactly that
   * silent dependency.
   */
  it('names the build stamp as its own path, not as a development build', () => {
    expect(viaLabel(component({ via: 'plugin', source: 'src/Cart.tsx' }))).toBe('build stamp');
  });

  it('reads a development build off the fiber', () => {
    expect(viaLabel(component({ via: 'debug-source', source: 'src/App.tsx' }))).toBe('dev build');
  });

  it('says "source map" only when the search reached an original file', () => {
    expect(viaLabel(resolved())).toBe('source map');
  });

  /*
   * `VIA_TITLE` is keyed by the label rather than by `via`, and the lookup falls
   * back to an empty string — so a fourth label with no sentence behind it fails
   * nothing and simply renders a mark nobody can hover to understand. Every
   * label this function can return is checked, from the function itself.
   */
  it('has a sentence behind every label it can produce', () => {
    const sources: ComponentSource[] = [
      component({ via: 'plugin', source: 'src/Cart.tsx', line: pos1(12) }),
      component({ via: 'debug-source', source: 'src/App.tsx', line: pos1(40) }),
      resolved(),
      component({
        status: 'compiled-only',
        via: 'bundle-search',
        compiled: { url: 'https://x.test/a.js', line: pos0(3), column: pos0(1) },
      }),
    ];

    for (const source of sources) {
      const via = resultCard({ source }).querySelector('.result-card__via');
      expect(via?.textContent, JSON.stringify(source.via)).toBe(viaLabel(source));
      expect(via?.getAttribute('title'), JSON.stringify(source.via)).not.toBe('');
    }
  });

  /*
   * The tooltips obey the glossary, which is the half that drifted.
   *
   * `docs/CONTRACTS.md` §4.1 defines **source** as the file and line a
   * component was written in and puts *location*, *origin* and *definition* in
   * the Not column. Both of the first two sentences said “location” — the
   * `dev build` one from the beginning, and `build stamp` only because it was
   * written to match its neighbour. A word checked nowhere is a word that
   * spreads to the next string that needs one, so it is checked here, over
   * every label `viaLabel` can produce rather than over the one that was wrong.
   */
  it('spells the frozen noun in every tooltip behind a label', () => {
    const sources: ComponentSource[] = [
      component({ via: 'plugin', source: 'src/Cart.tsx', line: pos1(12) }),
      component({ via: 'debug-source', source: 'src/App.tsx', line: pos1(40) }),
      resolved(),
      component({
        status: 'compiled-only',
        via: 'bundle-search',
        compiled: { url: 'https://x.test/a.js', line: pos0(3), column: pos0(1) },
      }),
    ];

    for (const source of sources) {
      const title = resultCard({ source })
        .querySelector('.result-card__via')
        ?.getAttribute('title');

      // Whole words. “original source” is the resolver's own vocabulary and is
      // not the noun §4.1 is refusing; a substring match calls it one.
      expect(title, `${viaLabel(source)}: ${title}`).not.toMatch(
        /\b(locations?|origins?|definitions?)\b/i,
      );
    }
  });

  it('says "compiled" when the search stopped at the bundle', () => {
    const compiledOnly = component({
      status: 'compiled-only',
      via: 'bundle-search',
      compiled: { url: 'https://x.test/a.js', line: pos0(3), column: pos0(1) },
    });
    expect(viaLabel(compiledOnly)).toBe('compiled');
  });

  it('claims no provenance when nothing was found', () => {
    expect(viaLabel(component({ status: 'not-found' }))).toBeNull();
    expect(viaLabel(component({ status: 'pending' }))).toBeNull();
  });
});

describe('pathText', () => {
  it('shows a stored 1-based position exactly as stored', () => {
    expect(pathText(resolved())).toBe('src/checkout/CartSummary.tsx:42:7');
  });

  it('crosses the Pos0 bridge for a compiled position, and crosses it once', () => {
    const compiledOnly = component({
      status: 'compiled-only',
      via: 'bundle-search',
      compiled: {
        url: 'https://shop.example/assets/main.a1b2c3.js',
        line: pos0(0),
        column: pos0(9184),
      },
    });
    // 0-based line 0, column 9184 is line 1, column 9185 to a person.
    expect(pathText(compiledOnly)).toBe('main.a1b2c3.js:1:9185');
  });

  it('falls back to the whole string when the bundle URL does not parse', () => {
    const unparseable = component({
      status: 'compiled-only',
      compiled: { url: '<anonymous>', line: pos0(0), column: pos0(0) },
    });
    expect(pathText(unparseable)).toBe('<anonymous>:1:1');
  });

  it('is null when there is no position at all', () => {
    expect(pathText(component({ status: 'not-found' }))).toBeNull();
  });
});

describe('detailText', () => {
  it('is silent only for a resolved component', () => {
    expect(detailText(resolved())).toBeNull();
  });

  it('prefers the sentence the resolver wrote', () => {
    const source = component({ status: 'not-found', detail: 'Only two chunks had loaded.' });
    expect(detailText(source)).toBe('Only two chunks had loaded.');
  });

  it('falls back to a sentence for every non-resolved status', () => {
    for (const status of ALL_STATUSES) {
      if (status === 'resolved') continue;
      expect(detailText(component({ status })), status).toBe(STATUS_DETAIL[status]);
    }
  });
});

describe('resultCard', () => {
  it('renders every status, and every one of them says something', () => {
    for (const status of ALL_STATUSES) {
      const card = resultCard({ source: component({ status }) });

      expect(card.dataset.status, status).toBe(status);
      expect(text(card, '.result-card__name'), status).toBe('CartSummary');

      if (status === 'resolved') {
        expect(card.querySelector('.result-card__detail'), status).toBeNull();
      } else {
        // The whole point: an unresolved component explains itself.
        expect(text(card, '.result-card__detail'), status).toBe(STATUS_DETAIL[status]);
      }
    }
  });

  it('renders the resolver’s own detail sentence when there is one', () => {
    const card = resultCard({
      source: component({
        status: 'unfetchable',
        detail: 'Every bundle was cross-origin with no CORS headers.',
      }),
    });
    expect(text(card, '.result-card__detail')).toBe(
      'Every bundle was cross-origin with no CORS headers.',
    );
  });

  it('wears the shared chip for provenance, untinted', () => {
    const via = resultCard({ source: resolved() }).querySelector('.result-card__via');
    expect(via?.textContent).toBe('source map');
    // The shared chip, so the badge matches every other categorical label in the
    // product; untinted, so it borrows no data colour and says nothing about
    // whether "compiled" is a worse answer than "source map".
    expect(via?.classList.contains('chip')).toBe(true);
    expect(via?.hasAttribute('data-tint')).toBe(false);
  });

  it('shows a spinner instead of a provenance badge while pending', () => {
    const card = resultCard({ source: component({ status: 'pending' }) });
    expect(card.querySelector('.result-card__spinner')).not.toBeNull();
    expect(card.querySelector('.result-card__via')).toBeNull();
  });

  it('marks a component that lives in node_modules', () => {
    const card = resultCard({ source: resolved({ dependency: true }) });
    expect(text(card, '.result-card__dep')).toBe('node_modules');
  });

  // ── The path ───────────────────────────────────────────────────────────────

  it('offers the path as a copy button carrying the frozen label', () => {
    const onCopyPath = vi.fn();
    const card = resultCard({ source: resolved(), onCopyPath });

    const button = card.querySelector<HTMLButtonElement>('button.result-card__path');
    expect(button).not.toBeNull();
    expect(button?.title).toBe('Copy path');
    expect(button?.getAttribute('aria-label')).toBe('Copy path');

    button?.click();
    // Copied and displayed are one string, so the button cannot copy something
    // other than the path it is sitting on.
    expect(onCopyPath).toHaveBeenCalledWith('src/checkout/CartSummary.tsx:42:7');
    expect(text(card, '.result-card__path-text')).toBe('src/checkout/CartSummary.tsx:42:7');
  });

  it('renders the path as plain text rather than an inert button with no handler', () => {
    const card = resultCard({ source: resolved() });
    expect(card.querySelector('button.result-card__path')).toBeNull();
    expect(text(card, '.result-card__path--static')).toBe('src/checkout/CartSummary.tsx:42:7');
  });

  it('names the bundle a component was found in', () => {
    const card = resultCard({ source: resolved() });
    expect(text(card, '.result-card__origin')).toBe('https://shop.example/assets/main.a1b2c3.js');
  });

  it('shows no path line when there is no position to show', () => {
    const card = resultCard({ source: component({ status: 'not-found' }) });
    expect(card.querySelector('.result-card__path')).toBeNull();
    expect(card.querySelector('.result-card__origin')).toBeNull();
  });

  // ── Open in Editor ─────────────────────────────────────────────────────────

  it('offers Open in Editor when the settings can build a URL', () => {
    const onOpenEditor = vi.fn();
    const card = resultCard({ source: resolved(), link: LINK, onOpenEditor });

    const button = [...card.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Open in Editor'),
    );
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);

    button?.click();
    expect(onOpenEditor).toHaveBeenCalledWith(
      'vscode://file//Users/dev/shop/src/checkout/CartSummary.tsx:42:7',
    );
  });

  it('says on the card, not in a tooltip, that no project root is set', () => {
    const card = resultCard({ source: resolved(), link: null, onOpenEditor: vi.fn() });

    const button = [...card.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Open in Editor'),
    );
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(true);
    expect(text(card, '.result-card__path-text')).toBe('src/checkout/CartSummary.tsx:42:7');

    /*
     * The explanation used to live only in `button.title`. A disabled button
     * suppresses pointer events, so Chrome never rendered that tooltip and the
     * first run of every install showed a correct path beside a dead button
     * with nothing to say why. It has to be in the card's own text.
     */
    const banner = card.querySelector('.result-card__unconfigured');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('No project root set');
  });

  it('renders a disabled Open in Editor button for a component with no original source', () => {
    const compiledOnly = component({
      status: 'compiled-only',
      via: 'bundle-search',
      compiled: { url: 'https://x.test/a.js', line: pos0(3), column: pos0(1) },
    });
    const card = resultCard({ source: compiledOnly, link: LINK, onOpenEditor: vi.fn() });
    const button = [...card.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Open in Editor'),
    );
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe('No original source resolved, so there is no file to open.');
  });

  // ── Open in Sources ────────────────────────────────────────────────────────

  it('offers Open in Sources only when a compiled position exists', () => {
    const onOpenSources = vi.fn();
    const withCompiled = resultCard({ source: resolved(), onOpenSources });

    const button = [...withCompiled.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Open in Sources'),
    );
    button?.click();
    // Handed back 0-based, exactly as stored — the DevTools Sources API is
    // 0-based too, so this is the one number that must not be converted.
    expect(onOpenSources).toHaveBeenCalledWith({
      url: 'https://shop.example/assets/main.a1b2c3.js',
      line: 0,
      column: 9184,
    });

    const without = resultCard({
      source: component({ status: 'not-found' }),
      onOpenSources: vi.fn(),
    });
    expect(without.textContent).not.toContain('Open in Sources');
  });

  it('omits Open in Sources on a surface that has no Sources panel', () => {
    const card = resultCard({ source: resolved() });
    expect(card.textContent).not.toContain('Open in Sources');
  });

  // ── Pick another ────────────────────────────────────────────────────────────

  it('offers Pick another in the action row, under the name the panel uses', () => {
    const onPickAnother = vi.fn();
    const card = resultCard({ source: resolved(), onPickAnother });

    const pickBtn = [...card.querySelectorAll<HTMLButtonElement>('.result-card__actions button')].find(
      (node) => node.textContent?.includes('Pick another'),
    );
    expect(pickBtn).toBeDefined();
    pickBtn?.click();
    expect(onPickAnother).toHaveBeenCalled();
  });

  it('copies from the path line and nowhere else', () => {
    // Two controls firing one handler with one argument is two ways to be told
    // the same thing worked — and the row's `Copy` could not say copy what.
    const card = resultCard({ source: resolved(), onCopyPath: vi.fn(), onPickAnother: vi.fn() });

    const rowLabels = [...card.querySelectorAll('.result-card__actions button')].map(
      (node) => node.textContent,
    );
    expect(rowLabels.some((label) => label?.includes('Copy'))).toBe(false);

    const pathButton = card.querySelector<HTMLButtonElement>('button.result-card__path');
    expect(pathButton?.getAttribute('aria-label')).toBe('Copy path');
  });

  // ── Ambiguity ──────────────────────────────────────────────────────────────

  it('warns when the same code matched more than one place', () => {
    const card = resultCard({
      source: resolved({ status: 'ambiguous', matchCount: 4 }),
      resourcesSearched: 9,
    });

    const banner = card.querySelector('.result-card__ambiguity');
    expect(banner).not.toBeNull();
    expect(banner?.classList.contains('banner--warn')).toBe(true);
    expect(banner?.textContent).toContain('matched 4 places across 9 scripts');
  });

  it('warns on a resolved component too — a single match is the only quiet case', () => {
    expect(
      resultCard({ source: resolved({ matchCount: 3 }) }).querySelector('.result-card__ambiguity'),
    ).not.toBeNull();

    expect(
      resultCard({ source: resolved({ matchCount: 1 }) }).querySelector('.result-card__ambiguity'),
    ).toBeNull();

    expect(
      resultCard({ source: resolved() }).querySelector('.result-card__ambiguity'),
    ).toBeNull();
  });

  // ── Advice ─────────────────────────────────────────────────────────────────

  /*
   * The defect these pin: every failure diagnosed and none of them advised.
   * `detail` said *most likely a lazy chunk that was never fetched* and stopped
   * at the comma, which is the half of the sentence that describes the problem
   * and not the half that ends it. The four statuses below are the ones a reader
   * can actually do something about, so each of them has to say what.
   */
  it('advises, and not only diagnoses, on every outcome a reader can act on', () => {
    for (const status of ['not-found', 'skipped', 'no-map', 'compiled-only'] as const) {
      const action = STATUS_ACTION[status];
      expect(action, status).not.toBeNull();
      expect(action?.text.length, status).toBeGreaterThan(0);
    }

    // `ambiguous` too: an answer that may be the wrong one of several is the
    // outcome most worth not acting on blindly.
    expect(STATUS_ACTION.ambiguous).not.toBeNull();
  });

  it('gives no advice for a resolved component, which needs none', () => {
    expect(actionFor(resolved())).toBeNull();
    expect(resultCard({ source: resolved() }).querySelector('.result-card__action')).toBeNull();
  });

  it('tells a not-found component’s reader to load the route and pick again', () => {
    const card = resultCard({ source: component({ status: 'not-found' }) });
    const advice = text(card, '.result-card__action');
    expect(advice).toContain('Load the route');
    expect(advice).toContain('pick it again');
  });

  it('names the missing .map files rather than only the missing file', () => {
    for (const status of ['no-map', 'compiled-only'] as const) {
      const card = resultCard({ source: component({ status }) });
      expect(text(card, '.result-card__action'), status).toContain('source maps');
      expect(text(card, '.result-card__action'), status).toContain('.map');
    }
  });

  it('reads the advice after the sentence it finishes', () => {
    const card = resultCard({ source: component({ status: 'not-found' }) });
    const children = [...card.children];
    const detail = children.findIndex((node) => node.classList.contains('result-card__detail'));
    const advice = children.findIndex((node) => node.classList.contains('result-card__action'));
    expect(detail).toBeGreaterThanOrEqual(0);
    expect(advice).toBe(detail + 1);
  });

  it('offers a live switch for a component nobody looked up', () => {
    const onEnableSourceLookup = vi.fn();
    const card = resultCard({ source: component({ status: 'skipped' }), onEnableSourceLookup });

    const button = card.querySelector<HTMLButtonElement>('.result-card__action-btn');
    expect(button?.textContent).toContain('Turn on source lookup');

    button?.click();
    expect(onEnableSourceLookup).toHaveBeenCalled();
  });

  it('degrades to advice alone on a surface that cannot write settings', () => {
    // Exactly what `onOpenEditor` already does: a callback nobody supplied is a
    // control nobody sees, rather than a control that does nothing.
    const card = resultCard({ source: component({ status: 'skipped' }) });
    expect(card.querySelector('.result-card__action-btn')).toBeNull();
    expect(text(card, '.result-card__action')).toContain('Turn source lookup back on');
  });

  it('never renders a control on advice that has none', () => {
    const card = resultCard({
      source: component({ status: 'not-found' }),
      onEnableSourceLookup: vi.fn(),
    });
    expect(card.querySelector('.result-card__action-btn')).toBeNull();
  });

  it('warns without a script count, which the flow review never has', () => {
    expect(ambiguityText(2)).toBe(
      'This code matched 2 places, so the path above may not be the one you want.',
    );
    expect(ambiguityText(2, 1)).toContain('across 1 script,');
  });
});
