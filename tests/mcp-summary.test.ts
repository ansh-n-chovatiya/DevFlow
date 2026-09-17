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

/**
 * How far over that ceiling an all-ASCII response is still allowed to come out,
 * measured rather than allowed for.
 *
 * `server.js` prices ASCII at four characters to the token. That is the ratio
 * for English prose and not for the file paths, JSON and tool calls these
 * responses are mostly made of, where a BPE vocabulary spends a token on `({"`
 * and another on `":"` — so `bpeTokens` below segments the worst fixture in
 * this suite at about 6% over. It is a real gap and a small one, and it is a
 * different bug from the 4x the CJK cases below are about.
 *
 * Written as a pinned number rather than left out, for two reasons. It fails
 * the day the gap grows, which is the only thing that makes it safe to know
 * about and not fix. And closing it means re-pricing ASCII, which moves every
 * budgeted response in the server and is held in place by two suites outside
 * this one — `tests/mcp-step-detail.test.ts` and `tests/step-detail-render.test.ts`
 * both assert the index's token quote by retyping `chars / 4` and comparing it
 * with itself, which is the same self-agreement this file just stopped doing.
 */
const ASCII_OVERSHOOT = 1.08;

/** The ceiling on one failure sentence. `FAILURE_SUMMARY_TOKENS` in `server.js`. */
const FAILURE_SUMMARY_TOKENS = 120;

/** Both ceilings, as an independent count of an ASCII response measures them. */
const MEASURED_SUMMARY = Math.floor(SUMMARY_TOKENS * ASCII_OVERSHOOT);
const MEASURED_FAILURE = Math.floor(FAILURE_SUMMARY_TOKENS * ASCII_OVERSHOOT);

/**
 * The formula this file used to assert the budget with, kept only to prove it
 * was blind.
 *
 * It is `server.js`'s old `estimateTokens`, retyped — which is exactly the
 * problem the audit named: a budget checked against a second copy of the
 * formula that sets it agrees with itself no matter how wrong both are
 * (report.md §3.6). It survives here as the *subject* of a test rather than as
 * its instrument, so the CJK case below can show what it misses.
 */
const charsOverFour = (value: string) => Math.ceil(value.length / 4);

/**
 * How a vocabulary cuts text up, ordered so a code point outside printable
 * ASCII is taken on its own — a run of Japanese is priced per character rather
 * than swallowed whole by the punctuation alternative behind it.
 */
