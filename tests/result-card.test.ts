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
import { pos0, pos1 } from '../src/core/react/positions.js';
import type { ComponentSource, ComponentStatus } from '../src/shared/types.js';
import {
  ambiguityText,
  detailText,
  pathText,
  resultCard,
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
  it('reads a development build off the fiber', () => {
    expect(viaLabel(component({ via: 'debug-source', source: 'src/App.tsx' }))).toBe('dev build');
  });

  it('says "source map" only when the search reached an original file', () => {
    expect(viaLabel(resolved())).toBe('source map');
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
      expect(text(card, '.source-card__name'), status).toBe('CartSummary');

      if (status === 'resolved') {
        expect(card.querySelector('.source-card__detail'), status).toBeNull();
      } else {
        // The whole point: an unresolved component explains itself.
        expect(text(card, '.source-card__detail'), status).toBe(STATUS_DETAIL[status]);
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
    expect(text(card, '.source-card__detail')).toBe(
      'Every bundle was cross-origin with no CORS headers.',
    );
  });

  it('shows a spinner instead of a provenance badge while pending', () => {
    const card = resultCard({ source: component({ status: 'pending' }) });
    expect(card.querySelector('.source-card__spinner')).not.toBeNull();
    expect(card.querySelector('.source-card__via')).toBeNull();
  });

  it('marks a component that lives in node_modules', () => {
    const card = resultCard({ source: resolved({ dependency: true }) });
    expect(text(card, '.source-card__dep')).toBe('node_modules');
  });

  // ── The path ───────────────────────────────────────────────────────────────

  it('offers the path as a copy button carrying the frozen label', () => {
    const onCopyPath = vi.fn();
    const card = resultCard({ source: resolved(), onCopyPath });

    const button = card.querySelector<HTMLButtonElement>('button.source-card__path');
    expect(button).not.toBeNull();
    expect(button?.title).toBe('Copy path');
    expect(button?.getAttribute('aria-label')).toBe('Copy path');

    button?.click();
    // Copied and displayed are one string, so the button cannot copy something
    // other than the path it is sitting on.
    expect(onCopyPath).toHaveBeenCalledWith('src/checkout/CartSummary.tsx:42:7');
    expect(text(card, '.source-card__path-text')).toBe('src/checkout/CartSummary.tsx:42:7');
  });

  it('renders the path as plain text rather than an inert button with no handler', () => {
    const card = resultCard({ source: resolved() });
    expect(card.querySelector('button.source-card__path')).toBeNull();
    expect(text(card, '.source-card__path--static')).toBe('src/checkout/CartSummary.tsx:42:7');
  });

  it('names the bundle a component was found in', () => {
    const card = resultCard({ source: resolved() });
    expect(text(card, '.source-card__origin')).toBe('https://shop.example/assets/main.a1b2c3.js');
  });

  it('shows no path line when there is no position to show', () => {
    const card = resultCard({ source: component({ status: 'not-found' }) });
    expect(card.querySelector('.source-card__path')).toBeNull();
    expect(card.querySelector('.source-card__origin')).toBeNull();
  });

  // ── Open in Editor ─────────────────────────────────────────────────────────

  it('offers Open in Editor when the settings can build a URL', () => {
    const onOpenEditor = vi.fn();
    const card = resultCard({ source: resolved(), link: LINK, onOpenEditor });

    const button = [...card.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Open in Editor'),
    );
    expect(button).toBeDefined();

    button?.click();
    expect(onOpenEditor).toHaveBeenCalledWith(
      'vscode://file//Users/dev/shop/src/checkout/CartSummary.tsx:42:7',
    );
  });

  it('still shows the path when there is no link — null is the common case', () => {
    const card = resultCard({ source: resolved(), link: null, onOpenEditor: vi.fn() });

    expect(card.textContent).not.toContain('Open in Editor');
    expect(text(card, '.source-card__path-text')).toBe('src/checkout/CartSummary.tsx:42:7');
    // A missing link is not an error, so nothing about the card says it is.
    expect(card.querySelector('.banner')).toBeNull();
  });

  it('offers no editor link for a component with no original source', () => {
    const compiledOnly = component({
      status: 'compiled-only',
      via: 'bundle-search',
      compiled: { url: 'https://x.test/a.js', line: pos0(3), column: pos0(1) },
    });
    const card = resultCard({ source: compiledOnly, link: LINK, onOpenEditor: vi.fn() });
    expect(card.textContent).not.toContain('Open in Editor');
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

  // ── Ambiguity ──────────────────────────────────────────────────────────────

  it('warns when the same code matched more than one place', () => {
    const card = resultCard({
      source: resolved({ status: 'ambiguous', matchCount: 4 }),
      resourcesSearched: 9,
    });

    const banner = card.querySelector('.source-card__ambiguity');
    expect(banner).not.toBeNull();
    expect(banner?.classList.contains('banner--warn')).toBe(true);
    expect(banner?.textContent).toContain('matched 4 places across 9 scripts');
  });

  it('warns on a resolved component too — a single match is the only quiet case', () => {
    expect(
      resultCard({ source: resolved({ matchCount: 3 }) }).querySelector('.source-card__ambiguity'),
    ).not.toBeNull();

    expect(
      resultCard({ source: resolved({ matchCount: 1 }) }).querySelector('.source-card__ambiguity'),
    ).toBeNull();

    expect(
      resultCard({ source: resolved() }).querySelector('.source-card__ambiguity'),
    ).toBeNull();
  });

  it('warns without a script count, which the flow review never has', () => {
    expect(ambiguityText(2)).toBe(
      'This code matched 2 places, so the path above may not be the one you want.',
    );
    expect(ambiguityText(2, 1)).toContain('across 1 script,');
  });
});
