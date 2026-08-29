/**
 * `get_flow` against the real server, over the real transport.
 *
 * Why a spawned process rather than an import, and how the plumbing works, is in
 * `tests/helpers/mcp-server.ts`. The short version: the server is a standalone
 * script with top-level side effects, it has no typecheck over it, and its
 * failure mode is invisible — every MCP client caps tool output by truncating
 * the string, so a response that outgrows the cap arrives as a document cut
 * mid-JSON with nothing anywhere saying so, and the model answers from half a
 * recording.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

/** The budget the server is told to keep, so the assertions can name a number. */
const BUDGET = 20_000;

/**
 * Long enough that even the walkthrough alone has to page.
 *
 * It was 120, which stopped exercising anything the moment the step data came
 * out of the default response and a whole recording started fitting in one page
 * — a pagination test that never paginates passes for the wrong reason.
 */
const STEP_COUNT = 400;
const estimateTokens = (value: string) => Math.ceil(value.length / 4);

let home: string;
let server: McpSession;

/** `writeFlow` against this file's own temp directory. */
const writeOne = (flow: Parameters<typeof writeFlow>[1]): string => writeFlow(home, flow);

const call = (name: string, args: Record<string, unknown>): Promise<string> =>
  server.call(name, args);

/**
 * A recording big enough to page: `STEP_COUNT` steps, every tenth failing with a
 * stack trace, bodies already compacted the way the extension sends them.
 */
function writeBigFlow(): void {
  const dir = path.join(home, 'flows', 'flow-big');
  fs.mkdirSync(dir, { recursive: true });

  const schema = '[schema — 4.3KB raw]\nArray(40) of {\n  id: integer,\n  sku: string\n}';
  const trace = 'at CartService.total (src/services/cart.ts:88)\n'.repeat(25);

  const steps = Array.from({ length: STEP_COUNT }, (_, i) => {
    const n = i + 1;
    const fails = n % 10 === 0;
    return {
      type: 'click',
      url: 'https://shop.example.com/cart',
      timestamp: 1_787_579_886_415 + n * 1000,
      action: `Clicked "Item ${n}"`,
      stepNumber: n,
      element: { tag: 'button', cssSelector: `button.item-${n}`, xpath: `/html/body/button[${n}]` },
      consoleLogs: fails ? [{ level: 'error', args: ['TypeError: cannot read id'], timestamp: 1 }] : [],
      networkCalls: [
        {
          method: 'GET',
          url: 'https://api.example.com/v1/cart',
          requestHeaders: {},
          requestBody: null,
          status: fails ? 500 : 200,
          responseHeaders: {},
          responseBody: fails
            ? JSON.stringify({ error: 'Cannot read property id of undefined', stack: trace })
            : schema,
          durationMs: 143,
          timestamp: 1,
        },
      ],
    };
  });

  const flow = {
    id: 'flow-big',
    name: 'Cart bug',
    timestamp: 1_787_579_886_415,
    stepCount: steps.length,
    startUrl: 'https://shop.example.com',
    errorCount: 12,
    schemaVersion: 1,
    steps,
  };

  writeOne(flow);
}

/**
 * A flow nothing ever compacted — a recording made before the extension did it,
 * or a POST from something that is not the extension. The server has to do the
 * work in that case, and a slice of a four-hundred-row array is precisely the
 * silent-truncation failure this codebase refuses elsewhere: it ends mid-object
 * and reads as a complete answer with nine rows in it.
 */
function writeUncompacted(): void {
  const body = JSON.stringify({
    items: Array.from({ length: 400 }, (_, i) => ({ id: i, sku: `SKU-${i}`, price: 19.99 })),
  });

  writeOne({
    id: 'flow-raw',
    name: 'Uncompacted',
    timestamp: 1_700_000_000_000,
    startUrl: 'https://a.test/',
    errorCount: 1,
    schemaVersion: 1,
    steps: [
      {
        type: 'click',
        url: 'https://a.test/',
        timestamp: 1_700_000_000_000,
        action: 'Clicked "Load"',
        stepNumber: 1,
        element: { tag: 'button', cssSelector: '#load', xpath: '/x' },
        consoleLogs: [
          { level: 'log', args: ['render 12ms'], timestamp: 1_700_000_000_000 },
          { level: 'debug', args: ['tick'], timestamp: 1_700_000_000_000 },
          { level: 'error', args: ['boom'], timestamp: 1_700_000_000_000 },
        ],
        networkCalls: [
          {
            method: 'GET',
            url: 'https://api.test/items',
            requestHeaders: {},
            requestBody: null,
            status: 200,
            responseHeaders: {},
            responseBody: body,
            durationMs: 9,
            timestamp: 1_700_000_000_000,
          },
        ],
      },
    ],
  });
}

