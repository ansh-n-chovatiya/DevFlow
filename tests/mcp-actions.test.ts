/**
 * `suggest_actions`, against the real server and real recordings on disk.
 *
 * The roadmap calls the thing behind this a *synthetic* action generator, and
 * the v3.2.0 version earned the word by inventing: it returned hardcoded
 * buttons and took an ARKG argument it never read. What ships invents nothing,
 * and the two assertions that matter here are about that rather than about the
 * folding:
 *
 *  1. **Every action offered was performed and recorded.** An action that
 *     appears in the reply and in none of the fixtures is the old bug back,
 *     and it is the one failure that looks like the feature working better.
 *  2. **The reply says so.** A tool that quietly stopped saying "nothing here
 *     is invented" would read as a generator, and a model reading it would
 *     believe the list was exhaustive of what the page can do.
 *
 * The third, quieter one: the skip counts. "This page has no recorded actions"
 * and "you filtered them all out" are different answers and an empty list says
 * neither.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

const BASE = Date.UTC(2026, 8, 1, 13, 0);

let home: string;
let server: McpSession;

const call = (name: string, args: Record<string, unknown>): Promise<string> =>
  server.call(name, args);

/**
 * Two recordings of one page, so the fold has something to fold.
 *
 * Both click Add to cart — on URLs that differ only by a query string, which is
 * the same page and must not become two actions — and only one types into the
 * promo field. The note step and the navigation are there to be skipped with a
 * reason rather than dropped in silence.
 */
function cartFlow(id: string, query: string) {
  return {
    id,
    schemaVersion: 1,
    name: `Cart ${id}`,
    timestamp: BASE,
    startUrl: `https://shop.example.com/cart${query}`,
    react: { detected: true, components: { cmp_cart: { name: 'CartPanel', status: 'resolved' } } },
    steps: [
      {
        type: 'navigate',
        url: `https://shop.example.com/cart${query}`,
        timestamp: BASE,
        action: 'Opened the cart',
        title: 'Cart',
        stepNumber: 1,
      },
      {
        type: 'click',
        url: `https://shop.example.com/cart${query}`,
        timestamp: BASE + 1000,
        action: 'Clicked "Add to cart"',
        stepNumber: 2,
        element: {
          tag: 'button',
          text: 'Add to cart',
          ariaLabel: 'Add to cart',
          cssSelector: '#add',
          xpath: '//button',
          boundingBox: null,
          react: { chain: ['cmp_cart'], owner: 'cmp_cart' },
        },
      },
      {
        type: 'input',
        url: `https://shop.example.com/cart${query}`,
        timestamp: BASE + 2000,
        action: 'Typed into Promo code',
        stepNumber: 3,
        value: 'SAVE10',
        element: {
          tag: 'input',
          label: 'Promo code',
          ariaLabel: 'Promo code',
          cssSelector: '#promo',
          xpath: '//input',
          boundingBox: null,
        },
      },
      {
        type: 'note',
        url: `https://shop.example.com/cart${query}`,
        timestamp: BASE + 3000,
        action: 'Recording stopped',
        stepNumber: 4,
        value: 'Step limit reached',
      },
    ],
  };
}

/** A different page, so the URL filter has something to exclude. */
function otherFlow() {
  return {
    id: 'flow-other',
    schemaVersion: 1,
    name: 'Account',
    timestamp: BASE,
    startUrl: 'https://shop.example.com/account',
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/account',
        timestamp: BASE + 1000,
        action: 'Clicked "Sign out"',
        stepNumber: 1,
        element: {
          tag: 'button',
          text: 'Sign out',
          ariaLabel: 'Sign out',
          cssSelector: '#signout',
          xpath: '//button',
          boundingBox: null,
        },
      },
    ],
  };
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-actions-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  server = await startServer({ home });
  writeFlow(home, cartFlow('flow-cart-a', ''));
  writeFlow(home, cartFlow('flow-cart-b', '?page=2'));
  writeFlow(home, otherFlow());
}, 30_000);

afterAll(() => {
  server?.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('what has been done on a page', () => {
  it('is declared, not merely answerable', async () => {
    const listed = await server.tools();
    expect(listed).toContain('suggest_actions');
  });

  it('folds one action across recordings and says how many it stands for', async () => {
    const answer = await call('suggest_actions', { url: 'https://shop.example.com/cart' });

    expect(answer).toContain('Add to cart');
    /*
     * Two recordings, one action, and the URLs differ only by `?page=2` —
     * a query string that split one page into two would make every fold on a
     * paginated app fail, quietly, in the direction of more results.
     */
    expect(answer).toContain('seen 2×');
    expect(answer).toContain('flow-cart-a, flow-cart-b');
  });

  it('carries the value that was actually typed, not one it invented', async () => {
    const answer = await call('suggest_actions', { url: 'https://shop.example.com/cart' });

    expect(answer).toContain('Promo code');
    expect(answer).toContain('"SAVE10"');
    // The old failure looked exactly like the feature working better.
    expect(answer).not.toContain('test@example.com');
  });

  it('offers nothing that was not recorded', async () => {
    const answer = await call('suggest_actions', { url: 'https://shop.example.com/cart' });

    // The cart page has no Sign out button; the account page's must not leak
    // into it, and neither must anything from an app the fixtures never had.
    expect(answer).not.toContain('Sign out');
    expect(answer).not.toContain('Submit');
  });

  it('says nothing in it is invented, every time', async () => {
    const answer = await call('suggest_actions', { url: 'https://shop.example.com/cart' });

    expect(answer).toContain('Nothing here is invented');
    expect(answer).toContain('a control nobody has ever touched is not here');
  });

  it('filters by component as well as by page', async () => {
    const answer = await call('suggest_actions', { component: 'cmp_cart' });

    expect(answer).toContain('Add to cart');
    // The promo field is on the same page and is not attributed to that
    // component, so a component filter that widened to the page would keep it.
    expect(answer).not.toContain('Promo code');
  });

  it('counts what it did not offer, so an empty list is not two answers at once', async () => {
    const answer = await call('suggest_actions', { url: 'https://shop.example.com/nowhere' });

    expect(answer).toContain('No recorded action matches');
    /*
     * "This page has no recorded actions" and "you filtered them all out" read
     * identically as an empty list, and only the skip counts separate them.
     */
    expect(answer).toContain('What was there and did not qualify');
    expect(answer).toMatch(/\d+ steps?\s+/);
  });

  it('says how much of the library it read', async () => {
    const answer = await call('suggest_actions', {});
    // A tool that answers out of the three most recent recordings and implies
    // it read the library has given the one wrong answer available to it.
    expect(answer).toMatch(/Read from the \d+ most recent recording/);
  });
});
