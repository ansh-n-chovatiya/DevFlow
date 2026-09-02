/**
 * What a backend trace becomes once it is in the graph.
 *
 * The chain is driven end to end — `readOtlpTraces` → `joinTrace` →
 * `projectTrace` → `ingestTrace` — and the payload at the front of it is four
 * real deliveries from a real exporter, copied in verbatim. Every fact this
 * file leans on came out of that capture rather than off a specification: the
 * spans arrive leaf-first across four requests, the root's parent never arrives
 * at all, and the timestamps are unix-nanosecond *strings*. A fixture written
 * by hand here would be this repository agreeing with itself about a foreign
 * wire format, which is exactly the shape of the defects `core/otel`'s header
 * says were found by measuring instead.
 *
 * The claims are all about the SQL, because every decision about *what* is
 * admissible was made in `core/otel` and nothing here re-derives one:
 *
 *  - a span becomes an observation of a **service** and an **operation**, both
 *    keyed on names that outlive the recording, and never a node per span;
 *  - the endpoint an operation joins to is the row `ingestFlow` already made
 *    for that call, so the FE → BE chain is one connected walk and not two
 *    halves that look joined;
 *  - `frequency` counts **recordings**. A handler that ran forty times inside
 *    one request is one observation, and re-sending a recording is none;
 *  - a dirty working tree writes no `git_sha`, because the column is a join key
 *    with no room beside it to say the build exists on nobody's machine.
 *
 * `mcp-server/` is a second npm package with its own dependencies and no types,
 * so both modules are reached through a dynamic import of a file URL and given
 * the shape they are used at, exactly as `arkg.test.ts` and `arkg-causal` do.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// ── The modules under test ───────────────────────────────────────────────────

type Row = Record<string, string | number | null>;

interface Statement {
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
  run(...params: unknown[]): unknown;
}

interface Db {
  prepare(sql: string): Statement;
}

interface Span {
  traceId: string;
  spanId: string;
  name: string;
  service: string;
  durationMs: number;
  failed: boolean;
}

interface TracedCall {
  traceId: string;
  step: number;
  method: string;
  url: string;
}

interface Join {
  call: TracedCall;
}

interface Projection {
  services: { name: string; version: string | null; environment: string | null }[];
  operations: { service: string; name: string; durationMs: number; failed: boolean }[];
  edges: unknown[];
}

interface Core {
  readOtlpTraces(body: unknown): { spans?: Span[]; rejected?: string };
  joinTrace(input: { calls: TracedCall[]; spans: Span[] }): { joined: Join[]; awaiting: string[] };
  projectTrace(join: Join): Projection;
}

interface Service {
  id: string;
  name: string;
  version: string | null;
  environment: string | null;
  frequency: number;
  operationCount: number;
  gitSha: string | null;
}

interface Operation {
  id: string;
  service: string;
  name: string;
  kind: string | null;
  sourceFile: string | null;
  sourceLine: number | null;
  frequency: number;
  failureRate: number;
  timingP50Ms: number | null;
  timingP95Ms: number | null;
  gitSha: string | null;
}

interface Neighbour {
  edge: string;
  direction: string;
  nodeType: string;
  id: string;
  label: string;
}

interface Counts {
  services: number;
  operations: number;
  edges: number;
}

interface Arkg {
  openArkg(dbPath: string): Db;
  closeArkg(): void;
  ingestFlow(flowJson: unknown, git?: unknown): boolean | undefined;
  ingestTrace(projection: Projection, flowId: string, gitSha?: unknown, now?: number): Counts;
  getServices(): Service[];
  getOperationsForService(name: string): Operation[];
  getBackendForEndpoint(method: string, url: string, limit?: number): (Operation & { depth: number })[];
  getNeighbours(kind: string, id: string, limit?: number): Neighbour[];
  pruneOldObservations(retentionDays: number): number;
  getAppArchitecture(): Record<string, unknown> | null;
}

const CORE_URL = new URL('../mcp-server/core.js', import.meta.url).href;
const ARKG_URL = new URL('../mcp-server/arkg.js', import.meta.url).href;
const core = (await import(/* @vite-ignore */ CORE_URL)) as Core;
const arkg = (await import(/* @vite-ignore */ ARKG_URL)) as Arkg;

