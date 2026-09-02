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
 *
 * ## The fifth layer
 *
 * Work Stream 3.2 adds `backend`, and it is the one layer that is not another
 * way of looking at this recording: the spans arrived from the user's own
 * service, and are attached to a call by the 128-bit trace id DevFlow minted
 * and the backend echoed. That makes it two claims of very different strength
 * living in one reply — a *path* is a known attachment, a *hit* inside a span
 * is a sighting as weak as the other four — and the assertions below are mostly
 * about the two not borrowing each other's authority.
 *
 * A second server is spawned with `DEVFLOW_OTEL=1` and real OTLP/JSON is POSTed
 * to its `/v1/traces`, because every part of this that could be got wrong is on
 * the far side of that endpoint. The delivery envelopes are the capture in
 * `arkg-otel.test.ts` — spans arriving leaf-first across separate requests, a
 * root whose parent never arrives, unix-nanosecond *strings* — reused rather
 * than re-derived, which is this repository's standing rule about foreign wire
 * formats. What is varied inside them is measured too: `hand` is the
 * hand-instrumented service the roadmap describes, with `code.filepath` on the
 * controller, and `auto` is what `@opentelemetry/auto-instrumentations-node`
 * actually produces — four levels deep with a framework span in the middle, a
 * route for a name, a knex span named after an absolute path on somebody's
 * disk, and no `code.filepath` anywhere, because essentially no automatic Node
 * instrumentation records one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

const BASE = Date.UTC(2026, 8, 1, 11, 0);

let home: string;
let server: McpSession;

/** The second server, with span ingest on, and the flows that need one. */
let tracedHome: string;
let traced: McpSession;

const call = (name: string, args: Record<string, unknown>): Promise<string> =>
  server.call(name, args);

const tracedCall = (name: string, args: Record<string, unknown>): Promise<string> =>
  traced.call(name, args);

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

// ── The backend layer ────────────────────────────────────────────────────────

/** DevFlow's own `traceparent`, echoed by a hand-instrumented service. */
const HAND = '4bf92f3577b34da6a3ce929d0e0e4736';
/** The same, for a service running automatic instrumentation and nothing else. */
const AUTO = '9c1d6a7b2e8f403cab55d0e0e4736001';
/** A header that went out and that no span has ever come back under. */
const AWAITED = '17e2b0c9d4a54f6182ab7c3d5e6f7081';
/** The one traced call of `flow-awaiting`, whose spans likewise never arrive. */
const NEVER = 'c4d5e6f708192a3b4c5d6e7f80912a3b';

/** The resource every delivery repeats. `deployment.environment` is the old spelling. */
const RESOURCE = {
  attributes: [
    { key: 'service.name', value: { stringValue: 'checkout-api' } },
    { key: 'service.version', value: { stringValue: '2.4.1' } },
    { key: 'deployment.environment', value: { stringValue: 'staging' } },
  ],
  droppedAttributesCount: 0,
};

/**
 * One `ExportTraceServiceRequest`, shaped exactly as a Node exporter writes it.
 *
 * One span per delivery, because that is how the capture arrived: a span is
 * exported when it *ends*, so a child is delivered before its parent and the
 * store has to assemble a tree out of requests that arrive in no useful order.
 */
const delivery = (span: Record<string, unknown>): string =>
  JSON.stringify({
    resourceSpans: [
      { resource: RESOURCE, scopeSpans: [{ scope: { name: 'probe' }, spans: [span] }] },
    ],
  });

const span = (fields: Record<string, unknown>): Record<string, unknown> => ({
  attributes: [],
  droppedAttributesCount: 0,
  events: [],
  droppedEventsCount: 0,
  status: { code: 0 },
  links: [],
  droppedLinksCount: 0,
  flags: 257,
  ...fields,
});

/**
 * A knex `db.query.text` far longer than one line of an answer.
 *
 * Not padding for its own sake: a statement is untrusted text from an endpoint
 * that cannot be authenticated, and the whole reason every line in the renderer
 * is capped is that one of these can be 200KB. It deliberately does **not**
 * carry the traced value, so the path below it is earned by the response body
 * and no hop is marked — which is the case a marker on every hop would hide.
 */
