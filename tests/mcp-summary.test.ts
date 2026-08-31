/**
 * `get_flow_summary` against the real server, over the real transport.
 *
 * This tool's whole value is a number: under 400 estimated tokens, so asking it
 * of the wrong recording costs nothing and a reader can triage five flows for
 * less than one `get_flow`. A budget that holds on the fixtures somebody wrote
 * it against and not on a real recording is worse than no budget at all — the
 * caller has already been told this call is cheap.
 *
 * So the flow below is built to break it: a name well past the truncation
 * point, four hundred steps, thirty distinct failure shapes, two dozen
 * components with long paths, and a settings stamp with something to say about
 * six different keys. Every one of those feeds a line `flowSummary` assembles,
 * and each of them is the line that would push the response over.
 *
 * The second thing under test is the verdict. `countFailures` honestly reports
 * zero on a recording sent without its network data, and "nothing failed" is
 * then true of what arrived and false about what happened — the single most
 * misleading answer this server can give to the question this tool exists to
 * answer. `withheld()` is the sentence that refuses to give it, and it has to
 * survive the same budget as everything else.
 *
 * Why a spawned process rather than an import is in `tests/helpers/mcp-server.ts`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

/** The ceiling the tool is named after. `SUMMARY_TOKENS` in `server.js`. */
const SUMMARY_TOKENS = 400;

/** The server's own estimate, so the assertions measure what the budget does. */
const estimateTokens = (value: string) => Math.ceil(value.length / 4);

const DAY = 24 * 60 * 60 * 1000;
/**
 * Fixed and UTC, because the header quotes a date. `day()` is deliberately ISO
 * rather than a locale — this is read on a machine, by a model — so a literal
 * `2026-08-24` in an assertion is the same string in every timezone this runs in.
 */
const BASE = Date.UTC(2026, 7, 20, 9, 30);

let home: string;
let server: McpSession;

const call = (name: string, args: Record<string, unknown>): Promise<string> =>
  server.call(name, args);

/**
 * A component the way the extension writes one down at export time —
 * `flow.react.components`, keyed by the id a step's element refers to.
 */
const component = (name: string, source: string, line: number) => ({
  name,
  status: 'resolved',
  source,
  line,
});

/**
 * Everything at once: a long name, 400 steps, 150 of them failing across 30
 * distinct shapes, 24 components, and six non-default settings.
 *
 * The shapes vary in method, path *and* status, because `failedShapes` keys on
 * all three — thirty variations of one path would collapse to fewer keys and
 * quietly stop testing the line that grows with them.
 */
function writeHostileFlow(): void {
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const statuses = [400, 401, 403, 500, 502, 503];

  const components: Record<string, ReturnType<typeof component>> = {};
  for (let i = 0; i < 24; i++) {
    components[`c-${i}`] = component(
      `CheckoutStepperPanel${i}`,
      `packages/storefront/src/features/checkout/components/CheckoutStepperPanel${i}.tsx`,
      100 + i,
    );
  }

  const steps = Array.from({ length: 400 }, (_, i) => {
    const n = i + 1;
    // Every step from 4 onwards that is not a multiple of 3 stays clean; the
    // rest cycle through all thirty shapes so each one is genuinely distinct.
    const fails = n >= 4 && n % 3 === 1;
    const shape = (n - 4) / 3;
    return {
      type: 'click',
      url: 'https://checkout.staging.internal.example.com/cart/review',
      timestamp: BASE + n * 1000,
      action: `Clicked "Continue ${n}"`,
      stepNumber: n,
      element: {
        tag: 'button',
        cssSelector: `button.continue-${n}`,
        react: { owner: `c-${n % 24}`, within: `c-${(n + 5) % 24}`, chain: [`c-${n % 24}`] },
      },
      consoleLogs: fails
        ? [{ level: 'error', args: [`TypeError: cannot read totals of undefined (${n})`], timestamp: BASE }]
        : [],
      networkCalls: fails
        ? [
            {
              method: methods[shape % methods.length],
              url: `https://api.example.com/v3/checkout/${['orders', 'totals', 'shipping', 'tax', 'promo'][shape % 5]}`,
              requestHeaders: {},
              requestBody: null,
              status: statuses[shape % statuses.length],
              responseHeaders: {},
              responseBody: '{"error":"nope"}',
              durationMs: 40,
              timestamp: BASE,
            },
          ]
        : [],
    };
  });

  writeFlow(home, {
    id: 'flow-hostile',
    name: 'Checkout breaks on the staging storefront when the promotion service is degraded and totals come back empty',
    timestamp: BASE + 3 * DAY,
    startUrl: 'https://checkout.staging.internal.example.com/cart/review',
    errorCount: 150,
    schemaVersion: 1,
    settings: {
      'screenshots.capture': false,
      'network.bodyCap': 1024,
      'network.summariseBodies': false,
      'mcp.maxResponseBody': 120,
      'mcp.maxConsoleEntries': 2,
      'mcp.bodyLimit': 512,
    },
    react: { detected: true, components },
    steps,
  });
}