/** A recording from a build newer than this server. */
function writeFutureSchema(): void {
  writeOne({
    id: 'flow-future',
    name: 'From tomorrow',
    timestamp: 1_700_000_000_000,
    schemaVersion: 99,
    steps: [{ type: 'note', url: 'https://a.test/', timestamp: 1, action: 'x', stepNumber: 1 }],
  });
}

/**
 * One step that makes more requests than a whole budget can hold.
 *
 * `BODY_CAP` bounds how big any one body may be; nothing bounds how many calls a
 * step may have, and a dashboard or a polling page between two clicks reaches
 * three figures without trying. The walkthrough renders each call at roughly two
 * hundred tokens, so ninety of them is the whole page — which is the case the
 * budget has to survive on the path that is actually sent.
 */
const HEAVY_CALLS = 300;

function writeCallHeavy(): void {
  const body = 'x'.repeat(900);
  const step = (n: number) => ({
    type: 'click',
    url: 'https://app.example.com/dash',
    timestamp: 1_787_579_886_415 + n * 1000,
    action: `Clicked "Load ${n}"`,
    stepNumber: n,
    element: { tag: 'button', cssSelector: `button.load-${n}` },
    consoleLogs: [],
    networkCalls: Array.from({ length: HEAVY_CALLS }, (_, i) => ({
      method: 'GET',
      url: `https://api.example.com/widget/${i}`,
      requestHeaders: {},
      requestBody: null,
      status: 200,
      responseHeaders: {},
      responseBody: body,
      durationMs: 12,
      timestamp: 1,
    })),
  });

  writeOne({
    id: 'flow-heavy',
    name: 'Fat step',
    timestamp: 1_787_579_886_415,
    startUrl: 'https://app.example.com/dash',
    errorCount: 0,
    schemaVersion: 1,
    steps: [step(1), step(2)],
  });
}

/**
 * A recording made under settings that are not the defaults — the stamp.
 *
 * Screenshots off and a low body cap, which between them produce a flow with no
 * pictures and no payloads: the exact recording a reader would
 * otherwise diagnose as a failed capture. One of its two `network.*` keys is
 * `rendered` rather than `recorded`, so this also proves the server applies the
 * sender's compaction rules rather than its own — a 400-row body it would
 * normally summarise arrives with `summariseBodies: false` and has to survive
 * whole.
 *
 * Written straight to disk like the rest, so what is under test is the server's
 * reading of a stamp rather than the extension's writing of one.
 */
function writeStamped(): void {
  const rows = JSON.stringify({
    items: Array.from({ length: 400 }, (_, i) => ({ id: i, sku: `SKU-${i}` })),
  });

  writeOne({
    id: 'flow-stamped',
    name: 'Quiet capture',
    timestamp: 1_787_579_886_415,
    startUrl: 'https://shop.example.com',
    errorCount: 0,
    schemaVersion: 1,
    settings: {
      'screenshots.capture': false,
      'network.bodyCap': 1024,
      'network.summariseBodies': false,
    },
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/cart',
        timestamp: 1_787_579_886_415,
        action: 'Clicked "Checkout"',
        stepNumber: 1,
        screenshot: null,
        screenshotOmitted: 'Screenshots are switched off in FlowSnap settings for this recording.',
        element: { tag: 'button', cssSelector: '#checkout', xpath: '/html/body/button' },
        networkCalls: [
          {
            method: 'GET',
            url: 'https://api.example.com/v1/items',
            requestHeaders: {},
            requestBody: null,
            status: 200,
            responseHeaders: {},
            responseBody: rows,
            durationMs: 20,
            timestamp: 1,
          },
        ],
      },
    ],
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsnap-test-'));
  writeBigFlow();
  writeUncompacted();
  writeFutureSchema();
  writeCallHeavy();
  writeStamped();

  server = await startServer({ home, env: { FLOWSNAP_MAX_TOKENS: String(BUDGET) } });
}, 20_000);