// ── The capture ──────────────────────────────────────────────────────────────

/**
 * Four `ExportTraceServiceRequest` bodies, exactly as a Node exporter sent
 * them, kept as text so that nothing here can quietly tidy one up.
 *
 * They arrive in the order they were captured, which is the order that matters:
 * the `SELECT` at depth three is first and the server span that caused it is
 * third, because a span is exported when it *ends* and a child ends before its
 * parent. Reading them in this order is the whole reason `buildSpanTree` takes
 * the accumulated set rather than one delivery.
 */
const DELIVERIES: string[] = [
  `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout-api"}},{"key":"service.version","value":{"stringValue":"2.4.1"}},{"key":"deployment.environment","value":{"stringValue":"staging"}}],"droppedAttributesCount":0},"scopeSpans":[{"scope":{"name":"probe"},"spans":[{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"29abc6b630d1e717","parentSpanId":"e014090292b7a0de","name":"SELECT invoices","kind":3,"startTimeUnixNano":"1788364167355000000","endTimeUnixNano":"1788364167355043667","attributes":[{"key":"db.system.name","value":{"stringValue":"postgresql"}},{"key":"db.namespace","value":{"stringValue":"shop"}},{"key":"db.query.text","value":{"stringValue":"SELECT total_amount FROM invoices WHERE id = $1"}},{"key":"db.collection.name","value":{"stringValue":"invoices"}}],"droppedAttributesCount":0,"events":[],"droppedEventsCount":0,"status":{"code":0},"links":[],"droppedLinksCount":0,"flags":257}]}]}]}`,
  `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout-api"}},{"key":"service.version","value":{"stringValue":"2.4.1"}},{"key":"deployment.environment","value":{"stringValue":"staging"}}],"droppedAttributesCount":0},"scopeSpans":[{"scope":{"name":"probe"},"spans":[{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"e014090292b7a0de","parentSpanId":"7cb4a6ed1dd21e14","name":"InvoiceService.list","kind":1,"startTimeUnixNano":"1788364167355000000","endTimeUnixNano":"1788364167362472291","attributes":[],"droppedAttributesCount":0,"events":[],"droppedEventsCount":0,"status":{"code":0},"links":[],"droppedLinksCount":0,"flags":257}]}]}]}`,
  `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout-api"}},{"key":"service.version","value":{"stringValue":"2.4.1"}},{"key":"deployment.environment","value":{"stringValue":"staging"}}],"droppedAttributesCount":0},"scopeSpans":[{"scope":{"name":"probe"},"spans":[{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"7cb4a6ed1dd21e14","parentSpanId":"00f067aa0ba902b7","name":"GET /api/v1/invoices","kind":2,"startTimeUnixNano":"1788364167355000000","endTimeUnixNano":"1788364167362949250","attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"url.path","value":{"stringValue":"/api/v1/invoices"}},{"key":"http.response.status_code","value":{"intValue":200}},{"key":"server.address","value":{"stringValue":"localhost"}},{"key":"server.port","value":{"intValue":8000}},{"key":"code.filepath","value":{"stringValue":"app/controllers/invoice_controller.py"}},{"key":"code.lineno","value":{"intValue":45}},{"key":"code.function","value":{"stringValue":"list_invoices"}}],"droppedAttributesCount":0,"events":[],"droppedEventsCount":0,"status":{"code":0},"links":[],"droppedLinksCount":0,"flags":769}]}]}]}`,
  `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout-api"}},{"key":"service.version","value":{"stringValue":"2.4.1"}},{"key":"deployment.environment","value":{"stringValue":"staging"}}],"droppedAttributesCount":0},"scopeSpans":[{"scope":{"name":"probe"},"spans":[{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"875ddf3c4ff485f0","parentSpanId":"00f067aa0ba902b7","name":"POST /api/v1/charge","kind":2,"startTimeUnixNano":"1788364167363000000","endTimeUnixNano":"1788364167363163542","attributes":[{"key":"http.request.method","value":{"stringValue":"POST"}},{"key":"url.path","value":{"stringValue":"/api/v1/charge"}},{"key":"http.response.status_code","value":{"intValue":500}}],"droppedAttributesCount":0,"events":[{"attributes":[{"key":"exception.type","value":{"stringValue":"Error"}},{"key":"exception.message","value":{"stringValue":"card declined"}},{"key":"exception.stacktrace","value":{"stringValue":"Error: card declined\\n    at charge (app/services/billing.js:88:11)"}}],"name":"exception","timeUnixNano":"1788364167363160542","droppedAttributesCount":0}],"droppedEventsCount":0,"status":{"code":2,"message":"card declined"},"links":[],"droppedLinksCount":0,"flags":769}]}]}]}`,
];