/** The recording the tool's own description is written about. */
function writePlainFlow(): void {
  const steps = Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    const fails = n % 4 === 0;
    return {
      type: 'click',
      url: 'https://shop.example.com/cart',
      timestamp: BASE + n * 1000,
      action: `Clicked "Place order ${n}"`,
      stepNumber: n,
      element: {
        tag: 'button',
        cssSelector: '#place-order',
        react: fails ? { owner: 'cart-1', within: 'cart-0', chain: ['cart-0', 'cart-1'] } : undefined,
      },
      consoleLogs: [],
      networkCalls: fails
        ? [
            {
              method: 'POST',
              url: 'https://api.example.com/v1/orders',
              requestHeaders: {},
              requestBody: null,
              status: 500,
              responseHeaders: {},
              responseBody: '{"error":"totals missing"}',
              durationMs: 91,
              timestamp: BASE,
            },
          ]
        : [],
    };
  });

  writeFlow(home, {
    id: 'flow-plain',
    name: 'Checkout breaks',
    timestamp: BASE + 4 * DAY,
    startUrl: 'https://shop.example.com/cart',
    errorCount: 5,
    schemaVersion: 1,
    react: {
      detected: true,
      components: {
        'cart-0': component('Cart', 'src/components/Cart.tsx', 10),
        'cart-1': component('CartButton', 'src/components/Cart.tsx', 34),
      },
    },
    steps,
  });
}

/** A recording where the app behaved. */
function writeCleanFlow(): void {
  writeFlow(home, {
    id: 'flow-clean',
    name: 'Signup, happy path',
    timestamp: BASE + DAY,
    startUrl: 'https://shop.example.com/signup',
    errorCount: 0,
    schemaVersion: 1,
    steps: Array.from({ length: 6 }, (_, i) => ({
      type: 'click',
      url: 'https://shop.example.com/signup',
      timestamp: BASE + i * 1000,
      action: `Clicked "Next ${i + 1}"`,
      stepNumber: i + 1,
      element: { tag: 'button', cssSelector: '#next' },
      consoleLogs: [],
      networkCalls: [
        {
          method: 'GET',
          url: 'https://api.example.com/v1/plans',
          requestHeaders: {},
          requestBody: null,
          status: 200,
          responseHeaders: {},
          responseBody: '{"ok":true}',
          durationMs: 12,
          timestamp: BASE,
        },
      ],
    })),
  });
}

/**
 * The recording that broke and cannot say so: sent with the network switch off,
 * so there is nothing on disk for `countFailures` to count.
 */
function writeWithheldFlow(): void {
  writeFlow(home, {
    id: 'flow-withheld',
    name: 'Order 500s',
    timestamp: BASE + 2 * DAY,
    startUrl: 'https://shop.example.com/cart',
    errorCount: 0,
    schemaVersion: 1,
    omitted: ['network'],
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/cart',
        timestamp: BASE,
        action: 'Clicked "Place order"',
        stepNumber: 1,
        element: { tag: 'button', cssSelector: '#place-order' },
        consoleLogs: [],
      },
    ],
  });
}

