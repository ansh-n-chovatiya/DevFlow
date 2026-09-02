/**
 * A trace id nobody prints does not exist.
 *
 * `NetworkCall.traceId` is written by the page agent, carried by the content
 * script and stored in `flow.json` — and every one of those is invisible from
 * outside the recording. Its whole Tier 1 payoff is that it is the same id the
 * user's own backend logged, so a person or a model can go and grep for it;
 * that payoff is worth exactly as much as the renderers that put it on a screen
 * or in a tool response. This repo has been bitten by that gap before, by a
 * field written to hold where a model reads a component and then held in one of
 * three places.
 *
 * So these are the three surfaces where the id is actionable, each tested
 * through the thing a reader actually meets:
 *
 *   - the flow review's own call panel, against the real `viewer.html` markup,
 *     because `buildCall` is a closure inside `mountReview` and the only honest
 *     way to reach it is to mount the screen;
 *   - `get_step_detail` and `get_flow_errors`, against a spawned server over
 *     the real transport, for the reason in `tests/helpers/mcp-server.ts` — the
 *     server has no typecheck over it and builds its failed-call objects field
 *     by field, which is precisely how a new field goes missing in silence.
 *
 * The walkthrough's half of the story — printed on a failed call, deliberately
 * not on a healthy one — is in `tests/markdown.test.ts`, beside the renderer.
 *
 * ## Why the window is built by hand rather than by the file environment
 *
 * Under the jsdom environment `import.meta.url` is an `http:` URL, and
 * `tests/helpers/mcp-server.ts` resolves the server's path from its own — so
 * the one-line directive that would serve the review's tests breaks the
 * server's before a single one runs. And the directive cannot even be *named*
 * in a comment here: vitest greps the whole file for it, so writing it down to
 * explain its absence turns it on. A window made by hand costs a dozen lines
 * and leaves both halves in one file, which is where they belong — they are one
 * claim about one field.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkCall, Step } from '../src/shared/types.js';
import { describeTrace } from '../src/core/trace/index.js';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

/**
 * `jsdom` through `createRequire`, because it ships no types and this repo has
 * no `@types/jsdom` — a bare `import` is `TS7016` under `tsconfig.node.json`,
 * and adding a dependency to render one call panel is the wrong trade. The
 * shape below is everything this file asks of it.
 */
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (
    html: string,
    options?: { url?: string },
  ) => { window: Record<string, unknown> & { document: Document } };
};

/** 32 lowercase hex, as `isTraceId` demands and the injector mints. */
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const OTHER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const NOW = Date.UTC(2026, 7, 24, 9, 30);

const call = (over: Partial<NetworkCall> = {}): NetworkCall =>
  ({
    method: 'POST',
    url: 'https://api.example.com/v1/orders',
    requestHeaders: { 'content-type': 'application/json' },
    requestBody: '{"cartId":"c-1"}',
    status: 500,
    responseHeaders: {},
    responseBody: '{"error":"totals missing"}',
    durationMs: 240,
    timestamp: NOW + 6,
    ...over,
  });

// ── The flow review ──────────────────────────────────────────────────────

/**
 * The viewer's controllers are mounted against the real document, so everything
 * they reach for on the way — storage, the flow store, the worker, settings —
 * has to answer without a browser. None of it is what these tests are about.
 */
vi.mock('../src/chrome/storage.js', () => ({
  getLocal: () => Promise.resolve({ ok: true as const, value: {} }),
  setLocal: () => Promise.resolve({ ok: true as const, value: undefined }),
  getSync: () => Promise.resolve({ ok: true as const, value: {} }),
  setSync: () => Promise.resolve({ ok: true as const, value: undefined }),
}));

vi.mock('../src/features/flows/store.js', () => ({
  deleteFlow: () => Promise.resolve({ ok: true as const, value: undefined }),
  renameFlow: () => Promise.resolve({ ok: true as const, value: undefined }),
}));

vi.mock('../src/shared/messages.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendToWorker: () => Promise.resolve({ ok: true as const, value: undefined }),
}));

vi.mock('../src/ui/toast.js', () => ({ showToast: () => {} }));

