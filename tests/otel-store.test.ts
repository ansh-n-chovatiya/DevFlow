/**
 * The span holding store, against a real SQLite database.
 *
 * `src/core/otel` is covered by its own suite because it is pure. What is left
 * for this one is everything that is *not* a decision: the environment gate,
 * the four HTTP answers, the primary key that makes a retry a duplicate, the
 * two caps, and the one storage property that cannot be checked by reading the
 * code — that a unix-nanosecond timestamp survives a round trip through SQLite
 * without a JS `number` ever touching it.
 *
 * The payloads below are the real ones. They were captured off a throwaway
 * service built with `@opentelemetry/sdk-trace-node` and pointed at a capturing
 * endpoint, and they are transcribed rather than invented — including the parts
 * that would not have been guessed: `flags`, the empty `attributes` arrays, the
 * `deployment.environment` spelling that the semantic conventions have since
 * superseded, and the leaf-first delivery order. The protobuf body is the real
 * bytes of the same exporter's default encoding, as hex.
 *
 * `mcp-server/` is a second npm package with its own dependencies and no types,
 * so it is reached through a dynamic import of a file URL and given the shape it
 * is used at. `better-sqlite3` resolves from `mcp-server/node_modules`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ── The modules under test ───────────────────────────────────────────────────

interface Statement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number };
}

interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
}

interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  service: string;
  serviceVersion: string | null;
  environment: string | null;
  startUnixNano: string;
  durationMs: number;
  failed: boolean;
  statusMessage: string | null;
  http: { method: string | null; path: string | null; status: number | null } | null;
  db: { system: string | null; statement: string | null; collection: string | null } | null;
  code: { file: string; line: number | null } | null;
  exception: { type: string | null; message: string | null } | null;
}

interface Response {
  status: number;
  body: Record<string, unknown>;
}

interface Otel {
  OTEL_ENABLED: boolean;
  openSpanStore(dbPath: string): Db | null;
  closeSpanStore(): void;
  storeSpans(spans: OtelSpan[], receivedAtMs?: number): { stored: number; duplicates: number };
  spansForTraces(traceIds: string[]): OtelSpan[];
  spanStoreStats(): { spans: number; traces: number; oldestMs: number | null; newestMs: number | null };
  pruneSpanStore(now?: number): { removed: number };
  handleOtlpPost(bodyText: string, contentType?: string): Response;
}

interface Core {
  readOtlpTraces(body: unknown): { spans: OtelSpan[] } & { rejected?: string };
  buildSpanTree(spans: readonly OtelSpan[]): { span: OtelSpan; children: unknown[]; depth: number }[];
  joinTrace(input: {
    calls: { traceId: string; step: number; method: string; url: string }[];
    spans: readonly OtelSpan[];
  }): { joined: { services: string[]; spans: OtelSpan[]; roots: unknown[] }[]; awaiting: string[]; unrelated: string[] };
  projectTrace(join: unknown): {
    services: { name: string }[];
    operations: { name: string; service: string }[];
    edges: { type: string }[];
  };
}

const otel = (await import(
  /* @vite-ignore */ new URL('../mcp-server/otel.js', import.meta.url).href
)) as unknown as Otel;

const core = (await import(
  /* @vite-ignore */ new URL('../mcp-server/core.js', import.meta.url).href
)) as unknown as Core;

// ── The real capture ─────────────────────────────────────────────────────────

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

/** The resource every delivery repeated. `deployment.environment` is the old spelling. */
const RESOURCE = {
  attributes: [
    { key: 'service.name', value: { stringValue: 'checkout-api' } },
    { key: 'service.version', value: { stringValue: '2.4.1' } },
    { key: 'deployment.environment', value: { stringValue: 'staging' } },
  ],
  droppedAttributesCount: 0,
};

const delivery = (span: Record<string, unknown>) => ({
  resourceSpans: [
    { resource: RESOURCE, scopeSpans: [{ scope: { name: 'probe' }, spans: [span] }] },
  ],
});

/**
 * The four deliveries, in the order they arrived.
 *
 * Leaf first: the `SELECT` at depth three came in first and the server span
 * that caused it came in third. Nothing here may assume otherwise.
 */