const LONG_STATEMENT =
  'select `invoices`.* from `invoices` inner join `customers` on `customers`.`id` = ' +
  '`invoices`.`customer_id` where `invoices`.`status` = ? and `customers`.`region` in ' +
  `(${Array.from({ length: 60 }, (_, i) => `'region-${i}'`).join(', ')}) order by ` +
  '`invoices`.`issued_at` desc limit ?';

/**
 * The hand-instrumented chain the roadmap describes, leaf-first.
 *
 * Three spans, and the root's parent is `00f067aa0ba902b7` — the span id out of
 * DevFlow's own `traceparent`, which will never arrive because DevFlow emits no
 * spans. A tree builder that looked for `parentSpanId === null` would find no
 * root here at all, which is why the capture is reused rather than tidied.
 *
 * The query inlines the value. That is the roadmap's case exactly: the browser
 * never saw a body carrying `£1,284.00`, and the backend's own tracer did.
 */
const HAND_DELIVERIES: string[] = [
  delivery(
    span({
      traceId: HAND,
      spanId: '29abc6b630d1e717',
      parentSpanId: 'e014090292b7a0de',
      name: 'SELECT invoices',
      kind: 3,
      startTimeUnixNano: '1788364167355000000',
      endTimeUnixNano: '1788364167355043667',
      attributes: [
        { key: 'db.system.name', value: { stringValue: 'postgresql' } },
        { key: 'db.namespace', value: { stringValue: 'shop' } },
        {
          key: 'db.query.text',
          value: { stringValue: "SELECT id FROM invoices WHERE total_amount = '£1,284.00'" },
        },
        { key: 'db.collection.name', value: { stringValue: 'invoices' } },
      ],
    }),
  ),
  delivery(
    span({
      traceId: HAND,
      spanId: 'e014090292b7a0de',
      parentSpanId: '7cb4a6ed1dd21e14',
      name: 'InvoiceService.list',
      kind: 1,
      startTimeUnixNano: '1788364167355000000',
      endTimeUnixNano: '1788364167362472291',
    }),
  ),
  delivery(
    span({
      traceId: HAND,
      spanId: '7cb4a6ed1dd21e14',
      parentSpanId: '00f067aa0ba902b7',
      name: 'GET /api/v1/invoices',
      kind: 2,
      startTimeUnixNano: '1788364167355000000',
      endTimeUnixNano: '1788364167362949250',
      flags: 769,
      attributes: [
        { key: 'http.request.method', value: { stringValue: 'GET' } },
        { key: 'url.path', value: { stringValue: '/api/v1/invoices' } },
        { key: 'http.response.status_code', value: { intValue: 200 } },
        // The roadmap's "Controller Handler: invoice_controller.py:45". It is
        // here because somebody instrumented by hand — see `AUTO_DELIVERIES`.
        { key: 'code.filepath', value: { stringValue: 'app/controllers/invoice_controller.py' } },
        { key: 'code.lineno', value: { intValue: 45 } },
        { key: 'code.function', value: { stringValue: 'list_invoices' } },
      ],
    }),
  ),
];

/**
 * What automatic instrumentation actually produces, measured.
 *
 * Four levels counting the call the browser made: an http server span named
 * after the *route*, an express span under it, and the database span under
 * *that* rather than under the server span. No `code.filepath` anywhere, a knex
 * span named after an absolute path on the machine that ran it, and a statement
 * longer than one line of an answer.
 */