describe('the flow review prints the trace id on a call', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const html = readFileSync(resolve(root, 'src/viewer.html'), 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';

  /**
   * The globals the viewer's modules reach for. Everything the controllers
   * touch comes off one window, so the list is the window's own names rather
   * than a guess per module.
   */
  const GLOBALS = [
    'window',
    'document',
    'navigator',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'Node',
    'Element',
    'DocumentFragment',
    'Event',
    'CustomEvent',
    'MouseEvent',
    'KeyboardEvent',
    'ClipboardEvent',
    'DataTransfer',
    'FileReader',
    'File',
    'Blob',
    'HTMLElement',
    'HTMLTemplateElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLImageElement',
    'HTMLDialogElement',
  ] as const;

  afterEach(() => vi.unstubAllGlobals());

  /** One step, one network call, painted through the real controller. */
  async function paintCall(network: NetworkCall): Promise<HTMLElement> {
    const jsdom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
      url: 'https://viewer.test/',
    });
    for (const name of GLOBALS) vi.stubGlobal(name, jsdom.window[name]);
    const document = jsdom.window.document;

    vi.resetModules();
    const { mountReview } = await import('../src/ui/viewer/review.js');

    const step = {
      type: 'click',
      url: 'https://shop.example.com/cart',
      timestamp: NOW,
      action: 'Clicked "Place order"',
      element: { tag: 'button', cssSelector: '#place-order', xpath: '/html/body/button', boundingBox: null },
      networkCalls: [network],
    } as unknown as Step;

    const app = {
      state: {
        route: { name: 'review', id: 'flow-1' },
        flows: null,
        current: null,
        usedBytes: null,
        query: '',
        sort: 'newest',
        flow: {
          id: 'flow-1',
          name: 'Checkout breaks',
          steps: [step],
          createdAt: NOW,
          react: null,
        },
        missing: false,
        filter: 'all',
        activeIndex: null,
        undo: [],
        editor: null,
      },
      navigate: () => {},
      paint: () => {},
      reload: () => Promise.resolve(),
      commit: () => Promise.resolve(),
    } as unknown as Parameters<typeof mountReview>[0];

    mountReview(app, () => {}).paint();

    /*
     * The network disclosure builds its rows the first time it opens — see
     * `buildDetailBody` — so a test that only paints reads an empty container
     * and passes against a renderer that prints nothing at all.
     */
    const details = document.querySelector<HTMLDetailsElement>('.detail--network');
    if (!details) throw new Error('the step card has no network disclosure');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));

    /*
     * `[data-active]` is what tells the built panel from the placeholder.
     * `tpl-call` ships two empty `.call__panel` divs already carrying
     * `data-panel`, and `buildCall` appends its own two after them — so a plain
     * `.call__panel[data-panel="request"]` finds the empty one in the markup
     * and passes against a renderer that prints nothing. Only the built pair is
     * given `data-active`, by the tab wiring.
     */
    const panel = details.querySelector<HTMLElement>(
      '.call__panel[data-panel="request"][data-active]',
    );
    if (!panel) throw new Error('the call has no request panel');
    return panel;
  }

  it('says what the id is for, in the request panel', async () => {
    const panel = await paintCall(call({ traceId: TRACE }));

    expect(panel.textContent).toContain(TRACE);
    // The sentence, not a second account of the same idea invented here.
    expect(panel.textContent).toContain(describeTrace(TRACE));
  });

  it('shows it on a healthy call too — there is no token budget on a screen', async () => {
    const panel = await paintCall(call({ status: 200, traceId: OTHER }));
    expect(panel.textContent).toContain(OTHER);
  });

  it('says nothing about a trace on a call that carried no header', async () => {
    const panel = await paintCall(call());

    expect(panel.textContent).not.toContain('Trace');
    expect(panel.textContent).not.toContain('trace');
  });

  it('still prints the id when the call captured nothing else', async () => {
    // The panel's own "Nothing captured." branch is an early return, and a
    // traced call with no headers and no body would have gone down it.
    const panel = await paintCall(call({ requestHeaders: {}, requestBody: null, traceId: TRACE }));

    expect(panel.textContent).toContain(TRACE);
    expect(panel.textContent).not.toContain('Nothing captured.');
  });
});

// ── The MCP server ───────────────────────────────────────────────────────