const DELIVERIES = [
  delivery({
    traceId: TRACE,
    spanId: '29abc6b630d1e717',
    parentSpanId: 'e014090292b7a0de',
    name: 'SELECT invoices',
    kind: 3,
    startTimeUnixNano: '1788364167355000000',
    endTimeUnixNano: '1788364167355043667',
    attributes: [
      { key: 'db.system.name', value: { stringValue: 'postgresql' } },
      { key: 'db.namespace', value: { stringValue: 'shop' } },
      { key: 'db.query.text', value: { stringValue: 'SELECT total_amount FROM invoices WHERE id = $1' } },
      { key: 'db.collection.name', value: { stringValue: 'invoices' } },
    ],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    status: { code: 0 },
    links: [],
    droppedLinksCount: 0,
    flags: 769,
  }),
  delivery({
    traceId: TRACE,
    spanId: 'e014090292b7a0de',
    parentSpanId: '7cb4a6ed1dd21e14',
    name: 'InvoiceService.list',
    kind: 1,
    startTimeUnixNano: '1788364167355000000',
    endTimeUnixNano: '1788364167362472291',
    attributes: [],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    status: { code: 0 },
    links: [],
    droppedLinksCount: 0,
    flags: 257,
  }),
  delivery({
    traceId: TRACE,
    spanId: '7cb4a6ed1dd21e14',
    // DevFlow's own client span, which will never arrive: DevFlow is not an
    // OTel SDK and emits no spans. This is the ordinary root.
    parentSpanId: '00f067aa0ba902b7',
    name: 'GET /api/v1/invoices',
    kind: 2,
    startTimeUnixNano: '1788364167355000000',
    endTimeUnixNano: '1788364167362949250',
    attributes: [
      { key: 'http.request.method', value: { stringValue: 'GET' } },
      { key: 'url.path', value: { stringValue: '/api/v1/invoices' } },
      { key: 'http.response.status_code', value: { intValue: 200 } },
      { key: 'server.address', value: { stringValue: 'localhost' } },
      { key: 'server.port', value: { intValue: 8000 } },
      { key: 'code.filepath', value: { stringValue: 'app/controllers/invoice_controller.py' } },
      { key: 'code.lineno', value: { intValue: 45 } },
      { key: 'code.function', value: { stringValue: 'list_invoices' } },
    ],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    status: { code: 0 },
    links: [],
    droppedLinksCount: 0,
    flags: 769,
  }),
  delivery({
    traceId: TRACE,
    spanId: '875ddf3c4ff485f0',
    parentSpanId: '00f067aa0ba902b7',
    name: 'POST /api/v1/charge',
    kind: 2,
    startTimeUnixNano: '1788364167363000000',
    endTimeUnixNano: '1788364167363163542',
    attributes: [
      { key: 'http.request.method', value: { stringValue: 'POST' } },
      { key: 'url.path', value: { stringValue: '/api/v1/charge' } },
      { key: 'http.response.status_code', value: { intValue: 500 } },
    ],
    droppedAttributesCount: 0,
    events: [
      {
        attributes: [
          { key: 'exception.type', value: { stringValue: 'Error' } },
          { key: 'exception.message', value: { stringValue: 'card declined' } },
          {
            key: 'exception.stacktrace',
            value: {
              stringValue: 'Error: card declined\n    at charge (app/services/billing.js:88:11)',
            },
          },
        ],
        name: 'exception',
        timeUnixNano: '1788364167363160542',
        droppedAttributesCount: 0,
      },
    ],
    droppedEventsCount: 0,
    status: { code: 2, message: 'card declined' },
    links: [],
    droppedLinksCount: 0,
    flags: 769,
  }),
];

/**
 * The same exporter's default encoding of one of those spans, as it went on the
 * wire. Real bytes, so the 415 is being produced against something a real
 * exporter would really post rather than against a string saying "protobuf".
 */
