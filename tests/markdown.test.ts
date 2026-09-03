import { describe, expect, it } from 'vitest';
import { exportToMarkdown, flowHost, urlPath } from '../src/core/export/markdown.js';
import { CAPPED_ID } from '../src/core/react/table.js';
import type { ComponentSource, FlowReact, NetworkCall, Step } from '../src/shared/types.js';
import { pos0, pos1 } from '../src/core/locate/positions.js';

const click = (over: Partial<Step> = {}): Step =>
  ({
    type: 'click',
    url: 'https://app.example.com/orders',
    timestamp: 1_000,
    action: 'Clicked "Save"',
    element: {
      tag: 'button',
      cssSelector: '#save',
      xpath: '/html[1]/body[1]/button[1]',
      boundingBox: null,
    },
    ...over,
  }) as Step;

describe('urlPath', () => {
  it('keeps the path and query, drops the origin', () => {
    expect(urlPath('https://example.com/a/b?x=1')).toBe('/a/b?x=1');
  });

  it('returns the input unchanged when it is not a URL', () => {
    expect(urlPath('not a url')).toBe('not a url');
    expect(urlPath(undefined)).toBe('');
  });
});

describe('flowHost', () => {
  it('takes the host of the first parseable URL', () => {
    const steps = [click({ url: 'nonsense' }), click({ url: 'https://a.example.com/x' })];
    expect(flowHost(steps)).toBe('a.example.com');
  });

  it('is empty when nothing parses', () => {
    expect(flowHost([click({ url: 'nope' })])).toBe('');
  });
});

describe('exportToMarkdown', () => {
  it('numbers steps and titles the document', () => {
    const md = exportToMarkdown([click(), click({ action: 'Clicked "Cancel"' })], {
      title: 'Checkout',
    });
    expect(md).toContain('# Checkout');
    expect(md).toContain('### 1. Clicked "Save"');
    expect(md).toContain('### 2. Clicked "Cancel"');
    expect(md).toContain('2 steps');
  });

  it('marks a page change once, not on every step of the same page', () => {
    const md = exportToMarkdown([
      click(),
      click(),
      click({ url: 'https://app.example.com/checkout' }),
    ]);
    // Count markers at the start of a line — the legend mentions 📍 too.
    const markers = md.split('\n').filter((line) => line.startsWith('📍'));
    expect(markers).toEqual(['📍 /orders', '📍 /checkout']);
  });

  it('includes a stable selector and omits a brittle one', () => {
    const stable = exportToMarkdown([click()]);
    expect(stable).toContain('`#save`');

    const brittle = exportToMarkdown([
      click({
        element: {
          tag: 'button',
          cssSelector: 'div.wrap > div.row > button:nth-of-type(2)',
          xpath: '/x',
          boundingBox: null,
        },
      }),
    ]);
    expect(brittle).not.toContain('nth-of-type');
  });

  it('references image files rather than base64 when given filenames', () => {
    const md = exportToMarkdown([click({ screenshot: 'data:image/jpeg;base64,AAAA' })], {
      images: { kind: 'file', names: ['images/step-01.jpg'] },
    });
    expect(md).toContain('![1](images/step-01.jpg)');
    expect(md).not.toContain('base64,AAAA');
  });

  it('omits images entirely when asked to', () => {
    const md = exportToMarkdown([click({ screenshot: 'data:image/jpeg;base64,AAAA' })], {
      images: false,
    });
    expect(md).not.toContain('![1]');
  });

  it('keeps only errors and warnings from the console', () => {
    const md = exportToMarkdown([
      click({
        consoleLogs: [
          { level: 'log', args: ['chatter'], timestamp: 1 },
          { level: 'error', args: ['Boom'], timestamp: 2 },
          { level: 'warn', args: ['Careful'], timestamp: 3 },
        ],
      }),
    ]);
    expect(md).toContain('Boom');
    expect(md).toContain('Careful');
    expect(md).not.toContain('chatter');
  });

  it('drops network and console sections when excluded', () => {
    const step = click({
      networkCalls: [
        {
          method: 'POST',
          url: 'https://api.example.com/v2/submit',
          requestHeaders: {},
          requestBody: null,
          status: 201,
          responseHeaders: {},
          responseBody: null,
          durationMs: 12,
          timestamp: 1,
        },
      ],
      consoleLogs: [{ level: 'error', args: ['Boom'], timestamp: 1 }],
    });

    const full = exportToMarkdown([step]);
    expect(full).toContain('/v2/submit');
    expect(full).toContain('Boom');

    const stripped = exportToMarkdown([step], { network: false, logs: false });
    expect(stripped).not.toContain('/v2/submit');
    expect(stripped).not.toContain('Boom');
  });

  it('renders notes as a blockquote', () => {
    const md = exportToMarkdown([click({ notes: 'first\nsecond' })]);
    expect(md).toContain('> first\n> second');
  });
});

