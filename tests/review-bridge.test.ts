// @vitest-environment jsdom

/**
 * The seam W2·K exists to make: a recorded step, rendered by the shared card.
 *
 * `tests/review-view.test.ts` specifies what the review decides and
 * `tests/result-card.test.ts` specifies what the card draws. Neither of them can
 * fail when the two stop fitting together — and that is the failure worth
 * guarding, because it is the one that turns the flow review back into a
 * second locate surface with its own words for "no map".
 *
 * So these tests take the same journey the screen does: a flow with a component
 * table goes through `deriveReviewView`, and the record that comes out the other
 * side is handed to `resultCard` exactly as `review.ts` hands it over. What is
 * asserted is agreement — the step's line and the card it opens saying one
 * thing — plus the two decisions the review makes about the card that no other
 * surface makes: no `Open in Sources`, and no `resourcesSearched`.
 */

import { describe, expect, it, vi } from 'vitest';
import { pos0, pos1 } from '../src/core/locate/positions.js';
import type { ComponentSource, ComponentStatus, FlowReact, Step } from '../src/shared/types.js';
import { resultCard } from '../src/ui/components/result-card.js';
import { deriveReviewView, type StepComponentView } from '../src/ui/viewer/review-view.js';

const NOW = 1_700_000_000_000;

const EDITOR = { projectRoot: '/Users/me/shop', template: 'vscode://file/{path}:{line1}:{col1}' };

function clicked(chain: string[]): Step {
  return {
    type: 'click',
    url: 'https://example.com/',
    timestamp: NOW,
    action: 'Clicked "Save"',
    element: {
      tag: 'button',
      cssSelector: '#save',
      xpath: '/html/body/button',
      boundingBox: null,
      react: { chain },
    },
  } as unknown as Step;
}

/** One recorded click, through the review, to the component it happened in. */
function componentOf(
  record: ComponentSource,
  editor: { projectRoot: string; template: string } | null = null,
): StepComponentView {
  const react: FlowReact = { detected: true, build: 'production', components: { one: record } };

  const view = deriveReviewView({
    flow: { id: 'f', name: 'Checkout', steps: [clicked(['one'])], createdAt: NOW, react, settings: null },
    missing: false,
    filter: 'all',
    activeIndex: null,
    recording: 'idle',
    now: NOW,
    editor,
  });

  const component = view.steps[0].component;
  if (!component) throw new Error('the step carried no component');
  return component;
}

/**
 * The card, built the way `review.ts` builds it — which is the part under test.
 * `onOpenSources` is absent on purpose; see the review's own note.
 */
function cardFor(
  component: StepComponentView,
  handlers: { onCopyPath?: (path: string) => void; onOpenEditor?: (url: string) => void } = {},
): HTMLElement {
  return resultCard({
    source: component.record,
    link: EDITOR,
    onCopyPath: handlers.onCopyPath,
    onOpenEditor: handlers.onOpenEditor,
  });
}

const buttonNamed = (card: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...card.querySelectorAll('button')].find((button) => button.textContent?.includes(label));

describe('a recorded step opens the same card the other surfaces show', () => {
  const resolved: ComponentSource = {
    name: 'AddToCartButton',
    status: 'resolved',
    via: 'bundle-search',
    source: 'src/Cart.tsx',
    line: pos1(34),
    column: pos1(12),
  };

  it('shows on the card the path the step line already showed', () => {
    const component = componentOf(resolved);
    const card = cardFor(component);

    // One string, two places. A second formatter on the step line is how the
    // review would drift away from the panel without anything going red.
    expect(card.textContent).toContain(component.path);
    expect(component.path).toBe('src/Cart.tsx:34:12');
  });

  it('opens the file through the URL the review derived, not one of its own', () => {
    const component = componentOf(resolved, EDITOR);
    const onOpenEditor = vi.fn();
    const card = cardFor(component, { onOpenEditor });

    const open = buttonNamed(card, 'Open in Editor');
    expect(open).toBeDefined();
    open?.click();

    // The card builds its own URL from `link`; the view model builds one from
    // the same settings. They are the same function, and this is the assertion
    // that keeps it that way — a divergence here opens a different file than
    // the one the step says it is pointing at.
    expect(onOpenEditor).toHaveBeenCalledWith(component.editorUrl);
    expect(component.editorUrl).toBe('vscode://file//Users/me/shop/src/Cart.tsx:34:12');
  });

  it('copies the string it displayed', () => {
    const component = componentOf(resolved);
    const onCopyPath = vi.fn();
    const card = cardFor(component, { onCopyPath });

    buttonNamed(card, 'src/Cart.tsx')?.click();
    expect(onCopyPath).toHaveBeenCalledWith(component.path);
  });

  /*
   * The review is an extension tab. It has no DevTools window to reveal a
   * compiled position in, and the card reads a missing handler as "this surface
   * cannot do that" — so the button is absent rather than present and inert.
   */
  it('offers no Open in Sources, even holding a compiled position', () => {
    const component = componentOf({
      name: 'Modal',
      status: 'compiled-only',
      via: 'bundle-search',
      compiled: { url: 'https://example.com/assets/main-a1b2.js', line: pos0(400), column: pos0(17) },
    });
    const card = cardFor(component, { onOpenEditor: vi.fn() });

    expect(card.textContent).toContain('main-a1b2.js:401:18');
    expect(buttonNamed(card, 'Open in Sources')).toBeUndefined();
  });

  it('warns about an ambiguous match without claiming a search it never made', () => {
    const component = componentOf({
      name: 'Row',
      status: 'ambiguous',
      via: 'bundle-search',
      source: 'src/Row.tsx',
      line: pos1(9),
      matchCount: 3,
    });
    const card = cardFor(component);

    // No `resourcesSearched`: that number belongs to an interactive locate, and
    // a recorded step never had one. The sentence works without it.
    expect(card.textContent).toContain('This code matched 3 places,');
    expect(card.textContent).not.toContain('across');
  });
});

describe('every outcome a recorded component can have', () => {
  const STATUSES: ComponentStatus[] = [
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

  it('reaches the card as itself, with the review adding no word of its own', () => {
    for (const status of STATUSES) {
      const component = componentOf({ name: 'Widget', status });
      const card = cardFor(component);

      expect(card.dataset.status, status).toBe(status);
      expect(component.status, status).toBe(status);

      if (status === 'resolved') {
        expect(component.detail, status).toBeNull();
        continue;
      }

      // The one sentence, on the card and on the view model, identical. This is
      // requirement 3 of the package: a step whose component could not be
      // resolved says which of the eight it was, in the card's words.
      expect(component.detail, status).not.toBeNull();
      expect(card.textContent, status).toContain(component.detail);
    }
  });
});
