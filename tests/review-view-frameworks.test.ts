/**
 * What the extension's own review panel shows for a Vue, Svelte or RSC page.
 *
 * It showed nothing, for a while: `componentView` started at `stepOwner`, which
 * reads `step.element.react`, so a recording whose components all came from an
 * adapter had a component table, a chain on every step, an answer in the MCP
 * server — and an empty card in the viewer the person recording was looking at.
 *
 * The fix is a fallback rather than a second renderer. A Vue component is a
 * `ComponentSource` exactly as a React one is, so it reads through the same
 * card, the same status words and the same editor link; only *which* component
 * to show had to be decided.
 */
import { describe, expect, it } from 'vitest';
import { deriveReviewView, type ReviewInput } from '../src/ui/viewer/review-view.js';
import { pos1 } from '../src/core/locate/positions.js';
import type { ComponentSource, Step } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;

const CHECKOUT: ComponentSource = {
  name: 'CheckoutButton',
  status: 'resolved',
  via: 'bundle-search',
  source: 'src/components/CheckoutButton.vue',
  line: pos1(6),
};
const PANEL: ComponentSource = {
  name: 'CartPanel',
  status: 'resolved',
  via: 'bundle-search',
  source: 'src/components/CartPanel.vue',
  line: pos1(5),
};

function vueStep(chain: string[]): Step {
  return {
    index: 1,
    type: 'click',
    timestamp: NOW,
    url: 'https://shop.test/',
    action: 'Clicked "Checkout"',
    element: {
      tag: 'button',
      cssSelector: '#checkout',
      xpath: '//button',
      boundingBox: null,
      frameworks: [{ framework: 'vue', chain }],
    },
  } as unknown as Step;
}

function input(over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    flow: {
      id: 'flow_1',
      name: 'Checkout',
      steps: [vueStep(['panel', 'checkout'])],
      createdAt: NOW - 60_000,
      react: null,
      vue: { detected: true, build: 'production', components: { panel: PANEL, checkout: CHECKOUT } },
      settings: null,
    },
    missing: false,
    filter: 'all',
    activeIndex: null,
    recording: 'idle',
    now: NOW,
    editor: null,
    ...over,
  };
}

describe('a card for a step no React component claimed', () => {
  it('shows the Vue component rather than an empty slot', () => {
    const [card] = deriveReviewView(input()).steps;

    expect(card.component).not.toBeNull();
    expect(card.component?.name).toBe('CheckoutButton');
    expect(card.component?.path).toContain('src/components/CheckoutButton.vue');
    expect(card.component?.status).toBe('resolved');
  });

  /*
   * Innermost, because that is where the click landed — the same end of the
   * chain `stepOwner` starts from. `CartPanel` is an ancestor, not the answer.
   */
  it('takes the innermost component of the chain', () => {
    expect(deriveReviewView(input()).steps[0].component?.name).not.toBe('CartPanel');
  });

  /*
   * No `within`. That is `core/react/owner.ts`'s four preference tiers, derived
   * from how React's chains are shaped, and nothing equivalent has been
   * measured for these runtimes. Showing one would be a confident attribution
   * by a rule nobody checked.
   */
  it('claims no enclosing component, because no rule decides one', () => {
    expect(deriveReviewView(input()).steps[0].component?.within).toBeNull();
  });

  /*
   * A chain naming ids the table does not hold is not an answer. Ids exist so a
   * chain need not repeat a path; one with nothing behind it would render as a
   * blank card that looks like a bug in the recorder.
   */
  it('falls back past an id the table does not hold', () => {
    const view = deriveReviewView(
      input({
        flow: {
          ...input().flow!,
          steps: [vueStep(['panel', 'missing-id'])],
        },
      }),
    );
    expect(view.steps[0].component?.name).toBe('CartPanel');
  });

  it('shows nothing when the table holds none of the chain', () => {
    const view = deriveReviewView(
      input({ flow: { ...input().flow!, steps: [vueStep(['nope'])] } }),
    );
    expect(view.steps[0].component).toBeNull();
  });
});