afterAll(() => {
  server?.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('a recording too long to return at once', () => {
  it('stays inside the budget instead of being cut by the client', async () => {
    const page = await call('get_flow', { id: 'flow-big' });

    expect(estimateTokens(page)).toBeLessThanOrEqual(BUDGET);
  });

  it('says it is not the whole recording, and names the call that continues it', async () => {
    const page = await call('get_flow', { id: 'flow-big', raw: true });

    expect(page).toContain(`of ${STEP_COUNT}`);
    expect(page).toContain('This is not the whole recording');
    expect(page).toMatch(/get_flow\(\{"id":"flow-big","from":\d+\}\)/);
  });

  it('leaves the JSON block parseable, which is the whole point', async () => {
    const page = await call('get_flow', { id: 'flow-big', raw: true });
    const block = /```json\n([\s\S]*?)\n```/.exec(page);

    expect(block).not.toBeNull();
    expect(() => JSON.parse(block?.[1] ?? '') as unknown).not.toThrow();
  });

  it('continues from where it left off, and reaches the end', async () => {
    const first = await call('get_flow', { id: 'flow-big', raw: true });
    const from = Number(/"from":(\d+)/.exec(first)?.[1]);
    expect(from).toBeGreaterThan(1);

    const second = await call('get_flow', { id: 'flow-big', from, raw: true });

    expect(second).toContain(`Steps ${from}–`);
    expect(second).toContain(`of ${STEP_COUNT}`);
    // A reader who lands on a later page must be told the earlier steps exist.
    expect(second).toContain('Earlier steps are at from:1');
  });

  it('terminates, and every step appears on exactly one page', async () => {
    const seen = new Set<number>();
    let next: number | null = 1;

    // Following the instruction the response gives, the way a reader would.
    // A budget that ever failed to advance would hang here rather than pass.
    for (let page = 0; page < 40 && next !== null; page++) {
      const body: string = await call('get_flow', { id: 'flow-big', from: next, raw: true });
      for (const heading of body.match(/^### (\d+)\. /gm) ?? []) {
        const number = Number(/\d+/.exec(heading)?.[0]);
        expect(seen.has(number)).toBe(false);
        seen.add(number);
      }
      const more = /"from":(\d+)/.exec(body);
      next = more ? Number(more[1]) : null;
    }

    expect(next).toBeNull();
    expect(seen.size).toBe(STEP_COUNT);
  });

  it('cuts on a step boundary — no step is half-present', async () => {
    const page = await call('get_flow', { id: 'flow-big', raw: true });
    const block = /```json\n([\s\S]*?)\n```/.exec(page)?.[1] ?? '';
    const parsed = JSON.parse(block) as { steps: { stepNumber: number }[] };

    const last = parsed.steps[parsed.steps.length - 1];
    const headings = page.match(/^### \d+\. /gm) ?? [];

    // The walkthrough and the step data describe the same window.
    expect(parsed.steps).toHaveLength(headings.length);
    expect(last.stepNumber).toBe(Number(/"from":(\d+)/.exec(page)?.[1]) - 1);
  });
});

describe('a `from` that makes no sense', () => {
  it.each([
    ['past the end', 999],
    ['zero', 0],
    ['negative', -5],
    ['not a number', 'abc'],
  ])('is clamped rather than refused: %s', async (_label, from) => {
    const page = await call('get_flow', { id: 'flow-big', from });

    expect(page).toContain(`of ${STEP_COUNT}`);
    expect(page).not.toContain('not found');
    expect(estimateTokens(page)).toBeLessThanOrEqual(BUDGET);
  });
});

describe('get_flow_errors', () => {
  it('reports every failure it found, whether or not it can show them all', async () => {
    const errors = await call('get_flow_errors', { id: 'flow-big' });

    expect(errors).toContain(`of ${STEP_COUNT} steps failed`);
    expect(estimateTokens(errors)).toBeLessThanOrEqual(BUDGET);
  });

  it('keeps the stack trace, which is the reason to call it', async () => {
    const errors = await call('get_flow_errors', { id: 'flow-big' });

    expect(errors).toContain('Cannot read property id of undefined');
    expect(errors).toContain('src/services/cart.ts:88');
  });
});

describe('a flow nothing compacted before it arrived', () => {
  it('is reduced to the shape of its response, not a slice of it', async () => {
    const page = await call('get_flow', { id: 'flow-raw' });

    expect(page).toContain('[schema —');
    // A slice would have carried hundreds of rows and read as the whole answer.
    expect(page).not.toContain('SKU-399');
    expect(estimateTokens(page)).toBeLessThan(2_000);
  });

  it('drops log and debug from the step data, and says how many it dropped', async () => {
    const page = await call('get_flow', { id: 'flow-raw', raw: true });
    const block = /```json\n([\s\S]*?)\n```/.exec(page)?.[1] ?? '';
    const parsed = JSON.parse(block) as {
      steps: { consoleLogs: { level: string }[]; consoleLogsOmitted?: string }[];
    };

    // The markdown has always filtered to errors and warnings; the JSON did not,
    // so the two halves of one response disagreed about what was worth reading.
    expect(parsed.steps[0].consoleLogs.map((entry) => entry.level)).toEqual(['error']);
    expect(parsed.steps[0].consoleLogsOmitted).toContain('2');
  });

  it('keeps everything when one step is asked for in detail', async () => {
    const detail = await call('get_flow_step', { id: 'flow-raw', step: 1 });
    const block = /```json\n([\s\S]*?)\n```/.exec(detail)?.[1] ?? '';
    const parsed = JSON.parse(block) as { consoleLogs: { level: string }[] };

    // A debug line can be the thing that explains the step you are staring at.
    expect(parsed.consoleLogs.map((entry) => entry.level)).toEqual(['log', 'debug', 'error']);
  });
});

describe('a flow recorded by a newer build', () => {
  it('is refused with the reason, not reported as missing', async () => {
    const answer = await call('get_flow', { id: 'flow-future' });

    // It is sitting in list_flows in front of the reader; "not found" would send
    // them hunting for a recording they already have.
    expect(answer).not.toContain('not found');
    expect(answer).toContain('v99');
    expect(answer).toContain('npx -y flowsnap-mcp@latest');
  });
});

describe('the walkthrough and the step data are no longer the same thing twice', () => {
  it('returns the narrative by default, and says where the record is', async () => {
    const page = await call('get_flow', { id: 'flow-big' });

    expect(page).toContain('### 1. ');
    expect(page).not.toContain('```json');
    // Named in the response, because the moment a reader wants it is the moment
    // they are looking at this text.
    expect(page).toContain('"raw":true');
  });

  it('costs materially less per step than returning both', async () => {
    const narrative = await call('get_flow', { id: 'flow-big' });
    const both = await call('get_flow', { id: 'flow-big', raw: true });

    /*
     * Per step, not per response: both pages fill the same budget, so comparing
     * their totals compares how much of the recording each one managed to carry
     * rather than what a step costs — which is the thing that changed.
     */
    const perStep = (page: string) =>
      estimateTokens(page) / (page.match(/^### \d+\. /gm) ?? ['']).length;

    expect(perStep(narrative) * 3).toBeLessThan(perStep(both));
  });

  it('fits a whole long recording where the record has to be paged', async () => {
    const narrative = await call('get_flow', { id: 'flow-big' });
    const both = await call('get_flow', { id: 'flow-big', raw: true });

    const stepsIn = (page: string) => (page.match(/^### \d+\. /gm) ?? []).length;

    /*
     * The walkthrough is bounded per step by the renderer itself — bodies cut at
     * 800 characters, console at 200, five entries — so it comes to roughly
     * forty tokens a step whatever the page was doing. That is what lets a
     * recording near `MAX_STEPS` arrive in one piece, and it is the thing worth
     * locking down: the record of the same flow pages several times over.
     */
    expect(stepsIn(narrative)).toBe(STEP_COUNT);
    expect(stepsIn(both)).toBeLessThan(STEP_COUNT / 2);
    expect(estimateTokens(narrative)).toBeLessThanOrEqual(BUDGET);
  });

  it('keeps the screenshot paths, which are the one thing only the record had', async () => {
    const page = await call('get_flow', { id: 'flow-big' });

    expect(page).toContain('screenshots');
  });
});

/*
 * The budget has to hold on the path that is actually sent.
 *
 * Shrinking used to run on the JSON block alone, which stopped being sent the
 * moment `raw` defaulted to false — so the half that was thrown away was
 * trimmed and the walkthrough, carrying the same calls at roughly two hundred
 * tokens each, went out whole. A single step with three hundred requests
 * returned 65,000 tokens against a 20,000 budget with the page above it still
 * announcing a clean cut on a step boundary, and the client truncated the rest
 * in silence.
 */
describe('a step that outweighs the budget on its own', () => {
  it('keeps the default response inside the budget', async () => {
    const page = await call('get_flow', { id: 'flow-heavy' });

    expect(estimateTokens(page)).toBeLessThanOrEqual(BUDGET);
  });

  it('keeps the record inside it too', async () => {
    const page = await call('get_flow', { id: 'flow-heavy', raw: true });

    expect(estimateTokens(page)).toBeLessThanOrEqual(BUDGET);
  });

  it('drops calls from the walkthrough, not only from the record', async () => {
    const page = await call('get_flow', { id: 'flow-heavy' });
    const rendered = (page.match(/^`GET` /gm) ?? []).length;

    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(HEAVY_CALLS);
  });

  it('says what it dropped, where the reader is looking', async () => {
    const page = await call('get_flow', { id: 'flow-heavy' });

    // In the walkthrough itself. A step quietly missing two hundred of its
    // requests reads as a step that only made a few.
    expect(page).toMatch(/\d+ of 300 calls omitted/);
  });

  it('still advances, so the reader is not left in a loop', async () => {
    const page = await call('get_flow', { id: 'flow-heavy' });

    // The step that does not fit is carried anyway, shrunk — returning an empty
    // page would leave a `from` that never moves.
    expect(page).toContain('Steps 1–1 of 2');
    expect(page).toContain('"from":2');
  });
});

/**
 * A flow records the settings it was made under, and the walkthrough header
 * shows the non-default ones.
 *
 * Against the real server, because that is where it has to be true. `server.js`
 * is JavaScript with no typecheck over it, and the failure — a header line that
 * silently stops being rendered — leaves a flow that reads exactly like a
 * recording where capture failed. Nothing else would notice.
 */
describe('a flow recorded under non-default settings says so', () => {
  it('names them in the walkthrough header, above the first step', async () => {
    const text = await call('get_flow', { id: 'flow-stamped' });

    expect(text).toContain('Recorded with non-default settings');
    expect(text).toContain('Capture screenshots: off (default on)');
    expect(text).toContain('Body capture limit: 1024 (default 51200)');

    // Above the steps: a reader who meets a flow with no screenshots needs this
    // before the first one, not after it.
    expect(text.indexOf('non-default settings')).toBeLessThan(text.indexOf('### 1.'));
  });

  it('says why a step has no picture instead of leaving a gap', async () => {
    const text = await call('get_flow', { id: 'flow-stamped' });

    expect(text).toContain('🚫 no screenshot');
    expect(text).toContain('switched off in FlowSnap settings');
  });

  it('renders bodies under the sender rules rather than its own', async () => {
    const text = await call('get_flow', { id: 'flow-stamped' });

    // The extension deliberately did not summarise this body, and the server
    // re-summarising it would undo the setting from the other side of the wire.
    expect(text).not.toContain('[schema —');
    expect(text).toContain('SKU-0');
  });

  it('says nothing at all for a flow recorded at the defaults', async () => {
    const text = await call('get_flow', { id: 'flow-heavy' });
    expect(text).not.toContain('non-default settings');
  });
});