/** The trace id the exporter continued — DevFlow's own `traceparent`. */
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

/** The request the recording watched leave the browser, under that id. */
const CALL: TracedCall = {
  traceId: TRACE_ID,
  step: 1,
  method: 'GET',
  // An invoice id in the path on purpose: the endpoint node collapses it, and
  // the operation node has to land on that same collapsed row.
  url: 'https://api.example.com/api/v1/invoices/8814',
};

interface RawSpan {
  spanId: string;
  parentSpanId: string;
  [key: string]: unknown;
}

interface Delivery {
  resourceSpans: { scopeSpans: { spans: RawSpan[] }[] }[];
}

const parsed = (): Delivery[] => DELIVERIES.map((text) => JSON.parse(text) as Delivery);

const clone = (delivery: Delivery): Delivery => JSON.parse(JSON.stringify(delivery)) as Delivery;

const spansOf = (delivery: Delivery): RawSpan[] =>
  delivery.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));

/** Every span of a set of deliveries, read the way the receiver reads them. */
function read(deliveries: Delivery[]): Span[] {
  const spans: Span[] = [];
  for (const delivery of deliveries) {
    const reading = core.readOtlpTraces(delivery);
    expect(reading.rejected).toBeUndefined();
    spans.push(...(reading.spans ?? []));
  }
  return spans;
}

/** The projection a recording of `CALL` makes out of those spans. */
function project(deliveries: Delivery[] = parsed()): Projection {
  const join = core.joinTrace({ calls: [CALL], spans: read(deliveries) });
  expect(join.joined).toHaveLength(1);
  return core.projectTrace(join.joined[0]);
}

// ── The recording the trace joins to ─────────────────────────────────────────

const NOW = 1_700_000_000_000;
const FLOW_ID = 'flow-otel-1';

/**
 * The flow that made the call, so the endpoint node exists before the trace
 * arrives — which is the ordinary order, and the one the join is for.
 */
