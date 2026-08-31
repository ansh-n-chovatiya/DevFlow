/**
 * The two causal tools, against the real server, over the real transport.
 *
 * The roadmap's acceptance test for this work stream is a sentence: *a click
 * that triggers a fetch that logs an error produces a chain a tool can walk in
 * both directions, and the confidence of each link is stated — a guessed edge
 * presented as a known one is worse than no edge.* The first block below is
 * that sentence, written as a fixture and walked from both ends.
 *
 * The rest guards the second clause, which is the one that can be lost quietly.
 * A tool that prints a chain and drops the basis reads as a stronger claim than
 * the data supports, and nothing downstream can tell — so the assertions here
 * are less about the links being found than about the evidence travelling with
 * them, all the way to the text a model reads.
 *
 * The graph is derived at call time from the flow on disk, which is what makes
 * this testable at all: the fixtures are ordinary recordings, with nothing in
 * them that a real one would not carry.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

const BASE = Date.UTC(2026, 7, 20, 9, 30);

let home: string;
let server: McpSession;

const call = (name: string, args: Record<string, unknown>): Promise<string> =>
  server.call(name, args);

/**
 * The roadmap's own case: a click, the request it made, the error the app
 * logged about that request, and the store the response was written into.
 *
 * The log line names the request by *path* rather than by the whole URL,
 * because that is what a logger actually prints, and the order id in the
 * response body is repeated in the patch because that is what an app does with
 * a response. Both are the evidence the links are built on; a fixture that
 * omitted them would be testing the containment rule twice.
 */
function chainFlow() {
  return {
    id: 'flow-chain',
    name: 'Checkout chain',
    timestamp: BASE,
    startUrl: 'https://shop.example.com/cart',
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/cart',
        timestamp: BASE + 1000,
        action: 'Clicked "Place order"',
        stepNumber: 1,
        element: { tag: 'button', cssSelector: 'button.order' },
        networkCalls: [
          {
            method: 'POST',
            url: 'https://shop.example.com/api/v1/orders',
            requestHeaders: {},
            requestBody: null,
            status: 500,
            responseHeaders: {},
            responseBody: '{"orderId":"ord_8f3a91c4","error":"card_declined"}',
            durationMs: 120,
            timestamp: BASE + 1100,
          },
        ],
        consoleLogs: [
          {
            level: 'error',
            args: ['Request failed: /api/v1/orders returned 500'],
            timestamp: BASE + 1200,
          },
        ],
        state: [
          {
            store: 'redux:0',
            patch: [{ op: 'replace', path: '/order/id', value: 'ord_8f3a91c4' }],
          },
        ],
      },
    ],
  };
}

/**
 * A recording with no link at all: a click that produced nothing observable.
 *
 * Deliberately empty rather than merely unremarkable. A step with even a
 * heartbeat poll under it still carries an `attributed` link — containment is
 * a link, weak but real — so a fixture built that way tests the listing and
 * not the empty answer, which is the one that has to distinguish "nothing was
 * found" from "there was nothing to look at".
 */
function quietFlow() {
  return {
    id: 'flow-quiet',
    name: 'Quiet recording',
    timestamp: BASE,
    startUrl: 'https://shop.example.com/',
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/',
        timestamp: BASE + 1000,
        action: 'Clicked "Home"',
        stepNumber: 1,
        element: { tag: 'a', cssSelector: 'a.home' },
        consoleLogs: [],
        networkCalls: [],
      },
    ],
  };
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-causal-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  server = await startServer({ home });
  writeFlow(home, chainFlow());
  writeFlow(home, quietFlow());
});

afterAll(() => {
  server?.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a click that triggers a fetch that logs an error', () => {
  it('walks backwards from the error to the click', async () => {
    const answer = await call('get_causal_chain', { id: 'flow-chain', event: 'log:1.1' });

    // Through the request, not straight to the step: the chain has to have the
    // shape of what happened, or it is a list of things in the same step.
    expect(answer).toContain('net:1.1');
    expect(answer).toContain('step:1');
  });

  it('walks forwards from the click to the error', async () => {
    const answer = await call('get_effects_of', { id: 'flow-chain', event: 'step:1' });

    expect(answer).toContain('net:1.1');
    expect(answer).toContain('log:1.1');
  });

  it('reaches the state the response was written into', async () => {
    const answer = await call('get_effects_of', { id: 'flow-chain', event: 'net:1.1' });

    // `echoed` — the order id in the response body turns up in the patch. This
    // is the strongest link the analysis makes and the one a reader most wants.
    expect(answer).toMatch(/state:1\/redux:0/);
    expect(answer).toContain('echoed');
  });
});

