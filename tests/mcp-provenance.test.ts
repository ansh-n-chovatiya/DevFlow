/**
 * `get_value_provenance`, against the real server, over the real transport.
 *
 * The v3.2.0 attempt at this work stream was **unreachable dead code**: a module
 * nothing called, behind a tool that was never wired. So the first thing this
 * file asserts is the least interesting and the one that was actually missing —
 * that calling the tool returns an answer.
 *
 * Everything after that guards the one claim the feature must not overstate.
 * The mechanism is a search for the same value across four independent
 * observations of one recording; it is not a data-flow trace, and the gap
 * between those matters most exactly when the answer looks best. Four layers
 * agreeing on `£1,284.00` is one value travelling. Four layers agreeing on `2`
 * is a coincidence four times over, and a reply that presents the second like
 * the first has told a model something false in a form it cannot check.
 *
 * The three things that would be lost silently, and are each asserted below:
 * the sentence saying what the mechanism is; the caution on a short value, said
 * *before* the findings rather than under them; and the naming of any layer the
 * recording never captured, because "not in a response" and "this flow has no
 * responses" look identical as an absent section.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

const BASE = Date.UTC(2026, 8, 1, 11, 0);

let home: string;
let server: McpSession;

const call = (name: string, args: Record<string, unknown>): Promise<string> =>
  server.call(name, args);

/**
 * One value that genuinely travels: the server sends a total, the app writes it
 * into a store, a component is handed it, and a cell shows it.
 *
 * Written as an ordinary recording, with nothing in it a real one would not
 * carry — which is what makes the tool testable at all, since it derives
 * everything at call time from the flow on disk.
 */
function travellingFlow() {
  return {
    id: 'flow-value',
    name: 'Invoice total',
    timestamp: BASE,
    startUrl: 'https://billing.example.com/invoices',
    react: {
      detected: true,
      build: 'development',
      components: {
        cmp_row: { name: 'InvoiceRow', status: 'resolved', source: 'src/InvoiceRow.tsx', line: 18 },
      },
    },
    state: { read: true, stores: [{ id: 'redux:0', kind: 'redux', label: 'ReactRedux' }] },
    renders: { read: true },
    steps: [
      {
        type: 'click',
        url: 'https://billing.example.com/invoices',
        timestamp: BASE + 1000,
        action: 'Clicked "Refresh"',
        stepNumber: 1,
        element: { tag: 'button', text: 'Refresh', cssSelector: '#refresh', xpath: '//button', boundingBox: null },
        networkCalls: [
          {
            method: 'GET',
            url: 'https://api.example.com/v1/invoices',
            requestHeaders: {},
            requestBody: null,
            status: 200,
            responseHeaders: { 'content-type': 'application/json' },
            // The pointer the reply must be able to name, and a key with a
            // slash in it beside it — RFC 6901 escaping is the kind of bug
            // nobody notices until a path silently resolves to nothing.
            responseBody: JSON.stringify({
              invoices: [{ id: 'INV-9', 'amount/gross': '£1,284.00' }],
            }),
            durationMs: 42,
            timestamp: BASE + 1050,
          },
        ],
        state: [
          {
            store: 'redux:0',
            patch: [{ op: 'replace', path: '/invoices/0', value: { id: 'INV-9', total: '£1,284.00' } }],
          },
        ],
        renders: [
          {
            component: 'cmp_row',
            props: [{ key: 'total', before: '£0.00', after: '£1,284.00' }],
          },
        ],
      },
      {
        type: 'click',
        url: 'https://billing.example.com/invoices',
        timestamp: BASE + 4000,
        action: 'Clicked "£1,284.00"',
        stepNumber: 2,
        element: {
          tag: 'td',
          text: '£1,284.00',
          cssSelector: '#invoice-9-total',
          xpath: '//td',
          boundingBox: null,
        },
      },
    ],
  };
}