function flow(id = FLOW_ID): unknown {
  return {
    id,
    name: 'Invoices',
    timestamp: NOW,
    startUrl: 'https://app.example.com/invoices',
    react: {
      components: { 'inv-1': { name: 'InvoiceList', source: 'src/Invoices.tsx', line: 4 } },
    },
    steps: [
      {
        type: 'click',
        url: 'https://app.example.com/invoices',
        timestamp: NOW,
        action: 'Clicked "Invoices"',
        element: {
          tag: 'button',
          cssSelector: 'button',
          react: { chain: ['inv-1'], owner: 'inv-1' },
        },
        networkCalls: [
          { url: CALL.url, method: CALL.method, status: 200, durationMs: 12, timestamp: NOW },
        ],
        consoleLogs: [],
      },
    ],
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/*
 * A real file rather than `:memory:`, in a directory of this run's own: the
 * thing under test is a schema and a set of upserts, and an in-memory database
 * would exercise a DDL that never had to survive being opened twice.
 */
let home: string | null = null;

function open(): Db {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-otel-'));
  return arkg.openArkg(path.join(home, 'arkg.db'));
}

afterEach(() => {
  arkg.closeArkg();
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = null;
});

const rows = (db: Db, sql: string, ...params: unknown[]): Row[] => db.prepare(sql).all(...params);

const edges = (db: Db, type: string): Row[] =>
  rows(db, 'SELECT * FROM arkg_edges WHERE type = ? ORDER BY from_node_id, to_node_id', type);

const operation = (db: Db, name: string): Row | undefined =>
  db.prepare('SELECT * FROM arkg_operations WHERE name = ?').get(name);

/** Every node id this graph holds, by node type, for resolving an edge's ends. */
function nodeIds(db: Db): Record<string, Set<string>> {
  const ids = (sql: string) => new Set(rows(db, sql).map((row) => String(row.id)));
  return {
    api_endpoint: ids('SELECT id FROM arkg_api_endpoints'),
    service: ids('SELECT id FROM arkg_services'),
    operation: ids('SELECT id FROM arkg_operations'),
    component: ids('SELECT id FROM arkg_components'),
    source_file: ids('SELECT id FROM arkg_source_files'),
  };
}

/** Ingest the recording and then its trace, which is the order they happen in. */
function ingest(deliveries?: Delivery[], gitSha: unknown = null, flowId = FLOW_ID): Counts {
  arkg.ingestFlow(flow(flowId));
  return arkg.ingestTrace(project(deliveries), flowId, gitSha, NOW);
}

// ── The nodes ────────────────────────────────────────────────────────────────

describe('the nodes a trace files', () => {
  it('files one service, keyed on service.name, carrying its last-seen build', () => {
    const db = open();
    ingest();

    // Four spans, one resource: a node per span would be four rows, which is
    // the log this graph must not become.
    expect(rows(db, 'SELECT * FROM arkg_services')).toHaveLength(1);
    const [service] = arkg.getServices();
    expect(service.name).toBe('checkout-api');
    expect(service.version).toBe('2.4.1');
    expect(service.environment).toBe('staging');
    expect(service.frequency).toBe(1);
    expect(service.operationCount).toBe(4);
  });

  /*
   * A service is not timed and does not fail, so the columns that would say it
   * was are absent rather than always NULL — the same shape arkg_git_commits
   * and arkg_state_keys are, and for the reason those two give.
   */
  it('gives the service no timing or failure columns at all', () => {
    const db = open();
    ingest();

    const columns = rows(db, 'PRAGMA table_info(arkg_services)').map((row) => String(row.name));
    expect(columns).toContain('frequency');
    expect(columns).toContain('last_observed_at');
    expect(columns).toContain('first_observed_at');
    expect(columns).toContain('git_sha');
    expect(columns).not.toContain('timing_p50_ms');
    expect(columns).not.toContain('timing_p95_ms');
    expect(columns).not.toContain('failure_rate');
  });

  it('files one operation per span name, keyed on the service and the name', () => {
    const db = open();
    ingest();

    expect(rows(db, 'SELECT * FROM arkg_operations').map((row) => row.name).sort()).toEqual([
      'GET /api/v1/invoices',
      'InvoiceService.list',
      'POST /api/v1/charge',
      'SELECT invoices',
    ]);
    for (const row of rows(db, 'SELECT * FROM arkg_operations')) {
      expect(row.service_name).toBe('checkout-api');
      expect(row.service_id).toBe(arkg.getServices()[0].id);
    }
  });

  it('keeps the span kind and the source the instrumentation supplied', () => {
    const db = open();
    ingest();

    const handler = operation(db, 'GET /api/v1/invoices');
    expect(handler?.kind).toBe('server');
    expect(handler?.source_file).toBe('app/controllers/invoice_controller.py');
    expect(handler?.source_line).toBe(45);

    // Nothing is invented for the spans that carried none.
    const query = operation(db, 'SELECT invoices');
    expect(query?.kind).toBe('client');
    expect(query?.source_file).toBeNull();
    expect(query?.source_line).toBeNull();
  });
});

// ── The edges ────────────────────────────────────────────────────────────────

describe('the edges a trace draws', () => {
  it('joins the operation to the endpoint node the recording already made', () => {
    const db = open();
    ingest();

    // One endpoint row, made by ingestFlow out of the browser's own call. The
    // trace must land on *that* row: a parallel endpoint node would leave the
    // FE half and the BE half unreachable from each other.
    const endpoints = rows(db, 'SELECT * FROM arkg_api_endpoints');
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].url_pattern).toBe('api.example.com/api/v1/invoices/:id');

    const fromEndpoint = edges(db, 'calls').filter((row) => row.from_node_type === 'api_endpoint');
    expect(fromEndpoint).toHaveLength(2);
    for (const edge of fromEndpoint) {
      expect(edge.from_node_id).toBe(endpoints[0].id);
      expect(edge.to_node_type).toBe('operation');
    }
  });

  /*
   * Only a root operation gets the endpoint edge — see `projectTrace`. The
   * chain to the query is the operation → operation edges, walked, and drawing
   * `endpoint → SELECT invoices` would claim the page issued the query.
   */
  it('draws calls between operations and never from the endpoint to a nested one', () => {
    const db = open();
    ingest();

    const between = edges(db, 'calls')
      .filter((row) => row.from_node_type === 'operation')
      .map((row) => [
        operation(db, 'GET /api/v1/invoices')?.id === row.from_node_id
          ? 'GET /api/v1/invoices'
          : 'InvoiceService.list',
        rows(db, 'SELECT name FROM arkg_operations WHERE id = ?', row.to_node_id)[0].name,
      ]);
    expect(between.sort()).toEqual([
      ['GET /api/v1/invoices', 'InvoiceService.list'],
      ['InvoiceService.list', 'SELECT invoices'],
    ]);

    const reachedFromEndpoint = arkg
      .getBackendForEndpoint(CALL.method, CALL.url)
      .filter((op) => op.depth === 1)
      .map((op) => op.name)
      .sort();
    expect(reachedFromEndpoint).toEqual(['GET /api/v1/invoices', 'POST /api/v1/charge']);
  });

  it('runs every operation into its service, and leaves no edge end dangling', () => {
    const db = open();
    ingest();

    const service = arkg.getServices()[0];
    const runsIn = edges(db, 'runs_in');
    expect(runsIn).toHaveLength(4);
    for (const edge of runsIn) {
      expect(edge.to_node_type).toBe('service');
      expect(edge.to_node_id).toBe(service.id);
    }

    // The admission rule, checked over the whole table rather than over the
    // rows this test wrote: an edge whose end names no node is a claim about
    // something the graph cannot show anybody.
    const known = nodeIds(db);
    for (const edge of rows(db, 'SELECT * FROM arkg_edges')) {
      expect(known[String(edge.from_node_type)]).toContain(String(edge.from_node_id));
      expect(known[String(edge.to_node_type)]).toContain(String(edge.to_node_id));
    }
  });

  /** The navigator reads these edges, and a hash is not a name. */
  it('names an operation by its service when a reader walks onto one', () => {
    const db = open();
    ingest();

    const endpointNode = rows(db, 'SELECT id FROM arkg_api_endpoints')[0].id;
    const labels = arkg.getNeighbours('endpoint', String(endpointNode)).map((n) => n.label);
    expect(labels).toContain('checkout-api GET /api/v1/invoices');
  });
});