/** The newest recording on disk, and the only reason it exists. */
function writeNewestFlow(): void {
  writeFlow(home, {
    id: 'flow-newest',
    name: 'Recorded last',
    timestamp: BASE + 9 * DAY,
    startUrl: 'https://shop.example.com/',
    errorCount: 0,
    schemaVersion: 1,
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/',
        timestamp: BASE + 9 * DAY,
        action: 'Clicked "Home"',
        stepNumber: 1,
        element: { tag: 'a', cssSelector: 'a.home' },
        consoleLogs: [],
        networkCalls: [],
      },
    ],
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-test-'));
  writeHostileFlow();
  writePlainFlow();
  writeCleanFlow();
  writeWithheldFlow();
  writeNewestFlow();

  server = await startServer({ home });
}, 20_000);

afterAll(() => {
  server?.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('the budget the tool is named after', () => {
  it('holds on a recording built to break it', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-hostile' });

    expect(estimateTokens(summary)).toBeLessThanOrEqual(SUMMARY_TOKENS);
  });

  it('holds on an ordinary recording', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-plain' });

    expect(estimateTokens(summary)).toBeLessThanOrEqual(SUMMARY_TOKENS);
  });

  it('holds on a recording where nothing failed', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-clean' });

    expect(estimateTokens(summary)).toBeLessThanOrEqual(SUMMARY_TOKENS);
  });

  it('keeps the flow, the verdict and the next call even when it is tight', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-hostile' });

    // What it is: the id, because that is what every follow-up call takes.
    expect(summary).toContain('flow-hostile');
    // The verdict: computed from the steps, not copied from `errorCount`.
    expect(summary).toMatch(/\d+ of 400 steps failed/);
    expect(summary).toContain('distinct failures, commonest');
    // Where to go: a summary that says a recording broke and not how to look at
    // the break has spent a call to save nothing.
    expect(summary).toContain('Next:');
    expect(summary).toContain('get_flow_errors({"id":"flow-hostile"})');
  });

  it('spends what it has on facts rather than stopping mid-sentence', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-hostile' });

    // Dropping whole lines is the design; a response ending in a half-written
    // word is the silent truncation the rest of this server refuses.
    expect(summary.trimEnd().endsWith('recording.')).toBe(true);
    // And it is not so cautious that it says nothing: the budget is a ceiling.
    expect(estimateTokens(summary)).toBeGreaterThan(100);
  });

  /*
   * Without this, the assertions above prove nothing the moment the fixture
   * stops being hostile: a flow whose every line fits keeps the budget by
   * accident, and the test that guards the budget passes whether or not the
   * budget exists. So the fixture is required to have more to say than it can
   * afford, without naming which line goes — that ordering is a judgement in
   * `flowSummary` and belongs to it.
   */
  it('has more facts than it can afford, and drops one rather than all of them', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-hostile' });
    const facts = [
      'Steps that failed:',
      'Failed calls:',
      'Components:',
      'Recorded with non-default settings:',
    ];
    const kept = facts.filter((fact) => summary.includes(fact));

    expect(kept.length).toBeLessThan(facts.length);
    expect(kept.length).toBeGreaterThan(1);
  });
});

describe('what the summary says about a recording that failed', () => {
  it('names the failure, the first step and the component behind it', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-plain' });

    expect(summary).toContain('5 of 20 steps failed');
    expect(summary).toContain('all POST /v1/orders → 500');
    expect(summary).toContain('first at step 4');
    expect(summary).toContain('in CartButton (src/components/Cart.tsx:34)');
  });

  it('heads the answer with the flow, the date, the size and the host', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-plain' });

    expect(summary).toContain('Checkout breaks — flow-plain');
    expect(summary).toContain('2026-08-24 · 20 steps · shop.example.com');
  });

  it('lists the steps that failed and what they failed at', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-plain' });

    expect(summary).toContain('Steps that failed: 4, 8, 12, 16, 20');
    expect(summary).toContain('Failed calls: POST /v1/orders → 500 ×5');
  });

  it('names the components, so "something broke" becomes somewhere to look', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-plain' });

    expect(summary).toContain('Components: CartButton src/components/Cart.tsx:34');
    expect(summary).toContain('Cart src/components/Cart.tsx:10');
  });
});