const AUTO_DELIVERIES: string[] = [
  delivery(
    span({
      traceId: AUTO,
      spanId: 'aa11bb22cc33dd44',
      parentSpanId: 'bb22cc33dd44ee55',
      name: 'first /tmp/devflow-measure-invoices.db.invoices',
      kind: 3,
      startTimeUnixNano: '1788364168100000000',
      endTimeUnixNano: '1788364168100931000',
      attributes: [
        { key: 'db.system.name', value: { stringValue: 'sqlite' } },
        { key: 'db.query.text', value: { stringValue: LONG_STATEMENT } },
      ],
    }),
  ),
  delivery(
    span({
      traceId: AUTO,
      spanId: 'bb22cc33dd44ee55',
      parentSpanId: 'cc33dd44ee55ff66',
      name: 'request handler - /api/v1/invoices/:id',
      kind: 1,
      startTimeUnixNano: '1788364168099000000',
      endTimeUnixNano: '1788364168102400000',
    }),
  ),
  delivery(
    span({
      traceId: AUTO,
      spanId: 'cc33dd44ee55ff66',
      parentSpanId: '00f067aa0ba902b7',
      name: 'GET /api/v1/invoices/:id',
      kind: 2,
      startTimeUnixNano: '1788364168098000000',
      endTimeUnixNano: '1788364168103000000',
      flags: 769,
      attributes: [
        { key: 'http.request.method', value: { stringValue: 'GET' } },
        { key: 'url.path', value: { stringValue: '/api/v1/invoices/8814' } },
        { key: 'http.route', value: { stringValue: '/api/v1/invoices/:id' } },
        { key: 'http.response.status_code', value: { intValue: 200 } },
      ],
    }),
  ),
];

/**
 * An N+1 query, and five traced calls, because the caps are where the finding is.
 *
 * A trace is not bounded by anything on this machine: one recorded click can be
 * four hundred spans of a handler issuing a query per row. The renderer prints
 * twelve of them and counts the rest, and the count is not an apology for the
 * cap — "and 9 more" is the whole finding, and a chain cut to twelve with
 * nothing said about the remainder reads as a handler that issued one query.
 * Five calls for the same reason one level up: four paths are printed and the
 * fifth is counted.
 */
const N1_TRACE = 'd1e2f30411223344556677889900aabb';
const N1_CALLS = 5;
const N1_QUERIES = 20;

const nplusOne = (): string[] => {
  const out = [
    delivery(
      span({
        traceId: N1_TRACE,
        spanId: 'd100000000000001',
        parentSpanId: '00f067aa0ba902b7',
        name: 'GET /api/v1/report',
        kind: 2,
        startTimeUnixNano: '1788364169000000000',
        endTimeUnixNano: '1788364169400000000',
        flags: 769,
        attributes: [
          { key: 'http.request.method', value: { stringValue: 'GET' } },
          { key: 'url.path', value: { stringValue: '/api/v1/report' } },
          { key: 'http.response.status_code', value: { intValue: 200 } },
        ],
      }),
    ),
  ];
  for (let i = 0; i < N1_QUERIES; i++) {
    out.push(
      delivery(
        span({
          traceId: N1_TRACE,
          spanId: `d1000000000001${String(i).padStart(2, '0')}`,
          parentSpanId: 'd100000000000001',
          name: 'SELECT lines',
          kind: 3,
          startTimeUnixNano: `17883641690${String(10 + i).padStart(2, '0')}00000`,
          endTimeUnixNano: `17883641690${String(10 + i).padStart(2, '0')}90000`,
          attributes: [
            { key: 'db.system.name', value: { stringValue: 'postgresql' } },
            {
              key: 'db.query.text',
              value: { stringValue: `SELECT amount FROM lines WHERE invoice_id = $1 -- row ${i}` },
            },
          ],
        }),
      ),
    );
  }
  return out;
};

/** The other four traced calls of `flow-n1`, one span each. */
const N1_SIBLINGS = (): string[] =>
  Array.from({ length: N1_CALLS - 1 }, (_, i) =>
    delivery(
      span({
        traceId: `e${String(i)}e2f30411223344556677889900aabb`,
        spanId: `e${String(i)}00000000000001`,
        parentSpanId: '00f067aa0ba902b7',
        name: `GET /api/v1/aside/${i}`,
        kind: 2,
        startTimeUnixNano: '1788364169500000000',
        endTimeUnixNano: '1788364169501000000',
        flags: 769,
        attributes: [
          { key: 'http.request.method', value: { stringValue: 'GET' } },
          { key: 'url.path', value: { stringValue: `/api/v1/aside/${i}` } },
          { key: 'http.response.status_code', value: { intValue: 200 } },
        ],
      }),
    ),
  );

const N1_DELIVERIES: string[] = [...nplusOne(), ...N1_SIBLINGS()];

const netCall = (fields: Record<string, unknown>) => ({
  method: 'GET',
  requestHeaders: {},
  requestBody: null,
  status: 200,
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: null,
  durationMs: 42,
  timestamp: BASE + 1050,
  ...fields,
});

