/**
 * What a flow costs the agent that reads it.
 *
 * `get_flow` returns the payload built here, verbatim, into a context window.
 * Before compaction a 15-step recording with three calls a step measured ~93k
 * tokens — past the MCP output cap every client applies, where the failure is
 * not a large bill but a JSON document cut in half without a word. So weight is
 * a property of the wire format, and this file is the assertion that keeps it
 * one: the budget below fails loudly the next time a field is added to the
 * payload without anyone pricing it.
 *
 * Every number is `chars / 4`, the usual rough token estimate. Nothing here
 * depends on it being exact — the ratios are what matter, and they are large.
 */

import { describe, expect, it } from 'vitest';
import { buildPayload, leanCalls } from '../src/features/mcp/send.js';
import { DIAGNOSTIC_LIMIT } from '../src/core/schema/index.js';
import type { NetworkCall, Step } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;

const tokens = (value: unknown) => Math.round(JSON.stringify(value, null, 2).length / 4);

/** The headers a real call carries once capture has redacted the sensitive ones. */
const HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'cache-control': 'no-cache',
  'x-request-id': 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  accept: '*/*',
  authorization: '[redacted]',
  date: 'Mon, 25 Aug 2026 10:00:00 GMT',
  server: 'nginx',
  vary: 'Accept-Encoding',
};

/** A perfectly ordinary list response: 40 rows of eight fields. */
const LIST_BODY = JSON.stringify({
  items: Array.from({ length: 40 }, (_, i) => ({
    id: i,
    sku: `SKU-${i}`,
    name: `Product ${i}`,
    price: 19.99,
    qty: 2,
    image: `https://cdn.example.com/p/${i}.jpg`,
    category: 'widgets',
    inStock: true,
  })),
});

function call(over: Partial<NetworkCall> = {}): NetworkCall {
  return {
    method: 'GET',
    url: 'https://api.example.com/v1/cart/items',
    requestHeaders: HEADERS,
    requestBody: null,
    status: 200,
    responseHeaders: HEADERS,
    responseBody: LIST_BODY,
    durationMs: 143,
    timestamp: NOW,
    ...over,
  };
}

function step(n: number, calls: NetworkCall[] = [call(), call(), call()]): Step {
  return {
    type: 'click',
    url: 'https://shop.example.com/cart',
    timestamp: NOW + n * 1000,
    action: 'Clicked "Add to cart"',
    stepNumber: n,
    element: {
      tag: 'button',
      text: 'Add to cart',
      label: 'Add to cart',
      role: 'button',
      cssSelector: 'div#root > main.content > section.cart > div.row:nth-child(3) > button.btn',
      xpath: '/html/body/div[1]/main/section[2]/div[3]/button',
      boundingBox: { x: 412, y: 688, width: 132, height: 40 },
    },
    consoleLogs: [{ level: 'warn', args: ['[analytics] beacon blocked'], timestamp: NOW }],
    networkCalls: calls,
  };
}

const FLOW = Array.from({ length: 15 }, (_, i) => step(i + 1));

describe('what a sent flow weighs', () => {
  it('costs a fraction of what the raw recording does', () => {
    const raw = tokens(FLOW);
    const sent = tokens(buildPayload('flow-1', 'Cart bug', FLOW, NOW).steps);

    // The recording as captured is the thing that used to go over the wire.
    expect(raw).toBeGreaterThan(80_000);
    // An order of magnitude is the point of the exercise, not a stretch goal.
    expect(sent * 8).toBeLessThan(raw);
  });

  /*
   * A ceiling rather than a range: a change that makes the payload *smaller*
   * should never fail a test. This is here to catch the field somebody adds to
   * every network call without noticing it is multiplied by 45.
   */
  it('stays inside a budget a context window can hold', () => {
    expect(tokens(buildPayload('flow-1', 'Cart bug', FLOW, NOW))).toBeLessThan(15_000);
  });
});

describe('what compaction keeps', () => {
  it('replaces a large successful body with its shape', () => {
    const [only] = leanCalls(step(1, [call()])).networkCalls ?? [];

    expect(only.responseBody).toContain('[schema —');
    expect(only.responseBody).toContain('Array(40)');
    // The shape is the answer for a call that worked: field names and types.
    expect(only.responseBody).toContain('sku');
    expect(only.responseBody).not.toContain('SKU-39');
  });

  it('keeps a failed call\'s body verbatim, because the body is the diagnostic', () => {
    const trace = `at CartService.total (src/services/cart.ts:88)\n`.repeat(30);
    const error = JSON.stringify({ error: "Cannot read property 'id' of undefined", stack: trace });
    expect(error.length).toBeGreaterThan(1024); // large enough that a schema would have replaced it

    const [only] = leanCalls(step(1, [call({ status: 500, responseBody: error })])).networkCalls ?? [];

    expect(only.responseBody).toContain("Cannot read property 'id' of undefined");
    expect(only.responseBody).toContain('src/services/cart.ts:88');
    expect(only.responseBody).not.toContain('[schema —');
  });

  it('says so when a failed body is too long to keep whole', () => {
    const huge = `{"error":"${'x'.repeat(DIAGNOSTIC_LIMIT * 2)}"}`;
    const [only] = leanCalls(step(1, [call({ status: 500, responseBody: huge })])).networkCalls ?? [];

    // Silent truncation is the failure mode this codebase refuses everywhere.
    expect(only.responseBody).toContain('truncated');
    expect((only.responseBody ?? '').length).toBeLessThan(huge.length);
  });

  it('drops headers from a call that worked', () => {
    const [only] = leanCalls(step(1, [call()])).networkCalls ?? [];

    expect(only.requestHeaders).toEqual({});
    expect(only.responseHeaders).toEqual({});
  });

  it('keeps the headers that are themselves the bug on a call that failed', () => {
    const [only] =
      leanCalls(
        step(1, [
          call({
            status: null,
            responseHeaders: { 'content-type': 'text/html', date: 'Mon, 25 Aug 2026 10:00:00 GMT' },
          }),
        ]),
      ).networkCalls ?? [];

    // A fetch answered with an HTML error page reads as malformed JSON until
    // this header is visible.
    expect(only.responseHeaders).toEqual({ 'content-type': 'text/html' });
  });

  it('leaves a step that made no calls exactly as it was', () => {
    const bare = step(1, []);
    delete (bare as { networkCalls?: unknown }).networkCalls;

    expect(leanCalls(bare)).toBe(bare);
  });

  it('does not touch the recording it was given', () => {
    const original = step(1, [call()]);
    const before = JSON.stringify(original);

    leanCalls(original);

    // The viewer still shows every header and offers "Show raw" on every body:
    // compaction is what leaves the machine, not what the extension keeps.
    expect(JSON.stringify(original)).toBe(before);
  });
});