// ── Frequency counts recordings ──────────────────────────────────────────────

describe('frequency counts recordings and not spans', () => {
  /*
   * The case that actually happens, and the reason the ledger is per fact
   * rather than per payload: spans arrive across four deliveries and the join
   * re-runs on each, so the receiver hands the same operations here several
   * times over with more of the tree in them each time.
   */
  it('counts a trace once however many times it is ingested', () => {
    const db = open();
    const first = ingest();
    expect(first).toEqual({ services: 1, operations: 4, edges: 8 });

    const again = arkg.ingestTrace(project(), FLOW_ID, null, NOW + 1000);
    expect(again).toEqual({ services: 0, operations: 0, edges: 0 });

    expect(arkg.getServices()[0].frequency).toBe(1);
    for (const op of arkg.getOperationsForService('checkout-api')) expect(op.frequency).toBe(1);
    for (const edge of rows(db, 'SELECT * FROM arkg_edges')) expect(edge.frequency).toBe(1);
  });

  it('accumulates a second recording of the same backend onto the same nodes', () => {
    const db = open();
    ingest();
    arkg.ingestFlow(flow('flow-otel-2'));
    const second = arkg.ingestTrace(project(), 'flow-otel-2', null, NOW + 1000);

    expect(second).toEqual({ services: 1, operations: 4, edges: 8 });
    expect(rows(db, 'SELECT * FROM arkg_services')).toHaveLength(1);
    expect(rows(db, 'SELECT * FROM arkg_operations')).toHaveLength(4);
    expect(arkg.getServices()[0].frequency).toBe(2);
    expect(operation(db, 'SELECT invoices')?.frequency).toBe(2);
  });

  /**
   * A handler that ran the same query forty times in one request.
   *
   * One observation of that operation and one of the edge to it — `frequency`
   * is a count of recordings, and forty here would be a number no reader can
   * arrive at from the recordings they hold. The window is the other unit and
   * takes all forty, because each of them measured the operation's latency
   * once and a mean of them would be a number the application never produced.
   */
  it('counts forty identical downstream calls in one trace once', () => {
    const db = open();
    const deliveries = parsed();
    const repeated = clone(deliveries[0]);
    const template = spansOf(repeated)[0];
    const copies = repeated.resourceSpans[0].scopeSpans[0].spans;
    for (let i = 1; i < 40; i += 1) {
      const copy = JSON.parse(JSON.stringify(template)) as RawSpan;
      // A fresh span id per copy, which is what forty real calls would carry:
      // `buildSpanTree` keeps the first span of a repeated id and would
      // otherwise collapse them before this file ever saw them.
      copy.spanId = i.toString(16).padStart(16, '0');
      copies.push(copy);
    }
    expect(spansOf(repeated)).toHaveLength(40);

    ingest([repeated, deliveries[1], deliveries[2], deliveries[3]]);

    const query = operation(db, 'SELECT invoices');
    expect(query?.frequency).toBe(1);
    expect(JSON.parse(String(query?.timing_samples))).toHaveLength(40);

    const into = edges(db, 'calls').filter((row) => row.to_node_id === query?.id);
    expect(into).toHaveLength(1);
    expect(into[0].frequency).toBe(1);
  });
});