/**
 * The value reaches the screen and the browser never saw a body carrying it.
 *
 * `£1,284.00` is in the element's text and in the query the backend ran, and
 * nowhere in between — so the only reason a chain can be printed for it is the
 * trace id, which is the whole point of the layer. The second call is traced
 * and its spans never arrive: a recording is usually partly joined, and the
 * three that did join must not read as the whole backend story.
 */
function handFlow() {
  return {
    id: 'flow-hand',
    name: 'Invoice total, traced',
    timestamp: BASE,
    startUrl: 'https://billing.example.com/invoices',
    steps: [
      {
        type: 'click',
        url: 'https://billing.example.com/invoices',
        timestamp: BASE + 1000,
        action: 'Clicked "Refresh"',
        stepNumber: 1,
        element: { tag: 'button', text: 'Refresh', cssSelector: '#refresh', xpath: '//button', boundingBox: null },
        networkCalls: [
          netCall({
            url: 'https://api.example.com/v1/invoices',
            traceId: HAND,
            responseBody: JSON.stringify({ ok: true }),
          }),
          netCall({
            url: 'https://api.example.com/v1/audit',
            traceId: AWAITED,
            responseBody: JSON.stringify({ ok: true }),
          }),
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

/**
 * The other direction: the body carried the value and no span mentions it.
 *
 * A path is still printed, because the call is one the value was seen at — and
 * no hop under it is marked, which is the honest rendering of "these spans are
 * the work behind that call" with no sighting inside any of them.
 *
 * `stepNumber` is 7 on a one-step recording deliberately. `get_backend_trace`
 * used to filter on a step's *position* and print its own number, so a flow
 * whose numbers do not match its positions answered about one step and named
 * another. Nothing catches that unless a fixture disagrees with itself.
 */
function autoFlow() {
  return {
    id: 'flow-auto',
    name: 'Invoice detail, auto-instrumented',
    timestamp: BASE,
    startUrl: 'https://billing.example.com/invoices/8814',
    steps: [
      {
        type: 'click',
        url: 'https://billing.example.com/invoices/8814',
        timestamp: BASE + 1000,
        action: 'Clicked "Open"',
        stepNumber: 7,
        element: { tag: 'a', text: 'Open', cssSelector: '#open-8814', xpath: '//a', boundingBox: null },
        networkCalls: [
          netCall({
            url: 'https://api.example.com/v1/invoices/8814',
            traceId: AUTO,
            responseBody: JSON.stringify({ invoice: { id: 8814, total: '£99.00' } }),
          }),
        ],
      },
    ],
  };
}

/** Span ingest is on, and no call in this recording ever carried a header. */
function untracedFlow() {
  return {
    id: 'flow-untraced',
    name: 'No trace headers',
    timestamp: BASE,
    startUrl: 'https://billing.example.com/invoices',
    steps: [
      {
        type: 'click',
        url: 'https://billing.example.com/invoices',
        timestamp: BASE + 1000,
        action: 'Clicked "Refresh"',
        stepNumber: 1,
        element: { tag: 'button', text: 'Refresh', cssSelector: '#refresh', xpath: '//button', boundingBox: null },
        networkCalls: [
          netCall({
            url: 'https://api.example.com/v1/invoices',
            responseBody: JSON.stringify({ total: '£1,284.00' }),
          }),
        ],
      },
    ],
  };
}

/** Five traced calls, all joined, all carrying the value in their bodies. */
function nPlusOneFlow() {
  return {
    id: 'flow-n1',
    name: 'Report, one query per row',
    timestamp: BASE,
    startUrl: 'https://billing.example.com/report',
    steps: [
      {
        type: 'click',
        url: 'https://billing.example.com/report',
        timestamp: BASE + 1000,
        action: 'Clicked "Report"',
        stepNumber: 1,
        element: { tag: 'button', text: 'Report', cssSelector: '#report', xpath: '//button', boundingBox: null },
        networkCalls: [
          netCall({
            url: 'https://api.example.com/v1/report',
            traceId: N1_TRACE,
            responseBody: JSON.stringify({ total: '£55.00' }),
          }),
          ...Array.from({ length: N1_CALLS - 1 }, (_, i) =>
            netCall({
              /*
               * A recorded url is untrusted too — `POST /flows` accepts a flow
               * from any page the browser happens to visit — so the line naming
               * the call is capped like the lines under it. One of the five is
               * absurd on purpose; capping only what came from a span would
               * leave the header of each block as the way through.
               */
              url: `https://api.example.com/v1/aside/${i}${i === 0 ? `?${'pad'.repeat(140)}` : ''}`,
              traceId: `e${String(i)}e2f30411223344556677889900aabb`,
              responseBody: JSON.stringify({ total: '£55.00' }),
            }),
          ),
        ],
      },
    ],
  };
}

/** The header went out and nothing has come back under it — the third nothing. */
function awaitingFlow() {
  return {
    id: 'flow-awaiting',
    name: 'Header sent, spans pending',
    timestamp: BASE,
    startUrl: 'https://billing.example.com/invoices',
    steps: [
      {
        type: 'click',
        url: 'https://billing.example.com/invoices',
        timestamp: BASE + 1000,
        action: 'Clicked "Refresh"',
        stepNumber: 1,
        element: { tag: 'button', text: 'Refresh', cssSelector: '#refresh', xpath: '//button', boundingBox: null },
        networkCalls: [
          netCall({
            url: 'https://api.example.com/v1/invoices',
            traceId: NEVER,
            responseBody: JSON.stringify({ total: '£1,284.00' }),
          }),
        ],
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

  /*
   * The second server, and the spans, delivered before anything asks for them.
   *
   * `POST /v1/traces` is the real endpoint and the deliveries go through it
   * rather than into the store by hand, because everything between the wire and
   * the answer — the environment gate, the OTLP read, the store, the join — is
   * exactly what a mistake here would live in. They are posted at the wall
   * clock rather than at `BASE`, since the store's retention is measured from
   * when a span was *received* and a fixture dated outside the window is swept
   * before it can be read.
   */
  tracedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-provenance-otel-'));
  fs.mkdirSync(path.join(tracedHome, 'flows'), { recursive: true });
  traced = await startServer({ home: tracedHome, env: { DEVFLOW_OTEL: '1' } });
  writeFlow(tracedHome, handFlow());
  writeFlow(tracedHome, autoFlow());
  writeFlow(tracedHome, untracedFlow());
  writeFlow(tracedHome, awaitingFlow());
  writeFlow(tracedHome, nPlusOneFlow());

  for (const body of [...HAND_DELIVERIES, ...AUTO_DELIVERIES, ...N1_DELIVERIES]) {
    const response = await traced.post('/v1/traces', body);
    // A 404 here is the environment gate, and it would otherwise surface as
    // every backend assertion below failing for a reason none of them name.
    expect(response.status).toBe(200);
  }
}, 30_000);

afterAll(() => {
  server?.stop();
  traced?.stop();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(tracedHome, { recursive: true, force: true });
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

// ── The fifth layer ──────────────────────────────────────────────────────────

describe('the chain behind a call, once spans have joined', () => {
  it('reaches from the call to the controller to the query', async () => {
    const answer = await tracedCall('get_value_provenance', {
      id: 'flow-hand',
      value: '£1,284.00',
    });

    expect(answer).toContain('the server-side work behind the calls it was seen at');
    // The join is the trace id, so the trace id is printed: it is the handle
    // somebody takes to their own tracing backend when they doubt the answer.
    expect(answer).toContain('trace 4bf92f3577b34da6a3ce929d0e0e4736 · checkout-api');

    /*
     * Indentation, asserted as text, because the shape *is* the answer: a query
     * three levels under the handler that answered the request is a different
     * fact from one the handler issued itself, and a flat list of the same three
     * operations reads as the second. The spans were delivered leaf-first, in
     * separate requests, with the root's parent never arriving at all — so this
     * also asserts that the tree was rebuilt rather than printed in arrival
     * order, which would put the SELECT first and at depth zero.
     */
    expect(answer).toContain('      - `checkout-api` GET /api/v1/invoices ·');
    expect(answer).toContain('        - `checkout-api` InvoiceService.list ·');
    expect(answer).toContain('          - `checkout-api` SELECT invoices ·');

    // The roadmap's "Controller Handler: invoice_controller.py:45", which is
    // what a hand-instrumented service gives and is printed where it exists.
    expect(answer).toContain('· app/controllers/invoice_controller.py:45');
  });

  it('prints the query as the tracer recorded it, and never rewrites it', async () => {
    const answer = await tracedCall('get_value_provenance', {
      id: 'flow-hand',
      value: '£1,284.00',
    });

    /*
     * Verbatim, quoting and all. Whether `db.query.text` carries a literal or a
     * `?` is the user's own instrumentation's decision, and showing them a
     * tidied query their database never saw would be the wrong kind of helpful
     * — it is the one string in the reply somebody may paste into a console.
     */
    expect(answer).toContain("SELECT id FROM invoices WHERE total_amount = '£1,284.00'");
  });

  it('marks the hop the value turned up in, and only that one', async () => {
    const answer = await tracedCall('get_value_provenance', {
      id: 'flow-hand',
      value: '£1,284.00',
    });

    /*
     * A chain of three operations with a sighting listed somewhere else leaves
     * the reader to guess which one carried it, and the guess they make is
     * "the query" — which is right here and would not be if the value were in
     * the request path. Marking the wrong hops is worse than marking none, so
     * the two lines above it are asserted clean.
     */
    expect(answer).toMatch(/- `checkout-api` SELECT invoices · [\d.]+ms \*\*carried the value\*\*/);
    expect(answer).not.toMatch(/GET \/api\/v1\/invoices ·[^\n]*carried the value/);
    expect(answer).not.toMatch(/InvoiceService\.list ·[^\n]*carried the value/);
  });

  it('keeps the known attachment and the weak search apart', async () => {
    const answer = await tracedCall('get_value_provenance', {
      id: 'flow-hand',
      value: '£1,284.00',
    });

    /*
     * The hardest sentence in this feature, and the reason `paths` is a
     * different thing from `hits`. Which call a span belongs to is *known* —
     * 128 bits DevFlow minted and the backend echoed. That this value appears
     * inside one of those spans is string equality and nothing more. A reply
     * that let the first lend its authority to the second would be claiming
     * DevFlow traced a value into a database, which it has never done.
     */
    expect(answer).toContain('known rather than guessed');
    expect(answer).toContain('still a sighting on the same terms as everything above');
    expect(answer).toContain('a span carries no response body');

    // And the sighting is filed with the other four layers, under their
    // caveat, rather than inside the section that carries the strong claim.
    const layer = answer.indexOf('backend — what the server-side work carried');
    const paths = answer.indexOf('the server-side work behind the calls it was seen at');
    expect(layer).toBeGreaterThan(-1);
    expect(layer).toBeLessThan(paths);
    expect(answer).toContain('The server-side work carried it in the query it ran');
  });

  it('never claims to have traced the value', async () => {
    const answer = await tracedCall('get_value_provenance', {
      id: 'flow-hand',
      value: '£1,284.00',
    });

    expect(answer).toContain('DevFlow did not watch this value move');
    expect(answer).toContain('Two sightings in adjacent layers are two sightings and not a link');
    // The fifth layer's own sentence, which scopes the strong claim to the
    // attachment and hands the search back the weakness of the other four.
    expect(answer).toContain('Which call those belong to is known rather than inferred');
    expect(answer).toContain('is a sighting like any other');

    // Nothing anywhere in the reply upgrades a sighting into a derivation.
    expect(answer).not.toMatch(/lineage|proves|proven|confirm(s|ed)|DevFlow traced/i);
  });

  it('prints what has not arrived beside what has, never instead of it', async () => {
    const answer = await tracedCall('get_value_provenance', {
      id: 'flow-hand',
      value: '£1,284.00',
    });

    /*
     * The recording carries two traced calls and one of them has joined. Three
     * of a recording's four calls rendering as the whole backend story is worse
     * than none of them rendering at all: the reader is looking at a complete
     * chain with no reason to doubt it. So both are said, in that order.
     */
    expect(answer).toContain('      - `checkout-api` GET /api/v1/invoices ·');
    expect(answer).toContain('1 traced call in this recording has no spans yet');
    expect(answer).toContain('part of this recording’s server-side work and not all of it');

    // And it is not reported as the recording having no backend data at all,
    // which is the wording reserved for a recording where nothing joined.
    expect(answer).not.toContain('no spans have arrived under');
  });
});

describe('a chain from automatic instrumentation, which looks different', () => {
  it('prints a path earned by the response body with no hop marked', async () => {
    const answer = await tracedCall('get_value_provenance', { id: 'flow-auto', value: '£99.00' });

    /*
     * The value is in the body and in none of the spans. The path is still
     * worth printing — it is the server-side work behind a call the value was
     * seen at — and marking a hop here would be inventing a sighting. Four
     * levels counting the call the browser made, with the framework span in
     * the middle: measured, not assumed. A database span's parent is the
     * express span, not the http server span.
     */
    expect(answer).toContain('  step 7  GET https://api.example.com/v1/invoices/8814');
    expect(answer).toContain('      - `checkout-api` GET /api/v1/invoices/:id ·');
    expect(answer).toContain('        - `checkout-api` request handler - /api/v1/invoices/:id ·');
    expect(answer).not.toContain('carried the value');
  });

  it('says why no file is named instead of letting it read as a gap', async () => {
    const answer = await tracedCall('get_value_provenance', { id: 'flow-auto', value: '£99.00' });

    /*
     * Measured: of the official Node auto-instrumentations essentially none
     * record `code.filepath` — not express, not http, not knex, pg or mysql2 —
     * so a chain with no file is the ordinary case rather than a failure. Left
     * unsaid it reads as "DevFlow could not find the handler", which sends a
     * reader to look for a fault in the recording instead of at their own
     * instrumentation, and only one of those two errands is the real one.
     */
    expect(answer).toContain('hardly any automatic Node instrumentation records code.filepath');

    // And it is not said about a recording that does name one, which would be
    // a caveat contradicting the line above it.
    const hand = await tracedCall('get_value_provenance', {
      id: 'flow-hand',
      value: '£1,284.00',
    });
    expect(hand).not.toContain('hardly any automatic Node instrumentation');
  });


  it('caps a span name and a statement that arrived from an unauthenticated endpoint', async () => {
    const answer = await tracedCall('get_value_provenance', { id: 'flow-auto', value: '£99.00' });

    /*
     * A knex span is named after an absolute path on whatever machine ran it,
     * and a statement can be 200KB. Every other renderer in the server caps its
     * lines because a span arrives from the one endpoint that cannot be
     * authenticated — the sender is the user's own collector, which has no
     * extension origin and never will — and this one has to as well.
     */
    expect(answer).toContain('first /tmp/devflow-measure-invoices.db.invoices');
    expect(answer).toContain('chars total]');
    expect(answer).not.toContain("'region-59'");
  });
});

describe('an N+1 query, where the count is the finding', () => {
  it('counts the operations and the calls it did not print', async () => {
    const answer = await tracedCall('get_value_provenance', { id: 'flow-n1', value: '£55.00' });

    /*
     * The count is the finding. Twenty-one operations under one trace is a
     * handler issuing a query per row, and a reader who is shown twelve of them
     * with nothing said about the rest has been shown a different application
     * from the one that ran. The same one level up: the fifth traced call the
     * value was seen at is counted rather than dropped in silence.
     */
    expect(answer).toContain('… 9 more operations under this trace');
    /*
     * The line naming the call is capped on the same terms as the hops beneath
     * it — in **both** places it appears. Counted rather than matched once,
     * because the response layer prints that same url a few lines above and its
     * own `truncate` satisfies a `toContain` on its own: the assertion that
     * looked like it covered the path section was being answered by a different
     * renderer entirely.
     */
    expect(answer.match(/aside\/0\?(?:pad)+… \[\d+ chars total\]/g)).toHaveLength(2);
    expect(answer).toContain('… 1 more traced call the value was seen at');
    // Twelve printed and no more, so the cap is a cap rather than a coincidence.
    expect(answer.match(/- `checkout-api` SELECT lines ·/g)).toHaveLength(11);
  });
});

describe('the backend’s three nothings, kept apart', () => {
  /*
   * Three errands, not three wordings of one. Ingest off is a flag on this
   * server; no traced call is a switch in the extension and a recording made
   * again; spans not having arrived is the user's exporter, and is the one
   * where DevFlow's side is already correct. A reader sent to the wrong one
   * goes and changes a setting that was not the problem, so each answer is
   * asserted to carry its own reason and neither of the others.
   */
  const INGEST_OFF = 'Span ingest is off on this server';
  const NEVER_TRACED = 'No call in this recording carried a trace id';
  const NOT_ARRIVED = 'no spans have arrived under its id';

  it('says ingest is off when the server was started without it', async () => {
    const answer = await call('get_value_provenance', { id: 'flow-value', value: '£1,284.00' });

    expect(answer).toContain(INGEST_OFF);
    expect(answer).toContain('DEVFLOW_OTEL=1');
    expect(answer).not.toContain(NEVER_TRACED);
    expect(answer).not.toContain(NOT_ARRIVED);
  });

  it('says no header went out when ingest is on and nothing was traced', async () => {
    const answer = await tracedCall('get_value_provenance', {
      id: 'flow-untraced',
      value: '£1,284.00',
    });

    expect(answer).toContain(NEVER_TRACED);
    expect(answer).not.toContain(INGEST_OFF);
    expect(answer).not.toContain(NOT_ARRIVED);
  });

  it('says the spans have not arrived when the header did go out', async () => {
    const answer = await tracedCall('get_value_provenance', {
      id: 'flow-awaiting',
      value: '£1,284.00',
    });

    expect(answer).toContain('This recording carries 1 traced call, and ' + NOT_ARRIVED);
    expect(answer).not.toContain(INGEST_OFF);
    expect(answer).not.toContain(NEVER_TRACED);
  });
});

describe('get_backend_trace, which shares the same reckoning of a step', () => {
  it('prints a span tree at all', async () => {
    /*
     * It never had. `readFlow` returns `{ dir, json }` and the tool handed that
     * wrapper to a function that reads `.steps` off it, so every recording
     * there has ever been came back "no call carried a trace id" — the same
     * sentence as the common correct answer, which is why nothing noticed.
     */
    const answer = await tracedCall('get_backend_trace', { id: 'flow-hand' });

    expect(answer).toContain('## Backend trace — Invoice total, traced');
    expect(answer).toContain('- `checkout-api` SELECT invoices ·');
    expect(answer).not.toContain('No call in this recording carried a trace id');
  });

  it('prints a long statement in full where get_value_provenance cuts it', async () => {
    /*
     * The two tools cap at different lengths on purpose, and that is a decision
     * rather than an oversight. `get_value_provenance` prints a dozen lines
     * across five layers and a statement is one of them, so it is cut at a line
     * of an answer; `get_backend_trace` exists to show the query, so the cut is
     * far enough out to be a guard against a 200KB attribute rather than a
     * summary. Without this assertion the second cap could be tightened to the
     * first and every test still pass.
     */
    const whole = await tracedCall('get_backend_trace', { id: 'flow-auto', step: 7 });
    expect(whole).toContain("'region-59'");
    expect(whole).not.toContain('chars total]');

    const capped = await tracedCall('get_value_provenance', { id: 'flow-auto', value: '£99.00' });
    expect(capped).not.toContain("'region-59'");
    expect(capped).toContain('chars total]');
  });

  it('filters on the number the recording gives a step, not on its position', async () => {
    /*
     * The reason `tracedCallsOf` is one function in `core/otel` rather than two
     * copies. The server's own copy numbered steps by position while every
     * renderer beside it prefers the step's own `stepNumber`, so a recording
     * whose numbers do not match its positions filtered on one and printed the
     * other: `flow-auto` has a single step numbered 7, and the two calls below
     * used to give exactly the wrong pair of answers.
     */
    const seven = await tracedCall('get_backend_trace', { id: 'flow-auto', step: 7 });
    expect(seven).toContain('### Step 7 — GET /v1/invoices/8814');
    expect(seven).toContain('first /tmp/devflow-measure-invoices.db.invoices');

    const one = await tracedCall('get_backend_trace', { id: 'flow-auto', step: 1 });
    expect(one).toContain('No call in step 1 carried a trace id');
    expect(one).toContain('Traced calls in this recording are in step(s) 7');
  });
});