const PROTOBUF_BODY = Buffer.from(
  '0ad1010a630a1e0a0c736572766963652e6e616d65120e0a0c636865636b6f75742d6170690a1a0a' +
    '0f736572766963652e76657273696f6e12070a05322e342e310a230a166465706c6f796d656e742e' +
    '656e7669726f6e6d656e7412090a0773746167696e671000126a0a070a0570726f6265125f0a104b' +
    'f92f3577b34da6a3ce929d0e0e473612084a5c666bf0876f602208752e11f50afa30702a13496e76' +
    '6f696365536572766963652e6c69737430013900405830bc8bd118413b6fcf30bc8bd11850006000' +
    '70007a021800850101010000',
  'hex',
).toString('latin1');

// ── Harness ──────────────────────────────────────────────────────────────────

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devflow-otel-'));
  process.env.DEVFLOW_OTEL = '1';
});

afterEach(() => {
  otel.closeSpanStore();
  delete process.env.DEVFLOW_OTEL;
  rmSync(dir, { recursive: true, force: true });
});

const open = () => otel.openSpanStore(join(dir, 'otel.db'));

const post = (body: unknown, type = 'application/json') =>
  otel.handleOtlpPost(typeof body === 'string' ? body : JSON.stringify(body), type);

/** Every span of the real capture, held. */
function loadCapture() {
  open();
  for (const body of DELIVERIES) post(body);
}

// ── The gate ─────────────────────────────────────────────────────────────────

describe('DEVFLOW_OTEL', () => {
  it('refuses the endpoint and creates no database when it is not set', () => {
    delete process.env.DEVFLOW_OTEL;

    expect(open()).toBeNull();

    const response = post(DELIVERIES[0]);
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).toContain('DEVFLOW_OTEL=1');
    expect(otel.OTEL_ENABLED).toBe(false);
  });

  it('is off for a value that is not exactly 1', () => {
    process.env.DEVFLOW_OTEL = 'true';
    expect(post(DELIVERIES[0]).status).toBe(404);
    expect(otel.OTEL_ENABLED).toBe(false);
  });

  it('accepts spans when it is set', () => {
    open();
    const response = post(DELIVERIES[0]);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ partialSuccess: {} });
    expect(otel.OTEL_ENABLED).toBe(true);
    expect(otel.spanStoreStats().spans).toBe(1);
  });

  it('is read per call, so flipping it mid-process takes effect', () => {
    open();
    expect(post(DELIVERIES[0]).status).toBe(200);
    delete process.env.DEVFLOW_OTEL;
    expect(post(DELIVERIES[1]).status).toBe(404);
    process.env.DEVFLOW_OTEL = '1';
    expect(post(DELIVERIES[1]).status).toBe(200);
  });
});

// ── The wire ─────────────────────────────────────────────────────────────────

describe('handleOtlpPost', () => {
  it('refuses protobuf with 415 and names the exporter setting that fixes it', () => {
    open();
    const response = otel.handleOtlpPost(PROTOBUF_BODY, 'application/x-protobuf');

    expect(response.status).toBe(415);
    // The whole value of the refusal: the reader is looking at an exporter log,
    // not at this source, so the body has to carry the assignment to paste.
    expect(JSON.stringify(response.body)).toContain(
      'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json',
    );
    expect(otel.spanStoreStats().spans).toBe(0);
  });

  it('refuses unparseable JSON with 400', () => {
    open();
    const response = otel.handleOtlpPost('{"resourceSpans": [', 'application/json');
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('not-json');
  });

  it('refuses JSON that is not an OTLP export request with 400', () => {
    open();
    expect(post({ hello: 'world' }).status).toBe(400);
    expect(post('null').status).toBe(400);
  });

  it('answers an exporter with nothing to say with 200, not an error', () => {
    open();
    // An idle exporter posting an empty batch is not a misconfiguration, and
    // 400 here would fill a user's logs with errors describing nothing wrong.
    const response = post({ resourceSpans: [] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ partialSuccess: {} });
  });

  it('parses a body with no content type rather than arguing about the header', () => {
    open();
    expect(otel.handleOtlpPost(JSON.stringify(DELIVERIES[0]), undefined).status).toBe(200);
  });

  it('reports spans core dropped in OTLP partialSuccess', () => {
    open();
    const bad = delivery({
      traceId: 'not-a-trace-id',
      spanId: '29abc6b630d1e717',
      name: 'SELECT invoices',
      kind: 3,
      startTimeUnixNano: '1788364167355000000',
      endTimeUnixNano: '1788364167355043667',
    });
    const response = post(bad);
    expect(response.status).toBe(200);
    expect(response.body.partialSuccess).toMatchObject({ rejectedSpans: 1 });
    expect(otel.spanStoreStats().spans).toBe(0);
  });
});