// ── The numbers on an operation ──────────────────────────────────────────────

describe('an operation is timed and does fail', () => {
  it('accumulates a timing window and its percentiles', () => {
    const db = open();
    ingest();

    const handler = operation(db, 'GET /api/v1/invoices');
    expect(JSON.parse(String(handler?.timing_samples))).toEqual([7.94925]);
    expect(handler?.timing_p50_ms).toBeCloseTo(7.94925, 5);
    expect(handler?.timing_p95_ms).toBeCloseTo(7.94925, 5);

    arkg.ingestFlow(flow('flow-otel-2'));
    arkg.ingestTrace(project(), 'flow-otel-2', null, NOW + 1000);

    const after = operation(db, 'GET /api/v1/invoices');
    expect(JSON.parse(String(after?.timing_samples))).toHaveLength(2);
    expect(after?.timing_p50_ms).toBeCloseTo(7.94925, 5);
  });

  /**
   * `status.code === 2` on the charge span, and only that span.
   *
   * An unset status is not a failure — three of these four spans carry no
   * status at all — so a failure rate of 1 on the charge and 0 everywhere else
   * is the whole claim, and it is the difference between a graph that can
   * answer "which operation is failing" and one that says everything is.
   */
  it('moves the failure rate for the span that reported ERROR, and no other', () => {
    open();
    ingest();

    const byName = new Map(
      arkg.getOperationsForService('checkout-api').map((op) => [op.name, op.failureRate]),
    );
    expect(byName.get('POST /api/v1/charge')).toBe(1);
    expect(byName.get('GET /api/v1/invoices')).toBe(0);
    expect(byName.get('InvoiceService.list')).toBe(0);
    expect(byName.get('SELECT invoices')).toBe(0);
  });

  /** A rolling rate over recordings: one failure in two is a half. */
  it('folds a second recording into the rate rather than replacing it', () => {
    const db = open();
    const deliveries = parsed();
    ingest();

    // The same trace with the charge succeeding, sent as a second recording.
    const healthy = clone(deliveries[3]);
    spansOf(healthy)[0].status = { code: 1 };
    arkg.ingestFlow(flow('flow-otel-2'));
    arkg.ingestTrace(
      project([deliveries[0], deliveries[1], deliveries[2], healthy]),
      'flow-otel-2',
      null,
      NOW + 1000,
    );

    expect(operation(db, 'POST /api/v1/charge')?.failure_rate).toBeCloseTo(0.5, 10);
  });
});

// ── The build it was observed at ─────────────────────────────────────────────