/** A recording that captured none of the three layers, so each is named as absent. */
function blindFlow() {
  return {
    id: 'flow-blind',
    name: 'Nothing captured',
    timestamp: BASE,
    startUrl: 'https://billing.example.com/invoices',
    omitted: ['network'],
    state: { read: false, stores: [], note: 'State capture was off.' },
    renders: { read: false, note: 'Render sampling was off.' },
    steps: [
      {
        type: 'click',
        url: 'https://billing.example.com/invoices',
        timestamp: BASE + 1000,
        action: 'Clicked "Refresh"',
        stepNumber: 1,
        element: { tag: 'button', text: 'Refresh', cssSelector: '#refresh', xpath: '//button', boundingBox: null },
      },
    ],
  };
}

/**
 * A recording that sampled everything and was *sent* without it.
 *
 * Deliberately not `blindFlow`: that one has capture switched off, which is a
 * fact about the recording. This one is the case that actually happens — React
 * unchecked in the send dialog — where the recording is intact and the copy on
 * disk is not, and the two must not produce the same sentence.
 */
function withheldFlow() {
  return {
    id: 'flow-withheld',
    name: 'Sent without React',
    timestamp: BASE,
    startUrl: 'https://billing.example.com/invoices',
    omitted: ['react'],
    steps: [
      {
        type: 'click',
        url: 'https://billing.example.com/invoices',
        timestamp: BASE + 1000,
        action: 'Clicked "Refresh"',
        stepNumber: 1,
        element: { tag: 'button', text: 'Refresh', cssSelector: '#refresh', xpath: '//button', boundingBox: null },
      },
    ],
  };
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-provenance-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  server = await startServer({ home });
  writeFlow(home, travellingFlow());
  writeFlow(home, blindFlow());
  writeFlow(home, withheldFlow());
}, 30_000);

afterAll(() => {
  server?.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a value that travels through the four layers', () => {
  it('is reachable at all — the previous attempt at this was never wired', async () => {
    /*
     * `tools/list` and not only a call. The v3.2.0 failure was a tool that was
     * never declared, and a switch case answers a call whether or not anything
     * ever advertised the name — so a test that only calls it passes against
     * precisely the bug this feature was rebuilt to avoid. Both halves, because
     * either alone is green while the other is broken.
     */
    const listed = await server.tools();
    expect(listed).toContain('get_value_provenance');

    const answer = await call('get_value_provenance', { id: 'flow-value', value: '£1,284.00' });
    expect(answer).not.toContain('no tool named');
    expect(answer).toContain('Where "£1,284.00" came from');
  });

  it('names the response, the store, the component and the element', async () => {
    const answer = await call('get_value_provenance', { id: 'flow-value', value: '£1,284.00' });

    // The pointer, with the `/` inside the key escaped as `~1`. A pointer that
    // did not escape it addresses a path that does not exist, and does it
    // silently — the string still looks like a pointer.
    expect(answer).toContain('GET https://api.example.com/v1/invoices  /invoices/0/amount~1gross');
    expect(answer).toContain('redux:0  /invoices/0/total');
    // The component id resolved to the name it was written under: an id alone
    // is unreadable, and the flow already knows the name.
    expect(answer).toContain('InvoiceRow (cmp_row)  prop total');
    expect(answer).toContain('#invoice-9-total');
  });

  it('reports the layers in the order data flows, and says that is not a claim', async () => {
    const answer = await call('get_value_provenance', { id: 'flow-value', value: '£1,284.00' });

    const response = answer.indexOf('response — what the server sent');
    const store = answer.indexOf('store — what the app wrote down');
    const render = answer.indexOf('render — what a component was handed');
    const dom = answer.indexOf('dom — what the page showed');

    expect(response).toBeGreaterThan(-1);
    expect(response).toBeLessThan(store);
    expect(store).toBeLessThan(render);
    expect(render).toBeLessThan(dom);

    /*
     * The order reads as a journey, which is exactly why the reply has to say
     * it is not one. Without this sentence a model reads four ordered layers as
     * a derivation and reports it as one.
     */
    expect(answer).toContain('DevFlow did not watch this value move');
    expect(answer).toContain('Two sightings in adjacent layers are two sightings and not a link');
  });

  it('traces what a step showed when given a step instead of a value', async () => {
    // A recording has no node ids — an element is described, not addressed —
    // so this is the closest thing to the "DOM node" the feature was planned
    // around, and it has to actually work rather than being documented away.
    const answer = await call('get_value_provenance', { id: 'flow-value', step: 2 });

    expect(answer).toContain('Where "£1,284.00" came from');
    expect(answer).toContain('traced from step 2');
    expect(answer).toContain('GET https://api.example.com/v1/invoices');
  });

  it('lists the steps worth asking about when given neither', async () => {
    /*
     * `get_causal_chain`'s discipline: a tool whose first answer is "that is
     * not valid" has made the caller guess. The caller is looking at a
     * walkthrough and needs to know which of the things on it this recording
     * can speak to.
     */
    const answer = await call('get_value_provenance', { id: 'flow-value' });

    expect(answer).toContain('Values this recording can trace');
    expect(answer).toMatch(/step 1\s+Refresh/);
    expect(answer).toMatch(/step 2\s+£1,284\.00/);
  });
});