describe('every link says what it rests on', () => {
  it('states the basis and the confidence of each link, not just the link', async () => {
    const answer = await call('get_causal_chain', { id: 'flow-chain', event: 'log:1.1' });

    // The clause the roadmap makes the acceptance test: a guessed edge
    // presented as a known one is worse than no edge, so a chain printed
    // without its evidence is a regression even when every link is correct.
    expect(answer).toMatch(/named/);
    expect(answer).toMatch(/high confidence/);
    expect(answer).toMatch(/attributed/);
    expect(answer).toMatch(/medium confidence/);
  });

  it('says what "attributed" is worth, rather than letting it read as causation', async () => {
    const answer = await call('get_causal_chain', { id: 'flow-chain', event: 'net:1.1' });

    // A background poll on a timer lands in exactly the same place as a click's
    // own request. The word for that is containment, and the tool has to use it.
    expect(answer).toMatch(/containment|attributed/i);
    expect(answer).not.toMatch(/\bcaused directly\b/i);
  });

  it('ranks the bases where a reader will see them', async () => {
    const answer = await call('get_causal_chain', { id: 'flow-chain', event: 'log:1.1' });

    expect(answer).toMatch(/worth trusting/);
  });
});

describe('the answers that are not a chain', () => {
  it('lists the events worth asking about when none is named', async () => {
    const answer = await call('get_causal_chain', { id: 'flow-chain', event: '' });

    // A ref is a syntax. A tool whose first answer is "that is not a valid ref"
    // has made the caller guess one.
    expect(answer).toContain('log:1.1');
    expect(answer).toContain('net:1.1');
    expect(answer).toMatch(/Ask what led to/);
  });

  it('puts the failure at the top of that listing, not step 1', async () => {
    const answer = await call('get_effects_of', { id: 'flow-chain', event: '' });
    const lines = answer.split('\n').filter((line) => line.startsWith('  '));

    // Somebody reaching for this tool is holding an error. A listing that opens
    // with the first step makes them scroll to find what they came in with.
    expect(lines[0]).toContain('log:1.1');
  });

  it('says a step is where a chain starts rather than that nothing was found', async () => {
    const answer = await call('get_causal_chain', { id: 'flow-chain', event: 'step:1' });

    // An event with no cause is ordinary, and reporting it as "nothing found"
    // reads as a failure of the analysis instead of as the answer.
    expect(answer).toMatch(/a step is where a chain starts/i);
    expect(answer).toMatch(/The user did this/i);
  });

  it('says a recording with no links has none, and what was looked for', async () => {
    const answer = await call('get_causal_chain', { id: 'flow-quiet', event: '' });

    expect(answer).toMatch(/No link was found/);
    // Absence of links is not absence of data, and the difference has to be on
    // the page: the events are still attributed, and another tool shows them.
    expect(answer).toMatch(/get_flow_step/);
  });

  it('refuses a ref that names nothing, and says where refs come from', async () => {
    const answer = await call('get_causal_chain', { id: 'flow-chain', event: 'net:9.9' });

    expect(answer).toMatch(/names no event/);
    expect(answer).toMatch(/step numbering/);
  });
});

describe('the graph is derived, so it covers what is already on disk', () => {
  it('analyses a recording that was never posted through this build', async () => {
    // `writeFlow` puts a `flow.json` straight on disk — no POST, no ingest, no
    // stored analysis. That is what every recording made before this feature
    // looks like, and the reason the graph is computed at call time.
    const answer = await call('get_effects_of', { id: 'flow-chain', event: 'step:1' });
    expect(answer).toContain('net:1.1');
  });

  it('walks the same graph both ways, and agrees with itself about the link', async () => {
    const forwards = await call('get_effects_of', { id: 'flow-chain', event: 'net:1.1' });
    const backwards = await call('get_causal_chain', { id: 'flow-chain', event: 'log:1.1' });

    // One link, two readings. If the two directions were built by two rules
    // they would eventually disagree about the evidence, and a reader has no
    // way to know which one to believe.
    expect(forwards).toContain('named');
    expect(backwards).toContain('named');
  });
});