describe('which build the backend was observed against', () => {
  const CLEAN = { sha: 'a'.repeat(40), short: 'aaaaaaa', dirty: false, branch: 'main', subject: 'x' };
  const DIRTY = { ...CLEAN, dirty: true };

  it('stamps every node and edge with the commit the recording was made at', () => {
    const db = open();
    ingest(undefined, CLEAN.sha);

    expect(arkg.getServices()[0].gitSha).toBe(CLEAN.sha);
    for (const op of arkg.getOperationsForService('checkout-api')) expect(op.gitSha).toBe(CLEAN.sha);
    for (const edge of rows(db, "SELECT * FROM arkg_edges WHERE to_node_type IN ('operation','service')")) {
      expect(edge.git_sha).toBe(CLEAN.sha);
    }
  });

  /*
   * A dirty tree names a build that exists on no machine, and this column has
   * no room beside it to say so. `joinableSha` is the one place that rule
   * lives, and a caller holding the checkout rather than the sha gets it
   * applied here rather than being trusted to have applied it itself.
   */
  it('writes no sha at all when the working tree was dirty', () => {
    const db = open();
    ingest(undefined, DIRTY);

    expect(arkg.getServices()[0].gitSha).toBeNull();
    for (const op of arkg.getOperationsForService('checkout-api')) expect(op.gitSha).toBeNull();
    for (const edge of rows(db, "SELECT * FROM arkg_edges WHERE to_node_type IN ('operation','service')")) {
      expect(edge.git_sha).toBeNull();
    }
  });

  it('takes the sha from a clean checkout passed whole', () => {
    open();
    ingest(undefined, CLEAN);
    expect(arkg.getServices()[0].gitSha).toBe(CLEAN.sha);
  });
});

// ── Reading it back ──────────────────────────────────────────────────────────

describe('what the graph will say about a backend', () => {
  it('walks the endpoint out to the whole chain, nearest first', () => {
    open();
    ingest();

    const chain = arkg.getBackendForEndpoint(CALL.method, CALL.url);
    const depths = new Map(chain.map((op) => [op.name, op.depth]));
    expect(depths.get('GET /api/v1/invoices')).toBe(1);
    expect(depths.get('POST /api/v1/charge')).toBe(1);
    expect(depths.get('InvoiceService.list')).toBe(2);
    expect(depths.get('SELECT invoices')).toBe(3);
    expect(chain[0].service).toBe('checkout-api');
  });

  it('answers an endpoint nothing was ever traced under with nothing', () => {
    open();
    ingest();
    expect(arkg.getBackendForEndpoint('GET', 'https://api.example.com/nothing')).toEqual([]);
    expect(arkg.getOperationsForService('no-such-service')).toEqual([]);
  });

  it('bounds the walk when a caller asks for less than the graph holds', () => {
    open();
    ingest();
    expect(arkg.getBackendForEndpoint(CALL.method, CALL.url, 2)).toHaveLength(2);
  });
});

// ── Nothing about the graph may fail a recording ─────────────────────────────

describe('a trace that says nothing costs the recording nothing', () => {
  it('takes an empty projection, a missing flow id and rubbish without throwing', () => {
    const db = open();
    arkg.ingestFlow(flow());

    const empty = { services: [], operations: [], edges: [] };
    expect(arkg.ingestTrace(empty, FLOW_ID)).toEqual({ services: 0, operations: 0, edges: 0 });
    expect(arkg.ingestTrace(project(), '')).toEqual({ services: 0, operations: 0, edges: 0 });
    expect(
      arkg.ingestTrace({ services: [{}], operations: [{}], edges: [{}] } as unknown as Projection, FLOW_ID),
    ).toEqual({ services: 0, operations: 0, edges: 0 });

    // And the recording is still all there.
    expect(rows(db, 'SELECT * FROM arkg_components')).toHaveLength(1);
    expect(rows(db, 'SELECT * FROM arkg_api_endpoints')).toHaveLength(1);
    expect(rows(db, 'SELECT * FROM arkg_services')).toHaveLength(0);
  });

  /**
   * A trace nobody recorded projects onto one node, so it never reaches here.
   *
   * The check belongs to `joinTrace` and this is the assertion that the SQL
   * side agrees: spans held for a trace this recording does not carry are
   * counted as unrelated and write nothing.
   */
  it('writes nothing for spans whose trace the recording never made', () => {
    const db = open();
    arkg.ingestFlow(flow());

    const join = core.joinTrace({
      calls: [{ ...CALL, traceId: 'f'.repeat(32) }],
      spans: read(parsed()),
    });
    expect(join.joined).toHaveLength(0);
    expect(join.awaiting).toEqual(['f'.repeat(32)]);
    expect(rows(db, 'SELECT * FROM arkg_operations')).toHaveLength(0);
  });
});