/**
 * The trace id in the walkthrough, and the decision that keeps it off most
 * lines.
 *
 * The id is only worth anything if a renderer prints it — a field nobody can
 * see from outside is a change to somebody's outbound traffic in exchange for
 * nothing. But it is 32 hex characters, and this document is the one that is
 * budgeted, so printing it beside every healthy call would cost a long
 * recording thousands of tokens of identifier nobody asked for.
 *
 * So the walkthrough prints it on a *failed* call only. Both halves are
 * asserted, because the second one is a decision: with only the positive test,
 * a later edit that prints it everywhere passes, and the negative case reads as
 * an omission nobody meant.
 */
describe('exportToMarkdown · trace ids', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

  const called = (over: Partial<NetworkCall>): Step =>
    click({
      networkCalls: [
        {
          method: 'POST',
          url: 'https://api.example.com/v1/orders',
          requestHeaders: {},
          requestBody: null,
          status: 200,
          responseHeaders: {},
          responseBody: null,
          durationMs: 12,
          timestamp: 1,
          ...over,
        },
      ],
    });

  it('prints the id on a call that failed', () => {
    const md = exportToMarkdown([called({ status: 500, traceId: TRACE })]);
    expect(md).toContain(TRACE);
  });

  it('prints the id on a call that never landed', () => {
    const md = exportToMarkdown([called({ status: null, traceId: TRACE })]);
    expect(md).toContain(TRACE);
  });

  it('leaves it off a healthy call, deliberately', () => {
    const md = exportToMarkdown([called({ status: 200, traceId: TRACE })]);
    expect(md).toContain('/v1/orders');
    expect(md).not.toContain(TRACE);
  });

  it('says nothing about a trace on a call that carried no header', () => {
    const md = exportToMarkdown([called({ status: 500 })]);
    expect(md).toContain('/v1/orders');
    expect(md).not.toContain('trace');
  });
});