// ── Holding ──────────────────────────────────────────────────────────────────

describe('the holding store', () => {
  it('holds every span of the real capture, delivered leaf-first', () => {
    loadCapture();

    const stats = otel.spanStoreStats();
    expect(stats.spans).toBe(4);
    expect(stats.traces).toBe(1);

    const held = otel.spansForTraces([TRACE]);
    expect(held.map((s) => s.spanId)).toEqual([
      '29abc6b630d1e717',
      'e014090292b7a0de',
      '7cb4a6ed1dd21e14',
      '875ddf3c4ff485f0',
    ]);
  });

  it('counts a re-delivered span as a duplicate, not a second row', () => {
    open();
    // OTel exporters retry. A delivery that was written here and then timed out
    // on the wire arrives again in full.
    expect(post(DELIVERIES[0]).status).toBe(200);
    expect(post(DELIVERIES[0]).status).toBe(200);
    expect(post(DELIVERIES[0]).status).toBe(200);

    expect(otel.spanStoreStats().spans).toBe(1);

    const reading = core.readOtlpTraces(DELIVERIES[1]);
    expect(otel.storeSpans(reading.spans)).toEqual({ stored: 1, duplicates: 0 });
    expect(otel.storeSpans(reading.spans)).toEqual({ stored: 0, duplicates: 1 });
  });

  it('keeps the first arrival time on re-delivery, so a retry cannot outlive the age cap', () => {
    open();
    const reading = core.readOtlpTraces(DELIVERIES[0]);
    const day = 24 * 60 * 60 * 1000;
    const t0 = 1_800_000_000_000;

    otel.storeSpans(reading.spans, t0);
    // Re-delivered a whole day later. If the retry refreshed `received_at` the
    // span would survive the sweep below for ever.
    otel.storeSpans(reading.spans, t0 + day);

    expect(otel.spanStoreStats().oldestMs).toBe(t0);
    expect(otel.pruneSpanStore(t0 + day + 1)).toEqual({ removed: 1 });
  });

  it('ignores trace ids it was never given spans for, and normalises case', () => {
    loadCapture();

    expect(otel.spansForTraces([])).toEqual([]);
    expect(otel.spansForTraces(['0'.repeat(32)])).toEqual([]);
    expect(otel.spansForTraces(['nonsense'])).toEqual([]);
    // Not every language's SDK writes lower-case hex; core normalises on the
    // way in, and the read side has to use the same rule or nothing matches.
    expect(otel.spansForTraces([TRACE.toUpperCase()])).toHaveLength(4);
  });

  it('degrades to empty answers rather than throwing when no store is open', () => {
    expect(otel.spansForTraces([TRACE])).toEqual([]);
    expect(otel.storeSpans([])).toEqual({ stored: 0, duplicates: 0 });
    expect(otel.pruneSpanStore(Date.now())).toEqual({ removed: 0 });
    expect(otel.spanStoreStats()).toEqual({
      spans: 0,
      traces: 0,
      oldestMs: null,
      newestMs: null,
    });
  });
});

// ── Round-trip fidelity ──────────────────────────────────────────────────────

