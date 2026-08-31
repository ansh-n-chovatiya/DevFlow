/**
 * `get_step_detail` against the real server, over the real transport.
 *
 * `get_flow_step` already returns a step. This tool exists for the move before
 * that one: on a step with three hundred network calls, "what did the page
 * log" costs thirty tokens and asking for the step costs thousands. That only
 * holds if two things are true, and neither is visible from anywhere else.
 *
 * The first is that the index prices the parts honestly — the `~N tokens`
 * beside each row has to be the cost of the text the next call actually
 * returns, or the reader is budgeting against a number nobody kept. Both halves
 * come out of `stepParts`, so the test that matters is that the index and the
 * section agree.
 *
 * The second is that asking for one part returns one part. A filter that
 * quietly widens is not a bug anyone sees: the answer is still correct, just
 * fifty times the price, and the caller was told it would be cheap.
 *
 * Two smaller claims are here because they are each a plausible mistake with no
 * other alarm on them. Console output keeps every level, unlike the walkthrough
 * — a reader who names this part is asking what the page said, and a `debug`
 * line is often what says it. And a step with no `domDelta` says a text change
 * was not recorded *and* that the setting may be the reason, because "nothing
 * changed" and "nobody was looking" are different facts an empty section
 * conflates.
 *
 * Why a spawned process rather than an import is in `tests/helpers/mcp-server.ts`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

/** The order `STEP_PARTS` fixes, which both the index and the sections follow. */
const PARTS = ['component', 'network', 'console', 'element', 'dom', 'screenshot'];

/**
 * The smallest budget the settings table allows (`mcp.maxTokens` clamps at
 * 1000), so a step can be built that outweighs it without being absurd.
 */
const TIGHT = 1000;

const NOW = Date.UTC(2026, 7, 24, 9, 30);

let home: string;
let server: McpSession;

const call = (name: string, args: Record<string, unknown>): Promise<string> =>
  server.call(name, args);

/** Where the `### <part>` section for one part begins, or -1. */
const sectionAt = (text: string, part: string) => text.indexOf(`### ${part}`);

/**
 * One flow, three steps, each one built for a different claim.
 *
 * Step 1 has every part: a component with a source and a feature component
 * around it, two network calls with one of them failed, console output at five
 * levels, a rich element, a text change and a screenshot.
 *
 * Step 2 has almost nothing — no text change, no screenshot, no console, no
 * network — because the sentences a part says about *itself* when it is empty
 * are the ones that stop an absent capture reading as a quiet page.
 */
function writeDetailFlow(): void {
  writeFlow(home, {
    id: 'flow-detail',
    name: 'Checkout breaks',
    timestamp: NOW,
    startUrl: 'https://shop.example.com/cart',
    errorCount: 1,
    schemaVersion: 1,
    react: {
      detected: true,
      components: {
        'cart-0': { name: 'Cart', status: 'resolved', source: 'src/components/Cart.tsx', line: 10 },
        'cart-1': {
          name: 'CartButton',
          status: 'resolved',
          source: 'src/components/Cart.tsx',
          line: 34,
        },
      },
    },
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/cart/review',
        timestamp: NOW,
        action: 'Clicked "Place order"',
        stepNumber: 1,
        screenshotFile: 'step-01.png',
        element: {
          tag: 'button',
          role: 'button',
          type: 'submit',
          label: 'Place order',
          text: 'Place order',
          ariaLabel: 'Place order now',
          cssSelector: 'button#place-order',
          xpath: '/html/body/main/form/button',
          boundingBox: { x: 12.4, y: 220.8, width: 148, height: 44 },
          react: { owner: 'cart-1', within: 'cart-0', chain: ['cart-0', 'cart-1'] },
        },
        domDelta: { before: 'Total £42.00', after: 'Something went wrong' },
        consoleLogs: [
          { level: 'log', args: ['cart:submit pressed'], timestamp: NOW + 1 },
          { level: 'info', args: ['cart:posting order'], timestamp: NOW + 2 },
          { level: 'debug', args: ['cart:payload built in 3ms'], timestamp: NOW + 3 },
          { level: 'warn', args: ['cart:retrying once'], timestamp: NOW + 4 },
          { level: 'error', args: ['TypeError: cannot read totals of undefined'], timestamp: NOW + 5 },
        ],
        networkCalls: [
          {
            method: 'GET',
            url: 'https://api.example.com/v1/cart',
            requestHeaders: {},
            requestBody: null,
            status: 200,
            responseHeaders: {},
            responseBody: '{"ok":true}',
            durationMs: 18,
            timestamp: NOW + 1,
          },
          {
            method: 'POST',
            url: 'https://api.example.com/v1/orders',
            requestHeaders: {},
            requestBody: '{"cartId":"c-1"}',
            status: 500,
            responseHeaders: {},
            responseBody: '{"error":"totals missing"}',
            durationMs: 240,
            timestamp: NOW + 6,
          },
        ],
      },
      {
        type: 'click',
        url: 'https://shop.example.com/cart/review',
        timestamp: NOW + 10,
        action: 'Clicked "Back"',
        stepNumber: 2,
        element: { tag: 'a', cssSelector: 'a.back' },
        consoleLogs: [],
        networkCalls: [],
      },
    ],
  });
}