const PIECES = /[^\s\w!-~]|[A-Za-z']+|[0-9]+|[^\s\w]+|\S/gu;

/**
 * What a real BPE tokenizer charges, estimated independently of the server.
 *
 * Derived from how GPT-family vocabularies segment text rather than from a
 * characters-per-token ratio, so that agreeing with `server.js` means two
 * derivations agree — not that one formula was copied. A merged vocabulary
 * spends roughly one token on a short Latin word (longer ones split into pieces
 * of about six characters), one on each run of a few digits, one on each short
 * run of punctuation — `({"` and `":"` are single tokens, which is why a
 * response full of JSON and file paths costs far more than `chars / 4` says —
 * and, the part `chars / 4` gets wrong by 4x, about one token on every single
 * CJK character.
 *
 * Conservative where it is unsure, because every assertion using it is a
 * ceiling: over-counting makes these tests stricter than reality, under-counting
 * would make them the thing they exist to replace.
 */
const bpeTokens = (value: string): number => {
  let tokens = 0;
  for (const piece of value.match(PIECES) ?? []) {
    const code = piece.codePointAt(0) ?? 0;
    if (code > 0x7f) tokens += 1;
    else if (/^[A-Za-z']+$/.test(piece)) tokens += Math.ceil(piece.length / 6);
    else if (/^[0-9]+$/.test(piece)) tokens += Math.ceil(piece.length / 3);
    else tokens += Math.ceil(piece.length / 3);
  }
  return tokens;
};

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

/**
 * The audit's own reproduction, rebuilt: a failed request to a tracking beacon.
 *
 * Roughly 1,900 characters of query string, which is what a real recording of a
 * real page handed `list_flows` — one triage row costing about 470 tokens,
 * because `failureSummary` keyed its failure shapes on `urlPath()`, and
 * `urlPath()` returns path *and* search verbatim (report.md §3.6). The URL is
 * the page's, not the extension's: nothing about how the recording was made
 * bounds it.
 */
const BEACON_URL =
  'https://px.analytics.example.com/collect?' +
  Array.from({ length: 65 }, (_, i) => `utm_${i}=${'x'.repeat(20)}`).join('&');

function writeBeaconFlow(): void {
  writeFlow(home, {
    id: 'flow-beacon',
    name: 'Article page, ad stack failing',
    timestamp: BASE + 5 * DAY,
    startUrl: 'https://news.example.com/article/1',
    errorCount: 4,
    schemaVersion: 1,
    steps: Array.from({ length: 8 }, (_, i) => {
      const n = i + 1;
      const fails = n % 2 === 0;
      return {
        type: 'click',
        url: 'https://news.example.com/article/1',
        timestamp: BASE + n * 1000,
        action: `Clicked "Next page ${n}"`,
        stepNumber: n,
        element: { tag: 'a', cssSelector: 'a.next' },
        consoleLogs: [],
        networkCalls: fails
          ? [
              {
                method: 'GET',
                url: BEACON_URL,
                requestHeaders: {},
                requestBody: null,
                status: 502,
                responseHeaders: {},
                responseBody: '',
                durationMs: 3000,
                timestamp: BASE,
              },
            ]
          : [],
      };
    }),
  });
}

/** One sentence of the kind a Japanese-language app writes to the console. */
const JAPANESE = '決済処理中に予期しないエラーが発生しました注文の合計金額を取得できません';

/** `length` characters of it, so a fixture can be sized rather than counted. */
const japanese = (length: number): string =>
  JAPANESE.repeat(Math.ceil(length / JAPANESE.length)).slice(0, length);

/**
 * The same tool asked about a page that does not speak English.
 *
 * This is the density case, and it is the one `chars / 4` cannot see. Every
 * field below that carries text is one the extension copied from somewhere it
 * does not control — the name the user typed, the message the app logged, the
 * component names and paths the bundle's source map gave back — and on this
 * recording all of them are Japanese, where a BPE tokenizer spends about one
 * token per character rather than one per four.
 *
 * Nothing here is larger than the English fixtures: fewer steps, fewer failure
 * shapes, a shorter name. It is the same response, in a different script, and
 * that alone used to be worth 4x (report.md §3.6).
 */
function writeCjkFlow(): void {
  const components: Record<string, ReturnType<typeof component>> = {};
  for (let i = 0; i < 8; i++) {
    components[`jp-${i}`] = component(
      `支払い方法セレクター${i}`,
      `packages/店舗フロント/src/機能/決済/構成要素/支払い方法セレクター${i}.tsx`,
      120 + i,
    );
  }

  const steps = Array.from({ length: 40 }, (_, i) => {
    const n = i + 1;
    const fails = n % 3 === 0;
    return {
      type: 'click',
      url: 'https://shop.example.co.jp/cart',
      timestamp: BASE + n * 1000,
      action: `Clicked "次へ ${n}"`,
      stepNumber: n,
      element: {
        tag: 'button',
        cssSelector: `button.next-${n}`,
        react: { owner: `jp-${n % 8}`, within: `jp-${(n + 3) % 8}`, chain: [`jp-${n % 8}`] },
      },
      /*
       * Console errors and no failed requests, so the verdict is the page's own
       * sentence: `failureSummary` prefers the failed-call shapes when there are
       * any, and a URL is percent-encoded to ASCII by the time it is printed.
       */
      consoleLogs: fails ? [{ level: 'error', args: [japanese(110)], timestamp: BASE }] : [],
      networkCalls: [],
    };
  });

  writeFlow(home, {
    id: 'flow-cjk',
    name: japanese(90),
    timestamp: BASE + 6 * DAY,
    startUrl: 'https://shop.example.co.jp/cart',
    errorCount: 13,
    schemaVersion: 1,
    react: { detected: true, components },
    steps,
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-test-'));
  writeHostileFlow();
  writePlainFlow();
  writeCleanFlow();
  writeWithheldFlow();
  writeNewestFlow();
  writeBeaconFlow();
  writeCjkFlow();

  server = await startServer({ home });
}, 20_000);

afterAll(() => {
  server?.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('the budget the tool is named after', () => {
  it('holds on a recording built to break it', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-hostile' });

    expect(bpeTokens(summary)).toBeLessThanOrEqual(MEASURED_SUMMARY);
  });

  it('holds on an ordinary recording', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-plain' });

    expect(bpeTokens(summary)).toBeLessThanOrEqual(MEASURED_SUMMARY);
  });

  it('holds on a recording where nothing failed', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-clean' });

    expect(bpeTokens(summary)).toBeLessThanOrEqual(MEASURED_SUMMARY);
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
    expect(bpeTokens(summary)).toBeGreaterThan(100);
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

    expect(bpeTokens(summary)).toBeLessThanOrEqual(MEASURED_SUMMARY);
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
 * `list_flows` is the cheap call, and its rows carry text the page chose.
 *
 * Every other string this server prints is cut somewhere. The failure sentence
 * was not, and it is the one embedded once per failing recording in the tool a
 * reader opens *before* they know which flow they want — so the row for a page
 * with an ad stack on it cost more than the summary tool next to it.
 */
describe('a failure whose URL the page chose', () => {
  const rows = async (): Promise<{ id: string; summary?: string }[]> =>
    JSON.parse(await call('list_flows', {})) as { id: string; summary?: string }[];

  const beacon = async () => (await rows()).find((row) => row.id === 'flow-beacon');

  it('is the fixture the audit found live, not a hypothetical one', () => {
    expect(BEACON_URL.length).toBeGreaterThan(1_800);
    // One URL, on its own, worth more than the whole `get_flow_summary` budget.
    expect(bpeTokens(BEACON_URL)).toBeGreaterThan(SUMMARY_TOKENS);
  });

  it('does not arrive in a row verbatim', async () => {
    const entry = await beacon();

    expect(entry?.summary).toBeTruthy();
    expect(entry?.summary).not.toContain(BEACON_URL);
    // Cut, and saying so. A shortened URL that reads as a short URL is the
    // silent truncation the rest of this server refuses.
    expect(entry?.summary).toContain('chars total');
  });

  it('costs what the other rows cost', async () => {
    const summarised = (await rows()).filter((row) => typeof row.summary === 'string');

    // More than one, or this asserts nothing about "the same budget as the
    // others": the beacon row is meant to be indistinguishable in cost.
    expect(summarised.length).toBeGreaterThan(1);
    for (const row of summarised) {
      expect(bpeTokens(row.summary ?? '')).toBeLessThanOrEqual(MEASURED_FAILURE);
    }
  });

  it('still says which call broke, and where', async () => {
    const entry = await beacon();

    expect(entry?.summary).toContain('GET /collect');
    expect(entry?.summary).toContain('502');
    expect(entry?.summary).toMatch(/first at step \d/);
  });
});

/**
 * The density case: the same response, in a script that costs four times as
 * much per character.
 *
 * `chars / 4` is an English-prose ratio. A BPE tokenizer spends about one token
 * on every CJK character, so a summary of a Japanese page was priced at a
 * quarter of what it costs and the budget the tool is named after was missed by
 * a multiple — with nothing to notice, because the test asserting the budget
 * redefined the same formula and compared it with itself (report.md §3.6).
 *
 * The assertions below use `bpeTokens`, which is derived from how a vocabulary
 * segments text rather than from a character ratio, so the server's estimate
 * and the test's are two independent answers to the same question.
 */
describe('a recording of a page that does not speak English', () => {
  it('keeps the budget when a tokenizer does the counting', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-cjk' });

    // Strictly the ceiling, not the ASCII allowance above it: this response is
    // mostly Japanese, and Japanese is now priced at what it costs.
    expect(bpeTokens(summary)).toBeLessThanOrEqual(SUMMARY_TOKENS);
  });

  it('is dense enough that the formula this replaced could not see it', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-cjk' });

    // The finding in one line: the old estimate calls this response cheap and
    // it is not. A test that redefined `chars / 4` would agree with the first
    // number and never compute the second.
    expect(charsOverFour(summary)).toBeLessThan(bpeTokens(summary) / 2);
  });

  it('pays for the Japanese it prints instead of discounting it', async () => {
    const [dense, english] = await Promise.all([
      call('get_flow_summary', { id: 'flow-cjk' }),
      call('get_flow_summary', { id: 'flow-plain' }),
    ]);

    /*
     * The English recording affords its component line; the Japanese one does
     * not, and that is the whole behaviour change. The line is the same length
     * in characters and four times the length in tokens, so under `chars / 4`
     * it was admitted at a quarter of its cost — which is how a 400-token
     * response came back at 1,600.
     */
    expect(english).toContain('Components:');
    expect(dense).not.toContain('Components:');
  });

  it('spends what it has on the page’s own words', async () => {
    const summary = await call('get_flow_summary', { id: 'flow-cjk' });

    expect(summary).toContain(japanese(20));
    expect(summary).toContain('flow-cjk');
    expect(summary).toContain('Next:');
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