describe('exportToMarkdown · React components', () => {
  const chained = (chain: string[]) =>
    click({
      element: {
        tag: 'button',
        cssSelector: '#save',
        xpath: '/html[1]/body[1]/button[1]',
        boundingBox: null,
        react: { chain },
      },
    });

  const react = (components: Record<string, ComponentSource>): FlowReact => ({
    detected: true,
    build: 'production',
    components,
  });

  it('says nothing at all when the flow carries no React block', () => {
    const md = exportToMarkdown([chained(['cart'])]);
    expect(md).not.toContain('⚛');
    expect(md).not.toContain('React components');
  });

  it('names the owning component on the step and its path only in the table', () => {
    const md = exportToMarkdown([chained(['app', 'cart'])], {
      react: react({
        app: { name: 'App', status: 'resolved', source: 'src/App.tsx', line: pos1(1) },
        cart: { name: 'AddToCartButton', status: 'resolved', source: 'src/Cart.tsx', line: pos1(34) },
      }),
    });

    expect(md).toContain('⚛ AddToCartButton');
    // The path is written down once, in the table — not on the step.
    expect(md.split('src/Cart.tsx:34')).toHaveLength(2);
    expect(md).toContain('| AddToCartButton | src/Cart.tsx:34 |');
    expect(md).toContain('| App | src/App.tsx:1 |');
  });

  it('names the feature component behind a shared primitive, beside it', () => {
    // Clicking Continue lands in `Button`, correctly and uselessly. What makes
    // the step legible is the CheckoutButton that rendered it.
    const md = exportToMarkdown([chained(['checkout', 'button'])], {
      react: react({
        checkout: {
          name: 'CheckoutButton',
          status: 'resolved',
          source: 'src/components/checkout/CheckoutButton.tsx',
          line: pos1(42),
        },
        button: {
          name: 'Button',
          status: 'resolved',
          source: 'src/components/ui/Button.tsx',
          line: pos1(8),
        },
      }),
    });

    expect(md).toContain('⚛ Button · in CheckoutButton');
    // Both are in the table, so both files can be opened.
    expect(md).toContain('| CheckoutButton | src/components/checkout/CheckoutButton.tsx:42 |');
  });

  it('adds nothing when the owner is already the feature component', () => {
    const md = exportToMarkdown([chained(['app', 'cart'])], {
      react: react({
        app: { name: 'App', status: 'resolved', source: 'src/App.tsx', line: pos1(1) },
        cart: { name: 'AddToCartButton', status: 'resolved', source: 'src/Cart.tsx', line: pos1(34) },
      }),
    });

    expect(md).toContain('⚛ AddToCartButton');
    expect(md).not.toContain('· in');
  });

  /*
   * The Notes cell names the build stamp, and nothing else.
   *
   * `get_flow` is the primary tool and this table is what it returns; it is
   * also what `flow.md` holds on disk and what the extension's Markdown and ZIP
   * exports write. A stamped component has no `detail`, so before this the cell
   * was empty and a model reading `| Cart | src/Cart.tsx:12 | |` could not tell
   * that the answer came out of a build step in the recorded application.
   * `ROADMAP_AND_PHASES.md` §1.1 rule 3.
   *
   * The negative row carries `via: 'bundle-search'` on purpose. A row with no
   * `via` at all reads identically under this rule and under one that labels
   * every path, and would prove nothing about either.
   */
  it('names the build stamp in the table, and only for the build stamp', () => {
    const md = exportToMarkdown([chained(['stamped', 'searched'])], {
      react: react({
        stamped: {
          name: 'Cart',
          status: 'resolved',
          via: 'plugin',
          source: 'src/Cart.tsx',
          line: pos1(12),
        },
        searched: {
          name: 'App',
          status: 'resolved',
          via: 'bundle-search',
          source: 'src/App.tsx',
          line: pos1(1),
        },
      }),
    });

    expect(md).toContain('| Cart | src/Cart.tsx:12 | build stamp |');
    expect(md).toContain('| App | src/App.tsx:1 |  |');
    expect(md).not.toContain('bundle search');
  });

  it('keeps the row’s own sentence beside the provenance', () => {
    const md = exportToMarkdown([chained(['stamped'])], {
      react: react({
        stamped: {
          name: 'Cart',
          status: 'resolved',
          via: 'plugin',
          source: 'src/Cart.tsx',
          line: pos1(12),
          detail: 'Something worth saying.',
        },
      }),
    });

    expect(md).toContain('| Cart | src/Cart.tsx:12 | build stamp · Something worth saying. |');
  });

  it('gives a component with nowhere to point a row and a reason', () => {
    const md = exportToMarkdown([chained(['lazy'])], {
      react: react({
        lazy: { name: 'LazyModal', status: 'not-found', detail: 'Its chunk was never loaded.' },
      }),
    });

    expect(md).toContain('| LazyModal | — | Its chunk was never loaded. |');
  });

  it('reports a compiled position when the bundle ships no source map', () => {
    const md = exportToMarkdown([chained(['tag'])], {
      react: react({
        tag: {
          name: 'PriceTag',
          status: 'compiled-only',
          compiled: { url: 'https://cdn.example.com/assets/main.js', line: pos0(1), column: pos0(88_214) },
          detail: 'no source map',
        },
      }),
    });

    // `compiled` is stored `Pos0` for DevTools' Sources API; a reader counts from one.
    expect(md).toContain('| PriceTag | /assets/main.js:2:88215 | no source map |');
  });

  it('notes the cap below the table instead of listing it as a component', () => {
    const md = exportToMarkdown([chained(['cart'])], {
      react: react({
        cart: { name: 'Cart', status: 'resolved', source: 'src/Cart.tsx', line: pos1(3) },
        [CAPPED_ID]: { name: 'Component cap', status: 'skipped', detail: 'More than 128 components.' },
      }),
    });

    expect(md).toContain('> More than 128 components.');
    expect(md).not.toContain('| Component cap |');
  });

  it('leaves out the table when the surviving steps reference nothing', () => {
    const md = exportToMarkdown([click()], {
      react: react({ cart: { name: 'Cart', status: 'resolved', source: 'src/Cart.tsx' } }),
    });

    expect(md).not.toContain('React components');
  });
});
