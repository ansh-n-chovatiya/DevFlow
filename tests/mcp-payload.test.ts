/**
 * The POST body is a wire contract: the server updates itself through `npx`
 * while the extension is installed by hand, so the two versions are rarely the
 * same pair. These are the fields the server reads.
 */

import { describe, expect, it } from 'vitest';
import { buildPayload, buildPrompt } from '../src/features/mcp/send.js';
import { FLOW_SCHEMA_VERSION } from '../src/shared/constants.js';
import type { Step } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;

function step(over: Partial<Step> = {}): Step {
  return {
    type: 'click',
    url: 'https://shop.example.com/cart',
    timestamp: NOW,
    action: 'Clicked "Buy"',
    element: { tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null },
    ...over,
  } as Step;
}

describe('the payload', () => {
  it('declares the schema it was written against', () => {
    expect(buildPayload('flow-1', 'Checkout', [step()], NOW).schemaVersion).toBe(
      FLOW_SCHEMA_VERSION,
    );
  });

  it('carries the id, name, time and steps the server indexes on', () => {
    const payload = buildPayload('flow-1', 'Checkout', [step()], NOW);

    expect(payload.id).toBe('flow-1');
    expect(payload.name).toBe('Checkout');
    expect(payload.timestamp).toBe(NOW);
    expect(payload.steps).toHaveLength(1);
  });

  it('names where the flow began, so a list row can say more than a count', () => {
    const payload = buildPayload(
      'flow-1',
      'Checkout',
      [step({ url: 'https://shop.example.com/cart' }), step({ url: 'https://shop.example.com/pay' })],
      NOW,
    );

    expect(payload.startUrl).toBe('https://shop.example.com/cart');
  });
});

describe('the prompt', () => {
  it('names the tool and the id, so the first message is one tool call', () => {
    const prompt = buildPrompt('flow-1', [step(), step()], 'https://shop.example.com/cart');

    expect(prompt).toContain('get_flow("flow-1")');
    expect(prompt).toContain('2-step');
    expect(prompt).toContain('https://shop.example.com/cart');
  });

  it('omits the URL rather than writing "undefined" when there is none', () => {
    expect(buildPrompt('flow-1', [step()], undefined)).not.toContain('undefined');
  });
});