describe('the MCP server hands the trace id to the model', () => {
  let home: string;
  let server: McpSession;

  beforeAll(async () => {
    server = await startServer();
    home = server.home;

    writeFlow(home, {
      id: 'flow-traced',
      name: 'Checkout breaks',
      timestamp: NOW,
      startUrl: 'https://shop.example.com/cart',
      errorCount: 1,
      schemaVersion: 1,
      steps: [
        {
          type: 'click',
          url: 'https://shop.example.com/cart',
          timestamp: NOW,
          action: 'Clicked "Place order"',
          stepNumber: 1,
          element: { tag: 'button', cssSelector: '#place-order' },
          consoleLogs: [],
          networkCalls: [
            // Healthy, and traced: `get_step_detail` prints it, and
            // `get_flow_errors` never sees this call at all.
            call({ url: 'https://api.example.com/v1/cart', status: 200, traceId: OTHER }),
            // Failed, and traced: the case both tools exist for.
            call({ traceId: TRACE }),
            // Failed and untraced — almost every call there is.
            call({ url: 'https://api.example.com/v1/ping', status: 503 }),
          ],
        },
      ],
    });

    // The ordinary recording — tracing is off by default, so this is what
    // almost every flow on disk looks like.
    writeFlow(home, {
      id: 'flow-untraced',
      name: 'Checkout breaks, untraced',
      timestamp: NOW,
      startUrl: 'https://shop.example.com/cart',
      errorCount: 1,
      schemaVersion: 1,
      steps: [
        {
          type: 'click',
          url: 'https://shop.example.com/cart',
          timestamp: NOW,
          action: 'Clicked "Place order"',
          stepNumber: 1,
          element: { tag: 'button', cssSelector: '#place-order' },
          consoleLogs: [],
          networkCalls: [call({ url: 'https://api.example.com/v1/ping', status: 503 })],
        },
      ],
    });
  }, 30_000);

  afterAll(() => server?.stop());

  beforeEach(() => {
    expect(server.stderr()).not.toContain('TypeError');
  });

  it('get_flow_errors carries it on the failed call', async () => {
    const text = await server.call('get_flow_errors', { id: 'flow-traced' });
    const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? '[]') as {
      failedCalls: { url: string; traceId?: string }[];
    }[];

    const failed = json[0].failedCalls;
    expect(failed).toHaveLength(2);

    const traced = failed.find((entry) => entry.url.endsWith('/v1/orders'));
    expect(traced?.traceId).toBe(TRACE);

    /*
     * Absent, never null. "Not traced" and "traced with nothing" are different
     * facts and only the first ever happens, so a `null` here would be a claim
     * the recording never made — and a reader would go looking for an id that
     * was never minted.
     */
    const untraced = failed.find((entry) => entry.url.endsWith('/v1/ping'));
    expect(untraced).toBeDefined();
    expect(untraced).not.toHaveProperty('traceId');
  });

  /*
   * The sentence that turns an opaque hex string into an action, said once for
   * the whole response rather than once per call.
   *
   * Without it a model reading this JSON has been handed the entire Tier 1
   * payoff — the id its user's own backend logged — and told nothing about what
   * to do with it. With it per call, the same forty tokens repeat down a
   * response this tool exists to keep small.
   */
  it('get_flow_errors says once what a trace id is for', async () => {
    const text = await server.call('get_flow_errors', { id: 'flow-traced' });

    const prose = text.split('```json')[0];
    expect(prose).toContain('search your backend logs');
    // Once, not once per traced call.
    expect(prose.split('search your backend logs').length - 1).toBe(1);
  });

  it('says nothing of the sort when no call was traced', async () => {
    // The ordinary response — tracing is off by default — pays nothing for the
    // line above.
    const text = await server.call('get_flow_errors', { id: 'flow-untraced' });
    expect(text.split('```json')[0]).not.toContain('search your backend logs');
  });

  it('get_step_detail prints it on the call line', async () => {
    const text = await server.call('get_step_detail', {
      id: 'flow-traced',
      step: 1,
      include: ['network'],
    });

    // On the line that names the call, not in a section of its own: the reader
    // is matching an id to a request, and a list of ids elsewhere would not.
    const line = text.split('\n').find((row) => row.includes('/v1/orders'));
    expect(line).toContain(TRACE);

    const healthy = text.split('\n').find((row) => row.includes('/v1/cart'));
    expect(healthy).toContain(OTHER);

    const untraced = text.split('\n').find((row) => row.includes('/v1/ping'));
    expect(untraced).not.toContain('trace');
  });
});
