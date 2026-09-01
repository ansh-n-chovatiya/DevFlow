/**
 * `explain_feature`, against the real server and a real graph.
 *
 * The v3.2.0 attempt at this work stream was stopword-matching substring
 * filtering presented as understanding. What replaced it is still lexical
 * matching — names, URLs and repo paths are what the graph holds, so names,
 * URLs and repo paths are what can be matched — and the whole of the difference
 * is in two things this file exists to hold:
 *
 *  1. **It says what it is.** The tool description and the top of every answer
 *     say the match is by name and that DevFlow does not know what the
 *     description means. Delete those sentences and the tool is the previous
 *     one again, byte for byte in behaviour and wrong in what it claims.
 *  2. **The graph does the part matching cannot.** A lexical match reaches only
 *     things that carry the word. The expansion reaches the endpoint a
 *     component calls and the file it was written in, which never carried it.
 *     Without that this is a grep with a longer description.
 *
 * The third thing, quieter than either: an empty answer here is about
 * *vocabulary*, not about the application. A checkout written as `PurchaseFlow`
 * answers to neither "checkout" nor "flow", and a reply that reports that as
 * "nothing found" has told a model the feature does not exist.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type McpSession } from './helpers/mcp-server.js';

const BASE = Date.UTC(2026, 8, 1, 12, 0);

let home: string;
let server: McpSession;

const call = (name: string, args: Record<string, unknown>): Promise<string> =>
  server.call(name, args);

/**
 * A recording the graph can learn a shape from: a component that calls an
 * endpoint, in a file, inside a named flow.
 *
 * The names are chosen so the two halves of the feature can be told apart. The
 * *endpoint* is `/api/v1/invoices` and carries no cart word at all, so it can
 * only be reached through the edge from `CartBadge` — which is the assertion
 * that separates this from a grep.
 */
function flow(id: string) {
  return {
    id,
    schemaVersion: 1,
    name: `Checkout ${id}`,
    timestamp: BASE,
    startUrl: 'https://shop.example.com/cart',
    react: {
      detected: true,
      components: {
        cmp_badge: { name: 'CartBadge', status: 'resolved', source: 'src/cart/CartBadge.tsx', line: 12 },
        cmp_total: { name: 'PurchaseSummary', status: 'resolved', source: 'src/checkout/Total.tsx', line: 30 },
      },
    },
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/cart',
        timestamp: BASE + 1000,
        action: 'Clicked "Add to cart"',
        stepNumber: 1,
        element: {
          tag: 'button',
          cssSelector: '#add',
          react: { owner: 'cmp_badge', chain: ['cmp_badge'] },
        },
        networkCalls: [
          {
            method: 'GET',
            url: 'https://api.example.com/api/v1/invoices',
            status: 200,
            durationMs: 30,
          },
        ],
        consoleLogs: [],
      },
    ],
  };
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-navigator-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  server = await startServer({ home });
  // POSTed rather than written to disk: the graph is built by ingestion, and a
  // `flow.json` dropped in the directory never reaches it.
  expect(await server.post('/flows', JSON.stringify(flow('flow-nav')))).toMatchObject({ status: 200 });
}, 30_000);

afterAll(() => {
  server?.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('what a description points at', () => {
  it('is declared, not merely answerable', async () => {
    // A switch case answers a call whether or not anything advertised the name.
    const listed = await server.tools();
    expect(listed).toContain('explain_feature');
  });

  it('finds a component by a word in its name, and says that is why', async () => {
    const answer = await call('explain_feature', { description: 'cart badge' });

    expect(answer).toContain('CartBadge');
    // The reason, in words. `0.72` cannot be argued with; this can.
    expect(answer).toMatch(/name-(exact|word)/);
    expect(answer).toContain('Searched for: cart, badge');
  });

  it('reaches an endpoint that never carried the word, through the graph', async () => {
    const answer = await call('explain_feature', { description: 'cart' });

    /*
     * The assertion that separates this tool from a grep. `/api/v1/invoices`
     * contains neither "cart" nor anything like it; it is in the answer only
     * because a recording saw `CartBadge` call it, which is an edge and not a
     * string.
     */
    expect(answer).toContain('connected to, from what has been observed');
    expect(answer).toContain('/api/v1/invoices');
  });

  it('says it is matching names, at the top rather than in a footnote', async () => {
    const answer = await call('explain_feature', { description: 'cart' });

    expect(answer).toContain('DevFlow does not know what your description means');
    expect(answer).toContain('a part of the app that uses different words is not here at all');
  });

  it('reports the words it ignored, so "too vague" is distinguishable', async () => {
    const answer = await call('explain_feature', { description: 'how does the cart page work' });

    /*
     * "Your words narrowed nothing" and "this app has nothing by that name" are
     * different answers. The dropped list is the only thing that separates them
     * for a caller who wrote a sentence of ordinary English.
     */
    expect(answer).toContain('Ignored as too common to narrow anything');
    expect(answer).toContain('Searched for: cart');
  });

  it('refuses a description with nothing in it to search on', async () => {
    const answer = await call('explain_feature', { description: 'how does this page work' });

    expect(answer).toContain('too common to search on');
    expect(answer).not.toContain('Nothing in the graph carries those words');
  });

  it('calls an empty answer a vocabulary miss, not a missing feature', async () => {
    const answer = await call('explain_feature', { description: 'telemetry pipeline' });

    expect(answer).toContain('Nothing in the graph carries those words');
    /*
     * The claim this must never make. The app under test has a checkout — it is
     * called `PurchaseSummary` — and a tool that reported a vocabulary miss as
     * an absent feature would have a model conclude the code is not there.
     */
    expect(answer).toContain('That is a statement about vocabulary, not about the application');
  });

  it('finds a component by its path when its name says nothing', async () => {
    const answer = await call('explain_feature', { description: 'checkout' });

    // `PurchaseSummary` is the checkout and does not say so; `src/checkout/`
    // does. Reported on a text basis, which ranks below a name and says so.
    expect(answer).toContain('PurchaseSummary');
    expect(answer).toContain('text-word');
  });
});