describe('what the summary says about a recording that did not fail', () => {
  it('says so plainly, and does not invent a failure', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-clean' });

    expect(summary).toContain('Nothing failed');
    expect(summary).toContain('no step logged a console error or a failed request');
    expect(summary).not.toContain('steps failed');
    expect(summary).not.toContain('Failed calls:');
  });

  it('points at the walkthrough rather than at the failures', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-clean' });

    expect(summary).toContain('get_flow({"id":"flow-clean"}) for the walkthrough');
    expect(summary).not.toContain('get_flow_errors');
  });
});

/*
 * The highest-value test in this file.
 *
 * The send dialog defaults to leaving console and network data on the machine,
 * so the recording made specifically to capture a 500 arrives with no
 * `networkCalls` at all. Everything downstream is honest about what it was
 * given and therefore wrong about what happened.
 */
describe('a recording sent without the data that would show a failure', () => {
  it('refuses to report a clean run', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-withheld' });

    expect(summary).not.toContain('Nothing failed');
    expect(summary).toContain('cannot tell whether anything failed');
    expect(summary).toContain('it is not reporting a clean run');
  });

  it('names what was left behind, and how to send it', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-withheld' });

    expect(summary).toContain('was sent without its network calls');
    expect(summary).toContain('Re-send the flow from the DevFlow extension with those switches on');
  });

  it('still fits the budget, warning and all', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-withheld' });

    expect(estimateTokens(summary)).toBeLessThanOrEqual(SUMMARY_TOKENS);
    expect(summary).toContain('Next:');
  });
});

describe('which recording is summarised', () => {
  it('is the most recent one when no id is given', async () => {
    const summary = await call('get_flow_summary', {});

    expect(summary).toContain('Recorded last — flow-newest');
    // The one written before it, and the biggest one on disk, are both older.
    expect(summary).not.toContain('flow-plain');
    expect(summary).not.toContain('flow-hostile');
  });

  it('is the one asked for when an id is given', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-clean' });

    expect(summary).toContain('Signup, happy path — flow-clean');
  });

  it('is refused by name when the id names nothing, pointing at list_flows', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-does-not-exist' });

    expect(summary).toContain('"flow-does-not-exist" not found');
    expect(summary).toContain('list_flows');
  });

  /*
   * The flag, not only the sentence. An MCP client reads `isError` to tell an
   * answer from a refusal, so a refusal sent as a success is a sentence the
   * model treats as a finding — and every assertion on the text alone passes
   * either way.
   */
  it('is refused as an error, not returned as an answer about a flow', async () => {
    const answer = await server.callRaw('get_flow_summary', { id: 'flow-does-not-exist' });

    expect(answer.isError).toBe(true);
  });
});

/**
 * A server with nothing to summarise.
 *
 * Its own process, because the state under test is the empty directory. The
 * answer has to name that directory: "no flows" on a machine where the
 * extension has been sending them all afternoon means the server is reading
 * somewhere else, and the path is the only thing that says so.
 */
describe('a server with no recordings at all', () => {
  let empty: McpSession;

  beforeAll(async () => {
    empty = await startServer();
  }, 20_000);

  afterAll(() => {
    empty?.stop();
    if (empty?.home) fs.rmSync(empty.home, { recursive: true, force: true });
  });

  it('says where it looked instead of reporting a missing flow', async () => {
    const answer = await empty.call('get_flow_summary', {});

    expect(answer).toContain('No flows recorded yet');
    expect(answer).toContain(path.join(empty.home, 'flows'));
    expect(answer).not.toContain('not found');
    expect(answer).toContain('DevFlow Chrome extension');
  });
});