describe('the claims it refuses to make', () => {
  it('warns that a short value collides, before the findings rather than after', async () => {
    const answer = await call('get_value_provenance', { id: 'flow-value', value: '9' });

    const caution = answer.indexOf('as likely to be a coincidence as a sighting');
    expect(caution).toBeGreaterThan(-1);

    /*
     * Position is the assertion. A reader who has already read a multi-layer
     * answer has drawn the conclusion, and a caveat underneath it arrives too
     * late to be the thing that stops them.
     */
    const firstLayer = answer.indexOf('— what the server sent');
    if (firstLayer > -1) expect(caution).toBeLessThan(firstLayer);
  });

  it('does not call a distinctive value short', async () => {
    const answer = await call('get_value_provenance', { id: 'flow-value', value: '£1,284.00' });
    expect(answer).not.toContain('as likely to be a coincidence as a sighting');
  });

  it('names a layer the recording never captured instead of leaving it absent', async () => {
    const answer = await call('get_value_provenance', { id: 'flow-blind', value: 'Refresh' });

    /*
     * The single most important behaviour here. "The value is not in a
     * response" and "this recording has no responses" look identical as an
     * absent section, and a reader who cannot tell them apart takes the first —
     * which is a claim about the server, made out of a setting.
     */
    expect(answer).toContain('Not searched, because this recording carries nothing for it');
    expect(answer).toContain('sent without its network calls');
    expect(answer).toContain('did not read the app’s state');
    expect(answer).toContain('did not sample renders');

    // And the one layer it could search still answers.
    expect(answer).toContain('#refresh');
  });

  it('does not report a withheld send option as a recording that never sampled', async () => {
    const answer = await call('get_value_provenance', { id: 'flow-withheld', value: 'Refresh' });

    /*
     * `buildPayload` drops the render sample along with the React component
     * table whenever React is unchecked in the send dialog — every entry is
     * keyed by a component id the payload would no longer resolve. So a
     * recording that sampled renders perfectly arrives with none, and the
     * sentence "this recording did not sample renders" is a fact about the
     * recording manufactured from a checkbox. The response layer got this
     * right; the render layer, one branch below it, did not.
     */
    expect(answer).toContain('sent without its React data');
    expect(answer).not.toContain('did not sample renders');
  });

  it('says a value was not found without implying it was never there', async () => {
    const answer = await call('get_value_provenance', {
      id: 'flow-value',
      value: 'a string this recording never held',
    });

    expect(answer).toContain('It was not found in any layer this recording carries');
    expect(answer).toContain('a flow captures what it was configured to capture');
  });

  it('refuses a step that showed nothing, and says what to do instead', async () => {
    const answer = await call('get_value_provenance', { id: 'flow-value', step: 9 });
    expect(answer).toContain('has no step 9');
  });
});