// ── Retention ────────────────────────────────────────────────────────────────

describe('backend nodes age out like everything else', () => {
  /*
   * These two tests exist because the backend nodes are the ones retention most
   * needs to reach and were the ones it originally missed.
   *
   * Every other node kind here is created by somebody recording, so the graph
   * grows at the rate a person works. A service and its operations are created
   * by a span arriving on an endpoint nothing on this machine paces — so a
   * policy covering every node kind *except* those two would have been pointing
   * exactly the wrong way round, and nothing would ever have reported it: the
   * symptom is a database that quietly grows.
   */
  it('deletes services and operations whose last sighting is past the cutoff', () => {
    const db = open();
    arkg.ingestFlow(flow());
    // Ingested as of a moment far enough back that any positive retention
    // window has already closed over it.
    arkg.ingestTrace(project(), FLOW_ID, null, Date.now() - 90 * 24 * 60 * 60 * 1000);

    expect(rows(db, 'SELECT * FROM arkg_services').length).toBeGreaterThan(0);
    expect(rows(db, 'SELECT * FROM arkg_operations').length).toBeGreaterThan(0);
    expect(rows(db, 'SELECT * FROM arkg_trace_observations').length).toBeGreaterThan(0);

    arkg.pruneOldObservations(30);

    expect(rows(db, 'SELECT * FROM arkg_services')).toHaveLength(0);
    expect(rows(db, 'SELECT * FROM arkg_operations')).toHaveLength(0);

    /*
     * And the ledger with them. It only means anything while the nodes it
     * deduplicates against are present; left behind it would suppress the
     * re-counting of an operation that was pruned and then seen again.
     */
    expect(rows(db, 'SELECT * FROM arkg_trace_observations')).toHaveLength(0);

    /*
     * No edge may outlive either of its ends. `getBackendForEndpoint` walks
     * `calls` from an endpoint, so an edge pointing at a deleted operation is
     * not an orphan row in a table nobody reads — it is a row that answer walks
     * onto and cannot resolve.
     */
    for (const edge of [...edges(db, 'calls'), ...edges(db, 'runs_in')]) {
      expect(['service', 'operation']).not.toContain(edge.from_type);
      expect(['service', 'operation']).not.toContain(edge.to_type);
    }
  });

  it('keeps them while they are inside the window', () => {
    const db = open();
    arkg.ingestFlow(flow());
    /*
     * Ingested at the wall clock rather than at the suite's fixed `NOW`, which
     * is a date in 2023: retention is measured against `Date.now()`, so a
     * fixture frozen in the past is outside every window and this test would
     * pass for the wrong reason — or, as it first did, fail for a right one.
     */
    arkg.ingestTrace(project(), FLOW_ID, null, Date.now());
    arkg.pruneOldObservations(30);
    expect(rows(db, 'SELECT * FROM arkg_services').length).toBeGreaterThan(0);
    expect(rows(db, 'SELECT * FROM arkg_operations').length).toBeGreaterThan(0);
  });
});

describe('a graph fed only by an exporter is not an empty graph', () => {
  /*
   * Spans normally arrive before the recording does, so "services and nothing
   * else" is the ordinary intermediate state rather than a corner. While
   * `getAppArchitecture` counted only the things a *person* had done, that
   * state answered `null` and every caller rendered it as "no graph" — the one
   * state Tier 2 introduced, indistinguishable from a fresh install.
   */
  it('reports a graph holding services and no recordings at all', () => {
    open();
    // No ingestFlow: nothing here was recorded by anybody yet.
    arkg.ingestTrace(project(), 'flow-not-yet-sent', null, NOW);
    expect(arkg.getServices().length).toBeGreaterThan(0);
    expect(arkg.getAppArchitecture()).not.toBeNull();
  });
});
