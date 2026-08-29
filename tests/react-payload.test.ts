/**
 * What leaves the machine, and what must not.
 *
 * The component table is the one part of a flow assembled from the page's own
 * compiled code, so this file is where the promises about it are kept: the table
 * is cut to the steps actually being sent, no needle ever appears in a payload,
 * and the component each step is attributed to is decided once here rather than
 * again by whoever reads it.
 */

import { describe, expect, it } from 'vitest';
import { buildPayload, pruneSteps } from '../src/features/mcp/send.js';
import { exportToJSON } from '../src/core/export/json.js';
import { CAPPED_ID } from '../src/core/react/table.js';
import type { ComponentSource, FlowReact, Step } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;

function step(chain: string[] | null, over: Partial<Step> = {}): Step {
  return {
    type: 'click',
    url: 'https://shop.example.com/cart',
    timestamp: NOW,
    action: 'Clicked "Buy"',
    element: {
      tag: 'button',
      cssSelector: 'button',
      xpath: '/button',
      boundingBox: null,
      ...(chain ? { react: { chain } } : {}),
    },
    ...over,
  } as Step;
}

const resolved = (name: string, source: string): ComponentSource => ({
  name,
  status: 'resolved',
  via: 'bundle-search',
  source,
  line: 34,
});

const react = (components: Record<string, ComponentSource>): FlowReact => ({
  detected: true,
  version: '18.3.1',
  build: 'production',
  components,
});

describe('the payload carries the component table', () => {
  it('says nothing about React when the flow was not recorded on a React page', () => {
    expect(buildPayload('flow-1', 'Checkout', [step(null)], NOW).react).toBeUndefined();
  });

  it('keeps the meta alongside the components, so the reader knows what it is looking at', () => {
    const payload = buildPayload(
      'flow-1',
      'Checkout',
      [step(['cart'])],
      NOW,
      react({ cart: resolved('Cart', 'src/Cart.tsx') }),
    );

    expect(payload.react?.detected).toBe(true);
    expect(payload.react?.build).toBe('production');
    expect(payload.react?.components.cart.source).toBe('src/Cart.tsx');
  });

  it('prunes to the ids the steps being sent still point at', () => {
    // The user deleted the step that clicked the modal before pressing Send.
    // Its source path has no business travelling with what is left.
    const table = react({
      cart: resolved('Cart', 'src/Cart.tsx'),
      modal: resolved('CheckoutModal', 'src/CheckoutModal.tsx'),
    });

    const payload = buildPayload('flow-1', 'Checkout', [step(['cart'])], NOW, table);

    expect(Object.keys(payload.react?.components ?? {})).toEqual(['cart']);
  });

  it('keeps the cap marker, which is a fact about the flow rather than one step', () => {
    const table = react({
      cart: resolved('Cart', 'src/Cart.tsx'),
      [CAPPED_ID]: { name: 'FlowSnap', status: 'skipped', detail: 'too many components' },
    });

    const payload = buildPayload('flow-1', 'Checkout', [step(['cart'])], NOW, table);

    expect(payload.react?.components[CAPPED_ID]).toBeDefined();
  });

  it('is absent rather than empty when nothing survived pruning', () => {
    const table = react({ modal: resolved('CheckoutModal', 'src/CheckoutModal.tsx') });

    expect(buildPayload('flow-1', 'Checkout', [step(null)], NOW, table).react).toBeUndefined();
  });

  it('stamps the component each step is attributed to, so the server need not guess', () => {
    const table = react({
      app: resolved('App', 'src/App.tsx'),
      cart: resolved('AddToCartButton', 'src/cart/AddToCartButton.tsx'),
    });

    const payload = buildPayload('flow-1', 'Checkout', [step(['app', 'cart'])], NOW, table);

    expect(payload.steps[0].element?.react?.owner).toBe('cart');
    // The chain is untouched: the owner is an answer added beside the evidence,
    // not a replacement for it.
    expect(payload.steps[0].element?.react?.chain).toEqual(['app', 'cart']);
  });

  it('leaves the original steps alone', () => {
    const steps = [step(['cart'])];
    buildPayload('flow-1', 'Checkout', steps, NOW, react({ cart: resolved('Cart', 'src/Cart.tsx') }));

    expect(steps[0].element?.react?.owner).toBeUndefined();
  });
});