/**
 * A step whose network alone outweighs the whole response, under a flow that
 * says so in its own stamp.
 *
 * The budget is per flow — `renderingFor` resolves the flow's `settings` under
 * the machine's — so the recording carries the small number rather than the
 * server being started with one, which leaves the rest of this file at the
 * defaults.
 */
function writeBudgetFlow(): void {
  writeFlow(home, {
    id: 'flow-budget',
    name: 'Dashboard poll',
    timestamp: NOW,
    startUrl: 'https://app.example.com/dash',
    errorCount: 0,
    schemaVersion: 1,
    settings: { 'mcp.maxTokens': TIGHT },
    steps: [
      {
        type: 'click',
        url: 'https://app.example.com/dash',
        timestamp: NOW,
        action: 'Clicked "Refresh"',
        stepNumber: 1,
        element: {
          tag: 'button',
          cssSelector: 'button.refresh',
        },
        consoleLogs: [],
        // Plain text rather than JSON, so it survives as itself: a body the
        // schema pass would replace with its shape would not weigh anything.
        networkCalls: Array.from({ length: 24 }, (_, i) => ({
          method: 'GET',
          url: `https://api.example.com/widget/${i}`,
          requestHeaders: {},
          requestBody: null,
          status: 200,
          responseHeaders: {},
          responseBody: `widget ${i} ${'x'.repeat(600)}`,
          durationMs: 11,
          timestamp: NOW + i,
        })),
      },
    ],
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-test-'));
  writeDetailFlow();
  writeBudgetFlow();

  server = await startServer({ home });
}, 20_000);

afterAll(() => {
  server?.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('the index, when no part was asked for', () => {
  it('lists all six parts, in the fixed order', async () => {
    const index = await call('get_step_detail', { id: 'flow-detail', step: 1 });

    const positions = PARTS.map((part) => index.indexOf(`\n  ${part} `));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('quotes what each part would cost, so the next call can be budgeted', async () => {
    const index = await call('get_step_detail', { id: 'flow-detail', step: 1 });

    for (const part of PARTS) {
      expect(index).toMatch(new RegExp(`^  ${part}\\s+.*~\\d+ tokens$`, 'm'));
    }
  });

  it('says what each part actually holds, not merely that it exists', async () => {
    const index = await call('get_step_detail', { id: 'flow-detail', step: 1 });

    expect(index).toMatch(/^ {2}network\s+2 calls, 1 failed/m);
    expect(index).toMatch(/^ {2}console\s+5 entries, 1 error/m);
    expect(index).toMatch(/^ {2}screenshot\s+step-01\.png/m);
  });

  it('names the component the step happened in, and where it was written', async () => {
    const index = await call('get_step_detail', { id: 'flow-detail', step: 1 });

    expect(index).toContain('## Step 1 of 2 — Checkout breaks');
    expect(index).toContain('CartButton  src/components/Cart.tsx:34');
  });

  it('names the call that fetches a part, with this flow and this step in it', async () => {
    const index = await call('get_step_detail', { id: 'flow-detail', step: 1 });

    expect(index).toContain('get_step_detail({"id":"flow-detail","step":1,"include":["network"]})');
    expect(index).toContain('get_flow_step');
  });

  it('prices a part at exactly what that part is about to cost', async () => {
    const index = await call('get_step_detail', { id: 'flow-detail', step: 1 });
    const detail = await call('get_step_detail', {
      id: 'flow-detail',
      step: 1,
      include: ['console'],
    });

    /*
     * Both halves come out of `stepParts`, and this is what that is for. A
     * quote computed from anything else — the raw entries, the step JSON, the
     * part before it was rendered — is a number the reader budgets against and
     * nobody keeps.
     */
    const quoted = Number(/^ {2}console\s+.*~(\d+) tokens$/m.exec(index)?.[1]);
    // The heading above the section is not priced, so the section is measured
    // on its own, exactly as `section()` builds it.
    const section = detail.slice(sectionAt(detail, 'console'));

    expect(quoted).toBeGreaterThan(0);
    expect(Math.ceil(section.length / 4)).toBe(quoted);
  });
});

describe('asking for one part', () => {
  it('returns that part and leaves the expensive one behind', async () => {
    const detail = await call('get_step_detail', {
      id: 'flow-detail',
      step: 1,
      include: ['console'],
    });

    expect(sectionAt(detail, 'console')).toBeGreaterThan(-1);
    expect(detail).toContain('TypeError: cannot read totals of undefined');
    // The whole point: the step's network is thousands of tokens and was not
    // asked for.
    expect(sectionAt(detail, 'network')).toBe(-1);
    expect(detail).not.toContain('api.example.com/v1/orders');
  });

  it('returns the parts in the fixed order however they were asked for', async () => {
    const detail = await call('get_step_detail', {
      id: 'flow-detail',
      step: 1,
      include: ['screenshot', 'network'],
    });

    expect(sectionAt(detail, 'network')).toBeGreaterThan(-1);
    expect(sectionAt(detail, 'screenshot')).toBeGreaterThan(sectionAt(detail, 'network'));
    expect(sectionAt(detail, 'console')).toBe(-1);
  });

  it('keeps every console level, unlike the walkthrough', async () => {
    const detail = await call('get_step_detail', {
      id: 'flow-detail',
      step: 1,
      include: ['console'],
    });

    // `get_flow_step`'s default filter drops these three, and a reader who
    // named this part is asking what the page said.
    expect(detail).toContain('[log] ');
    expect(detail).toContain('[info] ');
    expect(detail).toContain('[debug] ');
    expect(detail).toContain('cart:payload built in 3ms');
  });

  it('carries the element down to the selector that finds it again', async () => {
    const detail = await call('get_step_detail', {
      id: 'flow-detail',
      step: 1,
      include: ['element'],
    });

    expect(detail).toContain('selector: button#place-order');
    expect(detail).toContain('aria-label: Place order now');
  });

  it('names the feature component around the one the step is in', async () => {
    const detail = await call('get_step_detail', {
      id: 'flow-detail',
      step: 1,
      include: ['component'],
    });

    expect(detail).toContain('CartButton  src/components/Cart.tsx:34');
    expect(detail).toContain('within Cart  src/components/Cart.tsx:10');
  });
});

describe('a part the step has nothing in', () => {
  it('says a text change was not recorded, and that the setting may be why', async () => {
    const detail = await call('get_step_detail', { id: 'flow-detail', step: 2, include: ['dom'] });

    expect(sectionAt(detail, 'dom')).toBeGreaterThan(-1);
    expect(detail).toContain('No text change was recorded on this step');
    // "Nothing changed" and "nobody was looking" are different facts, and an
    // empty section quietly reports the second as the first.
    expect(detail).toContain('text deltas were switched off when this flow was recorded');
    expect(detail).not.toMatch(/### dom\s*$/);
  });

  it('says the same in the index rather than leaving the row blank', async () => {
    const index = await call('get_step_detail', { id: 'flow-detail', step: 2 });

    expect(index).toMatch(/^ {2}dom\s+no text change recorded/m);
    expect(index).toMatch(/^ {2}network\s+no network calls/m);
  });
});

describe('an argument that names nothing', () => {
  it('refuses an unknown part and lists the six that exist', async () => {
    const answer = await call('get_step_detail', {
      id: 'flow-detail',
      step: 1,
      include: ['netwrok'],
    });

    expect(answer).toContain('has no part called "netwrok"');
    expect(answer).toContain(`The parts are ${PARTS.join(', ')}`);
    expect(sectionAt(answer, 'network')).toBe(-1);
  });

  /*
   * The flag, not only the sentence. An MCP client reads `isError` to tell an
   * answer from a refusal, so a refusal sent as a success is a sentence the
   * model treats as a finding — and every assertion on the text alone passes
   * either way.
   */
  it('sends that refusal as an error rather than as a step with no parts in it', async () => {
    const answer = await server.callRaw('get_step_detail', {
      id: 'flow-detail',
      step: 1,
      include: ['netwrok'],
    });

    expect(answer.isError).toBe(true);
  });

  it('refuses a step past the end and says how many there are', async () => {
    const answer = await call('get_step_detail', { id: 'flow-detail', step: 99 });

    expect(answer).toContain('has no step 99');
    expect(answer).toContain('It has 2 steps, numbered 1 to 2');
  });

  it('refuses a flow that does not exist, pointing at list_flows', async () => {
    const answer = await call('get_step_detail', { id: 'flow-nope', step: 1 });

    expect(answer).toContain('"flow-nope" not found');
    expect(answer).toContain('list_flows');
  });
});

/*
 * The cut, on a part boundary, named.
 *
 * A reader who asks for the network of a step that polled two dozen endpoints
 * is asking for more than the response may carry, and the failure mode this
 * whole file exists against is a response that is quietly short: the section is
 * missing, nothing says so, and the model answers from the parts that fit.
 */
describe('a part that will not fit in the response', () => {
  it('stops before it and says which part it stopped before', async () => {
    const detail = await call('get_step_detail', {
      id: 'flow-budget',
      step: 1,
      include: ['component', 'network'],
    });

    expect(detail).toContain('Stopped before "network"');
    expect(detail).toContain('Ask for it on its own');
    expect(sectionAt(detail, 'component')).toBeGreaterThan(-1);
    expect(sectionAt(detail, 'network')).toBe(-1);
    expect(Math.ceil(detail.length / 4)).toBeLessThanOrEqual(TIGHT);
  });

  it('stops for the weight of a part, not for the number of them', async () => {
    const detail = await call('get_step_detail', {
      id: 'flow-budget',
      step: 1,
      include: ['component', 'console'],
    });

    // The same two-part call as above against parts that cost nothing. A cut
    // that fired here would be counting sections rather than pricing them.
    expect(sectionAt(detail, 'component')).toBeGreaterThan(-1);
    expect(sectionAt(detail, 'console')).toBeGreaterThan(-1);
    expect(detail).not.toContain('Stopped before');
  });

  it('carries it anyway when it is the only part asked for, and says what it lost', async () => {
    const detail = await call('get_step_detail', {
      id: 'flow-budget',
      step: 1,
      include: ['network'],
    });

    /*
     * The advice the cut above gives — ask for it on its own — has to actually
     * work. Returning nothing would leave the reader with no way to see the
     * part at all, and returning it whole would have the client truncate it at
     * an arbitrary character with nothing saying so.
     */
    expect(sectionAt(detail, 'network')).toBeGreaterThan(-1);
    expect(detail).toContain('https://api.example.com/widget/0');
    expect(detail).not.toContain('Stopped before');

    // Shortened, on a line boundary, counted.
    expect(detail).toMatch(/… \d+ of \d+ lines omitted/);
    expect(detail).toContain('this part alone exceeds the response budget');
    expect(Math.ceil(detail.length / 4)).toBeLessThanOrEqual(TIGHT);
  });
});