describe('round trip', () => {
  it('returns spans byte-identical to what core read', () => {
    open();
    const sent: OtelSpan[] = [];
    for (const body of DELIVERIES) {
      sent.push(...core.readOtlpTraces(body).spans);
      post(body);
    }

    const held = otel.spansForTraces([TRACE]);
    expect(held).toEqual(sent);
  });

  it('keeps a unix-nanosecond timestamp exactly, past MAX_SAFE_INTEGER', () => {
    const db = open()!;

    // Real values off the capture. Unix nanoseconds are around 1.8e18 — two
    // orders of magnitude past the largest integer a JS number represents
    // exactly — so every one of these is corrupted by a single trip through a
    // number, and the corruption lands on the sub-millisecond end of a
    // duration, which is exactly the part a person reads a trace for.
    const captured = [
      '1788364167363000000',
      '1788364167355043667',
      '1788364167363163542',
      '1788364167362949250',
      '1788364167362472291',
    ];
    for (const nano of captured) {
      expect(Number(nano)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    }
    // The four with a non-zero tail are the proof that the hazard is real and
    // not theoretical; the first survives a double only by luck of its zeros.
    expect(captured.filter((n) => String(Number(n)) !== n)).toHaveLength(4);

    for (const [i, nano] of captured.entries()) {
      const body = delivery({
        traceId: TRACE,
        spanId: `aaaaaaaaaaaaaaa${i}`,
        name: 'GET /nano',
        kind: 2,
        startTimeUnixNano: nano,
        endTimeUnixNano: nano,
      });
      expect(post(body).status).toBe(200);
    }

    expect(otel.spansForTraces([TRACE]).map((s) => s.startUnixNano)).toEqual(captured);

    // And the column itself, not just what the reader assembled from it: TEXT,
    // so nothing between here and the disk can be tempted to widen it.
    const rows = db
      .prepare('SELECT start_unix_nano AS nano, typeof(start_unix_nano) AS t FROM otel_spans ORDER BY rowid')
      .all() as unknown as { nano: string; t: string }[];
    expect(rows.map((r) => r.nano)).toEqual(captured);
    expect(rows.every((r) => r.t === 'text')).toBe(true);
  });

  it('hands back spans that core accepts unchanged', () => {
    loadCapture();
    const spans = otel.spansForTraces([TRACE]);

    // Two roots, because a root is a span whose parent is not in the set — and
    // both server spans name DevFlow's client span, which will never arrive.
    const roots = core.buildSpanTree(spans);
    expect(roots.map((r) => r.span.name)).toEqual(['GET /api/v1/invoices', 'POST /api/v1/charge']);

    const join = core.joinTrace({
      calls: [
        { traceId: TRACE, step: 1, method: 'GET', url: 'https://shop.example.com/api/v1/invoices' },
      ],
      spans,
    });
    expect(join.awaiting).toEqual([]);
    expect(join.unrelated).toEqual([]);
    expect(join.joined).toHaveLength(1);
    expect(join.joined[0].services).toEqual(['checkout-api']);

    const projection = core.projectTrace(join.joined[0]);
    expect(projection.services.map((s) => s.name)).toEqual(['checkout-api']);
    expect(projection.operations.map((o) => o.name)).toContain('SELECT invoices');
    expect(projection.edges.length).toBeGreaterThan(0);
  });

  it('preserves the nullable and composite fields core produced', () => {
    loadCapture();
    const byId = new Map(otel.spansForTraces([TRACE]).map((s) => [s.spanId, s]));

    const query = byId.get('29abc6b630d1e717')!;
    expect(query.db).toEqual({
      system: 'postgresql',
      statement: 'SELECT total_amount FROM invoices WHERE id = $1',
      collection: 'invoices',
    });
    expect(query.http).toBeNull();
    expect(query.code).toBeNull();
    expect(query.failed).toBe(false);

    const internal = byId.get('e014090292b7a0de')!;
    expect(internal.kind).toBe('internal');
    expect(internal.http).toBeNull();
    expect(internal.statusMessage).toBeNull();

    const handler = byId.get('7cb4a6ed1dd21e14')!;
    expect(handler.http).toEqual({ method: 'GET', path: '/api/v1/invoices', status: 200 });
    expect(handler.code).toEqual({ file: 'app/controllers/invoice_controller.py', line: 45 });
    expect(handler.serviceVersion).toBe('2.4.1');
    expect(handler.environment).toBe('staging');

    const failure = byId.get('875ddf3c4ff485f0')!;
    expect(failure.failed).toBe(true);
    expect(failure.statusMessage).toBe('card declined');
    expect(failure.exception).toEqual({ type: 'Error', message: 'card declined' });
  });
});

// ── The caps ─────────────────────────────────────────────────────────────────

/**
 * Fill the table straight through SQLite.
 *
 * Fifty thousand spans built and inserted through `storeSpans` would be a
 * multi-second test to prove a `LIMIT`. A recursive CTE writes them in the
 * engine, so the real constant is the one under test rather than a smaller one
 * exported for the test's convenience.
 */
function fill(db: Db, count: number, receivedAt: number) {
  db.exec(`
    INSERT INTO otel_spans (
      trace_id, span_id, parent_span_id, name, kind, service, service_version,
      environment, start_unix_nano, duration_ms, failed, status_message,
      http_json, db_json, code_json, exception_json, received_at
    )
    SELECT printf('%032x', n), printf('%016x', n), NULL, 'filler', 'internal',
           'filler-service', NULL, NULL, '1788364167355000000', 1.0, 0, NULL,
           NULL, NULL, NULL, NULL, ${receivedAt}
    FROM (
      WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${count})
      SELECT n FROM c
    )
  `);
}

describe('the caps', () => {
  it('evicts the oldest arrivals once the row cap is passed', () => {
    const db = open()!;
    const now = 1_800_000_000_000;

    // One under the cap, all arriving a minute ago.
    fill(db, 49_999, now - 60_000);
    expect(otel.spanStoreStats().spans).toBe(49_999);

    // Two more real spans arriving now: one fits, one pushes the count over.
    const reading = core.readOtlpTraces(DELIVERIES[0]);
    otel.storeSpans(reading.spans, now);
    expect(otel.spanStoreStats().spans).toBe(50_000);

    otel.storeSpans(core.readOtlpTraces(DELIVERIES[3]).spans, now);
    expect(otel.spanStoreStats().spans).toBe(50_000);

    // The newcomers survived and a filler row was evicted, because eviction is
    // oldest-arrival-first and not whatever the table happened to scan first.
    expect(otel.spansForTraces([TRACE]).map((s) => s.spanId).sort()).toEqual([
      '29abc6b630d1e717',
      '875ddf3c4ff485f0',
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM otel_spans WHERE name = 'filler'").get()).toEqual({
      n: 49_998,
    });
  });

  it('drops spans past the age cap, measured on this machine’s clock', () => {
    const db = open()!;
    const now = 1_800_000_000_000;
    const day = 24 * 60 * 60 * 1000;

    fill(db, 10, now - day - 1);
    otel.storeSpans(core.readOtlpTraces(DELIVERIES[0]).spans, now - 60_000);
    expect(otel.spanStoreStats().spans).toBe(11);

    expect(otel.pruneSpanStore(now)).toEqual({ removed: 10 });
    expect(otel.spansForTraces([TRACE])).toHaveLength(1);
  });

  it('enforces the age cap on write, without waiting for anyone to sweep', () => {
    const db = open()!;
    const now = 1_800_000_000_000;
    fill(db, 5, now - 48 * 60 * 60 * 1000);

    otel.storeSpans(core.readOtlpTraces(DELIVERIES[0]).spans, now);

    // A bound that only holds when a caller remembers to call a sweeper is not
    // a bound, and the thing filling this table is unsolicited.
    expect(otel.spanStoreStats().spans).toBe(1);
  });

  it('ages off spans by arrival, not by the timestamp the sender chose', () => {
    open();
    const now = 1_800_000_000_000;
    // A backend with a clock set to 1970 exports a span. Its `startUnixNano` is
    // decades old; it arrived a second ago and must be kept.
    const skewed = delivery({
      traceId: TRACE,
      spanId: 'aaaaaaaaaaaaaaaa',
      name: 'GET /skewed',
      kind: 2,
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '1002000000',
    });
    otel.storeSpans(core.readOtlpTraces(skewed).spans, now);

    expect(otel.pruneSpanStore(now)).toEqual({ removed: 0 });
    expect(otel.spansForTraces([TRACE])).toHaveLength(1);
  });
});