describe('needles never ship', () => {
  /*
   * A needle is 200 characters of the site's own compiled source, kept only long
   * enough to find a component in a bundle. `ComponentSource` has no field for
   * one, and this is the assertion that keeps it that way: adding a needle to
   * the table for convenience would put page source on the wire.
   */
  it('no key or value called a needle survives into the payload', () => {
    const table = react({ cart: resolved('Cart', 'src/Cart.tsx') });
    const wire = JSON.stringify(buildPayload('flow-1', 'Checkout', [step(['cart'])], NOW, table));

    expect(wire.toLowerCase()).not.toContain('needle');
  });

  it('nor into a JSON export', () => {
    const table = react({ cart: resolved('Cart', 'src/Cart.tsx') });

    expect(exportToJSON([step(['cart'])], { react: table }).toLowerCase()).not.toContain('needle');
  });
});

describe('the JSON export says the same thing as the payload', () => {
  it('carries the pruned table and the stamped owner', () => {
    const table = react({
      app: resolved('App', 'src/App.tsx'),
      cart: resolved('AddToCartButton', 'src/cart/AddToCartButton.tsx'),
      modal: resolved('CheckoutModal', 'src/CheckoutModal.tsx'),
    });

    const json = JSON.parse(exportToJSON([step(['app', 'cart'])], { react: table })) as {
      react?: FlowReact;
      steps: Step[];
    };

    expect(Object.keys(json.react?.components ?? {})).toEqual(['app', 'cart']);
    expect(json.steps[0].element?.react?.owner).toBe('cart');
  });

  it('omits the key entirely for a flow that is not React', () => {
    const json = JSON.parse(exportToJSON([step(null)])) as Record<string, unknown>;
    expect('react' in json).toBe(false);
  });
});

/**
 * The opt-out.
 *
 * React attribution is recording data like console logs and network calls, and
 * it is switched off the same way — a checkbox beside theirs, applied here so
 * that what the user declined never reaches the wire. These are the tests that
 * say the switch is real rather than a flag someone downstream is trusted with.
 */
describe('switching React off', () => {
  const OFF = { images: true, network: true, logs: true, react: false };
  const ON = { images: true, network: true, logs: true, react: true };

  it('takes the component ids off the steps', () => {
    const [sent] = pruneSteps([step(['cart'])], OFF);
    expect(sent.element?.react).toBeUndefined();
  });

  it('leaves the recording it was given untouched', () => {
    // The step objects are shared with what is in storage: stripping through
    // one would delete the attribution from the recording itself.
    const original = step(['cart']);
    pruneSteps([original], OFF);
    expect(original.element?.react?.chain).toEqual(['cart']);
  });

  it('drops the table with them, because nothing references it any more', () => {
    const sending = pruneSteps([step(['cart'])], OFF);
    const payload = buildPayload(
      'flow-1',
      'Checkout',
      sending,
      NOW,
      react({ cart: resolved('Cart', 'src/components/Cart.tsx') }),
    );

    expect(payload.react).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('src/components/Cart.tsx');
  });

  it('leaves console logs and network calls exactly where they were', () => {
    const one = step(['cart'], {
      consoleLogs: [{ level: 'error', args: ['boom'], timestamp: NOW }],
      networkCalls: [
        {
          method: 'POST',
          url: 'https://api.example.com/cart',
          requestHeaders: {},
          requestBody: null,
          status: 500,
          responseHeaders: {},
          responseBody: null,
          durationMs: 12,
          timestamp: NOW,
        },
      ],
    });

    const [sent] = pruneSteps([one], OFF);

    expect(sent.consoleLogs).toHaveLength(1);
    expect(sent.networkCalls).toHaveLength(1);
    expect(sent.screenshot).toBe(one.screenshot);
  });

  it('changes nothing at all when it is left on', () => {
    expect(pruneSteps([step(['cart'])], ON)[0].element?.react?.chain).toEqual(['cart']);
  });

  it('keeps the ids out of the JSON export too, table or no table', () => {
    // The exporters take the table's absence as the switch, so a step's ids go
    // with it — they index a table the reader does not have.
    const json = JSON.parse(exportToJSON([step(['cart'])], {}));
    expect(json.steps[0].element.react).toBeUndefined();
    expect(json.react).toBeUndefined();
  });
});
