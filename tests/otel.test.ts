/**
 * Spans arriving from somebody else's tracer, and the ways that goes quietly
 * wrong.
 *
 * Every defect this suite exists to catch produces a *plausible* answer rather
 * than an error, which is why it is worth this much test for one pure module:
 *
 *   - a duration correct to three decimal places and wrong in the fourth,
 *     because a unix-nanosecond string went through `Number()` on its way in;
 *   - an HTTP method that is `null` because the service pinned an
 *     instrumentation from before the semantic-convention rename, which reads
 *     to its owner as "DevFlow does not understand my backend";
 *   - a perfectly good trace assembling into an *empty* forest because "root"
 *     was read as "has no parent", when the real root's parent is DevFlow's own
 *     client span and will never arrive;
 *   - an endpoint edge drawn to a `SELECT` three levels down, which is the
 *     graph claiming the page issued the query.
 *
 * None of those throw. They are written into a graph and read back later as
 * facts, so the fixture below is a real capture rather than a hand-written
 * approximation of one — an invented payload only ever proves that the reader
 * agrees with whoever invented it.
 */

import { describe, expect, it } from 'vitest';
import {
  UNNAMED_SERVICE,
  buildSpanTree,
  compareNano,
  durationMs,
  flattenTree,
  joinTrace,
  operationName,
  projectTrace,
  readOtlpTraces,
  readSpanId,
  readTraceId,
  type OtelSpan,
  type OtlpReading,
  type OtlpRejection,
  type SpanNode,
  type TracedCall,
} from '../src/core/otel/index.js';

/* ── The capture ──────────────────────────────────────────────────────────── */

/**
 * The wire, typed only as loosely as the module reads it.
 *
 * The index signatures are not laziness: the exporter writes `flags`,
 * `droppedLinksCount` and half a dozen other fields this module has no opinion
 * about, and a fixture that dropped them to satisfy a narrower type would stop
 * being the thing that came off the wire.
 */
interface WireValue {
  stringValue?: string;
  intValue?: number | string;
  boolValue?: boolean;
  doubleValue?: number;
  [key: string]: unknown;
}
interface WireKeyValue {
  key: string;
  value: WireValue;
}
interface WireEvent {
  name: string;
  timeUnixNano?: string;
  attributes?: WireKeyValue[];
  [key: string]: unknown;
}
interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: WireKeyValue[];
  events?: WireEvent[];
  status?: { code: number; message?: string };
  [key: string]: unknown;
}
interface WireResourceSpan {
  resource?: { attributes?: WireKeyValue[]; [key: string]: unknown };
  scopeSpans?: { scope?: unknown; spans?: WireSpan[] }[];
  [key: string]: unknown;
}
interface WireDelivery {
  resourceSpans: WireResourceSpan[];
}

/**
 * Four real OTLP/JSON deliveries, in the order they arrived.
 *
 * Captured by standing up a throwaway service on `@opentelemetry/sdk-trace-node`
 * with `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json`, pointing its exporter at
 * a capturing HTTP endpoint, and making it continue a `traceparent` of exactly
 * the shape `src/core/trace` mints — trace id `4bf92f3577b34da6a3ce929d0e0e4736`,
 * DevFlow's client span id `00f067aa0ba902b7`. The bodies below are what that
 * endpoint received, unedited.
 *
 * Read the order: delivery one is the `SELECT` at depth three and delivery
 * three is the server span it hangs under. A span is exported when it *ends*,
 * and children end first, so the arrival order is the reverse of the tree — the
 * single fact most likely to be got wrong by reasoning about it instead.
 */
const CAPTURE: readonly WireDelivery[] = [
  {
    "resourceSpans": [
      {
        "resource": {
          "attributes": [
            {
              "key": "service.name",
              "value": {
                "stringValue": "checkout-api"
              }
            },
            {
              "key": "service.version",
              "value": {
                "stringValue": "2.4.1"
              }
            },
            {
              "key": "deployment.environment",
              "value": {
                "stringValue": "staging"
              }
            }
          ],
          "droppedAttributesCount": 0
        },
        "scopeSpans": [
          {
            "scope": {
              "name": "probe"
            },
            "spans": [
              {
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "spanId": "29abc6b630d1e717",
                "parentSpanId": "e014090292b7a0de",
                "name": "SELECT invoices",
                "kind": 3,
                "startTimeUnixNano": "1788364167355000000",
                "endTimeUnixNano": "1788364167355043667",
                "attributes": [
                  {
                    "key": "db.system.name",
                    "value": {
                      "stringValue": "postgresql"
                    }
                  },
                  {
                    "key": "db.namespace",
                    "value": {
                      "stringValue": "shop"
                    }
                  },
                  {
                    "key": "db.query.text",
                    "value": {
                      "stringValue": "SELECT total_amount FROM invoices WHERE id = $1"
                    }
                  },
                  {
                    "key": "db.collection.name",
                    "value": {
                      "stringValue": "invoices"
                    }
                  }
                ],
                "droppedAttributesCount": 0,
                "events": [],
                "droppedEventsCount": 0,
                "status": {
                  "code": 0
                },
                "links": [],
                "droppedLinksCount": 0,
                "flags": 257
              }
            ]
          }
        ]
      }
    ]
  },
  {
    "resourceSpans": [
      {
        "resource": {
          "attributes": [
            {
              "key": "service.name",
              "value": {
                "stringValue": "checkout-api"
              }
            },
            {
              "key": "service.version",
              "value": {
                "stringValue": "2.4.1"
              }
            },
            {
              "key": "deployment.environment",
              "value": {
                "stringValue": "staging"
              }
            }
          ],
          "droppedAttributesCount": 0
        },
        "scopeSpans": [
          {
            "scope": {
              "name": "probe"
            },
            "spans": [
              {
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "spanId": "e014090292b7a0de",
                "parentSpanId": "7cb4a6ed1dd21e14",
                "name": "InvoiceService.list",
                "kind": 1,
                "startTimeUnixNano": "1788364167355000000",
                "endTimeUnixNano": "1788364167362472291",
                "attributes": [],
                "droppedAttributesCount": 0,
                "events": [],
                "droppedEventsCount": 0,
                "status": {
                  "code": 0
                },
                "links": [],
                "droppedLinksCount": 0,
                "flags": 257
              }
            ]
          }
        ]
      }
    ]
  },
  {
    "resourceSpans": [
      {
        "resource": {
          "attributes": [
            {
              "key": "service.name",
              "value": {
                "stringValue": "checkout-api"
              }
            },
            {
              "key": "service.version",
              "value": {
                "stringValue": "2.4.1"
              }
            },
            {
              "key": "deployment.environment",
              "value": {
                "stringValue": "staging"
              }
            }
          ],
          "droppedAttributesCount": 0
        },
        "scopeSpans": [
          {
            "scope": {
              "name": "probe"
            },
            "spans": [
              {
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "spanId": "7cb4a6ed1dd21e14",
                "parentSpanId": "00f067aa0ba902b7",
                "name": "GET /api/v1/invoices",
                "kind": 2,
                "startTimeUnixNano": "1788364167355000000",
                "endTimeUnixNano": "1788364167362949250",
                "attributes": [
                  {
                    "key": "http.request.method",
                    "value": {
                      "stringValue": "GET"
                    }
                  },
                  {
                    "key": "url.path",
                    "value": {
                      "stringValue": "/api/v1/invoices"
                    }
                  },
                  {
                    "key": "http.response.status_code",
                    "value": {
                      "intValue": 200
                    }
                  },
                  {
                    "key": "server.address",
                    "value": {
                      "stringValue": "localhost"
                    }
                  },
                  {
                    "key": "server.port",
                    "value": {
                      "intValue": 8000
                    }
                  },
                  {
                    "key": "code.filepath",
                    "value": {
                      "stringValue": "app/controllers/invoice_controller.py"
                    }
                  },
                  {
                    "key": "code.lineno",
                    "value": {
                      "intValue": 45
                    }
                  },
                  {
                    "key": "code.function",
                    "value": {
                      "stringValue": "list_invoices"
                    }
                  }
                ],
                "droppedAttributesCount": 0,
                "events": [],
                "droppedEventsCount": 0,
                "status": {
                  "code": 0
                },
                "links": [],
                "droppedLinksCount": 0,
                "flags": 769
              }
            ]
          }
        ]
      }
    ]
  },
  {
    "resourceSpans": [
      {
        "resource": {
          "attributes": [
            {
              "key": "service.name",
              "value": {
                "stringValue": "checkout-api"
              }
            },
            {
              "key": "service.version",
              "value": {
                "stringValue": "2.4.1"
              }
            },
            {
              "key": "deployment.environment",
              "value": {
                "stringValue": "staging"
              }
            }
          ],
          "droppedAttributesCount": 0
        },
        "scopeSpans": [
          {
            "scope": {
              "name": "probe"
            },
            "spans": [
              {
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "spanId": "875ddf3c4ff485f0",
                "parentSpanId": "00f067aa0ba902b7",
                "name": "POST /api/v1/charge",
                "kind": 2,
                "startTimeUnixNano": "1788364167363000000",
                "endTimeUnixNano": "1788364167363163542",
                "attributes": [
                  {
                    "key": "http.request.method",
                    "value": {
                      "stringValue": "POST"
                    }
                  },
                  {
                    "key": "url.path",
                    "value": {
                      "stringValue": "/api/v1/charge"
                    }
                  },
                  {
                    "key": "http.response.status_code",
                    "value": {
                      "intValue": 500
                    }
                  }
                ],
                "droppedAttributesCount": 0,
                "events": [
                  {
                    "attributes": [
                      {
                        "key": "exception.type",
                        "value": {
                          "stringValue": "Error"
                        }
                      },
                      {
                        "key": "exception.message",
                        "value": {
                          "stringValue": "card declined"
                        }
                      },
                      {
                        "key": "exception.stacktrace",
                        "value": {
                          "stringValue": "Error: card declined\n    at charge (app/services/billing.js:88:11)"
                        }
                      }
                    ],
                    "name": "exception",
                    "timeUnixNano": "1788364167363160542",
                    "droppedAttributesCount": 0
                  }
                ],
                "droppedEventsCount": 0,
                "status": {
                  "code": 2,
                  "message": "card declined"
                },
                "links": [],
                "droppedLinksCount": 0,
                "flags": 769
              }
            ]
          }
        ]
      }
    ]
  }
];

const [DB_DELIVERY, MID_DELIVERY, ROOT_DELIVERY, CHARGE_DELIVERY] = CAPTURE as [
  WireDelivery,
  WireDelivery,
  WireDelivery,
  WireDelivery,
];

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
/** DevFlow's own client span: named as a parent by both roots, never exported. */
const DEVFLOW_SPAN_ID = '00f067aa0ba902b7';

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Read a payload that is expected to be accepted, failing loudly if it is not. */
function accept(body: unknown): OtlpReading {
  const reading = readOtlpTraces(body);
  if ('rejected' in reading) throw new Error(`unexpectedly rejected: ${reading.rejected}`);
  return reading;
}

const rejection = (body: unknown): OtlpRejection | null => {
  const reading = readOtlpTraces(body);
  return 'rejected' in reading ? reading.rejected : null;
};

const spansOf = (...deliveries: WireDelivery[]): OtelSpan[] =>
  deliveries.flatMap((delivery) => accept(delivery).spans);

const only = (delivery: WireDelivery): OtelSpan => {
  const [span] = accept(delivery).spans;
  if (!span) throw new Error('expected one span');
  return span;
};

/** A copy of a captured delivery with fields overwritten on its single span. */
function patchSpan(delivery: WireDelivery, patch: Record<string, unknown>): WireDelivery {
  const copy = clone(delivery);
  const span = copy.resourceSpans[0]?.scopeSpans?.[0]?.spans?.[0] as Record<string, unknown>;
  Object.assign(span, patch);
  return copy;
}

/** A copy of a captured delivery carrying exactly the attributes given. */
const withAttributes = (delivery: WireDelivery, attributes: WireKeyValue[]): WireDelivery =>
  patchSpan(delivery, { attributes });

/** A copy of a captured delivery carrying exactly the resource attributes given. */
function withResource(delivery: WireDelivery, attributes: WireKeyValue[] | null): WireDelivery {
  const copy = clone(delivery);
  const resourceSpan = copy.resourceSpans[0];
  if (attributes === null) delete resourceSpan.resource;
  else resourceSpan.resource = { attributes };
  return copy;
}

const text = (key: string, value: string): WireKeyValue => ({ key, value: { stringValue: value } });
const int = (key: string, value: number | string): WireKeyValue => ({
  key,
  value: { intValue: value },
});

const ALL_SPANS = spansOf(...CAPTURE);
const byName = (name: string): OtelSpan => {
  const found = ALL_SPANS.find((span) => span.name === name);
  if (!found) throw new Error(`no span named ${name}`);
  return found;
};

/** A fully-formed span, for the cases the four captured ones do not reach. */
function span(overrides: Partial<OtelSpan> = {}): OtelSpan {
  return {
    traceId: TRACE_ID,
    spanId: 'aaaaaaaaaaaaaaa1',
    parentSpanId: null,
    name: 'op',
    kind: 'internal',
    service: 'svc',
    serviceVersion: null,
    environment: null,
    startUnixNano: '1788364167355000000',
    durationMs: 1,
    failed: false,
    statusMessage: null,
    http: null,
    db: null,
    code: null,
    exception: null,
    ...overrides,
  };
}

const call = (extra: Partial<TracedCall> = {}): TracedCall => ({
  traceId: TRACE_ID,
  step: 3,
  method: 'GET',
  url: 'https://shop.example/api/v1/invoices',
  ...extra,
});

const shape = (nodes: readonly SpanNode[]): unknown =>
  nodes.map((node) => ({ name: node.span.name, depth: node.depth, children: shape(node.children) }));

/* ── Reading one delivery at a time ───────────────────────────────────────── */

describe('reading the deliveries a real exporter sent', () => {
  it('reads the depth-three database span out of the first delivery', () => {
    expect(only(DB_DELIVERY)).toMatchObject({
      traceId: TRACE_ID,
      spanId: '29abc6b630d1e717',
      parentSpanId: 'e014090292b7a0de',
      name: 'SELECT invoices',
      kind: 'client',
      service: 'checkout-api',
      serviceVersion: '2.4.1',
      environment: 'staging',
      failed: false,
      db: {
        system: 'postgresql',
        statement: 'SELECT total_amount FROM invoices WHERE id = $1',
        collection: 'invoices',
      },
      http: null,
      code: null,
      exception: null,
    });
  });

  it('reads the internal span out of the second delivery with no http or db facts', () => {
    expect(only(MID_DELIVERY)).toMatchObject({
      spanId: 'e014090292b7a0de',
      parentSpanId: '7cb4a6ed1dd21e14',
      name: 'InvoiceService.list',
      kind: 'internal',
      http: null,
      db: null,
    });
  });

  it('reads the server span, its route and where the handler is written', () => {
    expect(only(ROOT_DELIVERY)).toMatchObject({
      spanId: '7cb4a6ed1dd21e14',
      parentSpanId: DEVFLOW_SPAN_ID,
      name: 'GET /api/v1/invoices',
      kind: 'server',
      http: { method: 'GET', path: '/api/v1/invoices', status: 200 },
      code: { file: 'app/controllers/invoice_controller.py', line: 45 },
      failed: false,
      statusMessage: null,
    });
  });

  it('reads the failure, its message and the exception event behind it', () => {
    expect(only(CHARGE_DELIVERY)).toMatchObject({
      spanId: '875ddf3c4ff485f0',
      parentSpanId: DEVFLOW_SPAN_ID,
      name: 'POST /api/v1/charge',
      kind: 'server',
      failed: true,
      statusMessage: 'card declined',
      http: { method: 'POST', path: '/api/v1/charge', status: 500 },
      exception: { type: 'Error', message: 'card declined' },
    });
  });

  it('keeps the start time as the string it arrived as', () => {
    // Round-tripping it through a `number` here would lose the low digits
    // before `compareNano` ever sees it, and the tree would sort by a lie.
    expect(only(ROOT_DELIVERY).startUnixNano).toBe('1788364167355000000');
  });

  it('reads all four deliveries into one trace with nothing skipped', () => {
    const merged = { resourceSpans: CAPTURE.flatMap((delivery) => delivery.resourceSpans) };
    const reading = accept(merged);

    expect(reading.spans).toHaveLength(4);
    expect(new Set(reading.spans.map((s) => s.traceId))).toEqual(new Set([TRACE_ID]));
    expect(reading.spans.map((s) => s.kind)).toEqual(['client', 'internal', 'server', 'server']);
    expect(reading.skipped).toEqual({
      'bad-trace-id': 0,
      'bad-span-id': 0,
      'no-name': 0,
      'bad-time': 0,
    });
  });

  it('repeats the resource onto every span rather than leaving it above them', () => {
    for (const s of ALL_SPANS) {
      expect(s.service).toBe('checkout-api');
      expect(s.serviceVersion).toBe('2.4.1');
      expect(s.environment).toBe('staging');
    }
  });

  it('gives each resourceSpans group its own service', () => {
    const merged = {
      resourceSpans: [
        ...withResource(ROOT_DELIVERY, [text('service.name', 'checkout-api')]).resourceSpans,
        ...withResource(DB_DELIVERY, [text('service.name', 'invoice-db-proxy')]).resourceSpans,
      ],
    };

    expect(accept(merged).spans.map((s) => s.service)).toEqual([
      'checkout-api',
      'invoice-db-proxy',
    ]);
  });

  it('prefers the current environment attribute over the one it replaced', () => {
    const both = withResource(ROOT_DELIVERY, [
      text('service.name', 'checkout-api'),
      text('deployment.environment', 'staging'),
      text('deployment.environment.name', 'production'),
    ]);

    expect(only(both).environment).toBe('production');
  });

  /*
   * One node for every anonymous deployment rather than one each: a collapse a
   * reader can see beats a graph that grows a node per unnamed service without
   * anybody noticing it happening.
   */
  it('names a resource with no service.name once, not once per delivery', () => {
    expect(only(withResource(ROOT_DELIVERY, [])).service).toBe(UNNAMED_SERVICE);
    expect(only(withResource(ROOT_DELIVERY, null)).service).toBe(UNNAMED_SERVICE);
    expect(only(withResource(ROOT_DELIVERY, [text('service.name', '')])).service).toBe(
      UNNAMED_SERVICE,
    );
    expect(only(withResource(ROOT_DELIVERY, [])).serviceVersion).toBeNull();
    expect(only(withResource(ROOT_DELIVERY, [])).environment).toBeNull();
  });

  it('maps every span kind the protocol defines and refuses to invent one', () => {
    const kindOf = (kind: unknown) => only(patchSpan(ROOT_DELIVERY, { kind })).kind;

    expect(kindOf(0)).toBe('unspecified');
    expect(kindOf(1)).toBe('internal');
    expect(kindOf(2)).toBe('server');
    expect(kindOf(3)).toBe('client');
    expect(kindOf(4)).toBe('producer');
    expect(kindOf(5)).toBe('consumer');
    // Out of range, missing, and the string a hand-written client would send.
    expect(kindOf(6)).toBe('unspecified');
    expect(kindOf(-1)).toBe('unspecified');
    expect(kindOf(undefined)).toBe('unspecified');
    expect(kindOf('2')).toBe('unspecified');
  });

  /*
   * `status.code` is 0 unset, 1 OK, 2 ERROR, and only 2 is a failure. Reading
   * "anything non-zero" as failure would mark every explicitly-OK span as an
   * error, which is a report full of failures that did not happen.
   */
  it('counts only status code 2 as a failure', () => {
    const failedFor = (status: unknown) => only(patchSpan(CHARGE_DELIVERY, { status })).failed;

    expect(failedFor({ code: 2, message: 'card declined' })).toBe(true);
    expect(failedFor({ code: 1 })).toBe(false);
    expect(failedFor({ code: 0 })).toBe(false);
    expect(failedFor({})).toBe(false);
    expect(failedFor(undefined)).toBe(false);
    // A code that arrived as a string is not a number and so is not an error.
    expect(failedFor({ code: '2' })).toBe(false);
  });

  it('takes the first exception event and ignores the events around it', () => {
    const withEvents = patchSpan(CHARGE_DELIVERY, {
      events: [
        { name: 'retrying', attributes: [text('exception.type', 'Decoy')] },
        {
          name: 'exception',
          attributes: [text('exception.type', 'CardError'), text('exception.message', 'declined')],
        },
        { name: 'exception', attributes: [text('exception.type', 'Later')] },
      ],
    });

    expect(only(withEvents).exception).toEqual({
      type: 'CardError',
      message: 'declined',
      stacktrace: null,
    });
    expect(only(patchSpan(CHARGE_DELIVERY, { events: [] })).exception).toBeNull();
    expect(only(patchSpan(CHARGE_DELIVERY, { events: undefined })).exception).toBeNull();
  });

  /*
   * The stack trace, and the measurement that made it worth keeping.
   *
   * On one span of a real capture, `db.query.text` said `where id = ?` while
   * the `exception.stacktrace` on that same span said `where id = '8814'` — the
   * driver interpolates when it formats its own error message. So a failed
   * query's stack trace holds the literal SQL its own attribute does not, which
   * makes the *failure* path the richest evidence a trace carries. That is
   * backwards from the intuition and it is the path somebody asking why a value
   * is wrong is already on. The string below is that capture's, verbatim.
   */
  it('keeps the stack trace, which carries what the query attribute does not', () => {
    const trace =
      'SqliteError: select * from `no_such_table` where `id` = \'8814\' limit 1 - no such table: no_such_table\n' +
      '    at Database.prepare (/x/node_modules/better-sqlite3/lib/methods/wrappers.js:5:21)';
    const span = only(
      patchSpan(CHARGE_DELIVERY, {
        events: [
          {
            name: 'exception',
            attributes: [
              text('exception.type', 'SqliteError'),
              text('exception.message', 'no such table: no_such_table'),
              text('exception.stacktrace', trace),
            ],
          },
        ],
      }),
    );

    expect(span.exception?.stacktrace).toBe(trace);
    expect(span.exception?.stacktrace).toContain("= '8814'");
  });

  it('reports a stack trace that is absent as null rather than as an empty string', () => {
    const span = only(
      patchSpan(CHARGE_DELIVERY, {
        events: [{ name: 'exception', attributes: [text('exception.type', 'Error')] }],
      }),
    );
    expect(span.exception).toEqual({ type: 'Error', message: null, stacktrace: null });
  });
});

/* ── Semantic conventions, both spellings ─────────────────────────────────── */

describe('the semantic-convention rename, read from both sides of it', () => {
  const httpOf = (attributes: WireKeyValue[]) => only(withAttributes(ROOT_DELIVERY, attributes)).http;
  const dbOf = (attributes: WireKeyValue[]) => only(withAttributes(ROOT_DELIVERY, attributes)).db;
  const codeOf = (attributes: WireKeyValue[]) => only(withAttributes(ROOT_DELIVERY, attributes)).code;

  it('reads the superseded http spellings a slightly older service still emits', () => {
    expect(
      httpOf([
        text('http.method', 'PUT'),
        text('http.target', '/legacy/path'),
        int('http.status_code', 404),
      ]),
    ).toEqual({ method: 'PUT', path: '/legacy/path', status: 404, query: null });
  });

  it('prefers the current http spelling when a payload carries both', () => {
    expect(
      httpOf([
        text('http.method', 'PUT'),
        text('http.request.method', 'PATCH'),
        text('http.target', '/old'),
        text('url.path', '/new'),
        int('http.status_code', 404),
        int('http.response.status_code', 204),
      ]),
    ).toEqual({ method: 'PATCH', path: '/new', status: 204, query: null });
  });

  it('prefers the route over the target, because the target carries the query', () => {
    expect(httpOf([text('http.route', '/invoices/{id}'), text('http.target', '/invoices/7?x=1')])).toEqual(
      // The route wins the path, and the query the route does not have is read
      // back off the target rather than lost — which is the whole reason this
      // preference needed a test in the first place.
      { method: null, path: '/invoices/{id}', status: null, query: 'x=1' },
    );
  });

  /*
   * The query string, and why it is read at all.
   *
   * A second live capture — express + knex + better-sqlite3 under
   * `@opentelemetry/auto-instrumentations-node`, OTLP/JSON — was made to answer
   * where a value a user can *see* actually appears in a trace. The answer was
   * that a response body appears nowhere, and that the value appears in exactly
   * three places: `url.query` on a server span, the query inside `url.full` on
   * a client span, and `exception.stacktrace`. Two of the three were being
   * dropped. The strings below are that capture's, verbatim.
   */
  it('reads the query string a server span carries, which is where a value travels in plain sight', () => {
    expect(httpOf([text('url.path', '/fx'), text('url.query', 'ref=1284.00&customer=Aurora')])).toEqual({
      method: null,
      path: '/fx',
      status: null,
      query: 'ref=1284.00&customer=Aurora',
    });
  });

  it('cuts the query out of a client span’s url.full, which is the only place it has one', () => {
    expect(
      httpOf([text('url.full', 'http://localhost:4500/fx?amount=1284.00&invoice=8814')]),
    ).toEqual({
      method: null,
      path: null,
      status: null,
      query: 'amount=1284.00&invoice=8814',
    });
  });

  it('stops the query at a fragment, and reports none when there is no question mark', () => {
    expect(httpOf([text('url.full', 'https://shop.test/a?x=1#frag')])?.query).toBe('x=1');
    /*
     * A trailing `?` is not a query, and an empty string must not read as one.
     *
     * The second assertion is the one that decides it, and the first cannot:
     * with no other http fact present, an empty query and a null query both
     * make the whole object null, so the two are indistinguishable there.
     * Mutation-testing found exactly that — dropping the `|| null` survived a
     * fixture that had only the empty case. The decision lives where some
     * *other* fact keeps the object alive and the query has to say which of
     * "there was none" and "there was an empty one" it means.
     */
    expect(httpOf([text('url.full', 'https://shop.test/a?')])).toBeNull();
    expect(httpOf([text('url.path', '/a'), text('url.full', 'https://shop.test/a?')])).toEqual({
      method: null,
      path: '/a',
      status: null,
      query: null,
    });
    expect(httpOf([text('url.query', '?x=1')])?.query).toBe('x=1');
  });

  /*
   * A named gap, asserted so that closing it is a decision rather than a
   * surprise: **the path of a client span is not read.**
   *
   * `url.full` is the only URL attribute a client span was measured to carry —
   * no `url.path`, no `http.route` — and `readHttp` takes the path from those
   * three and not from `url.full`. So a `url.full` with no query contributes
   * nothing at all and the whole object is null. That is not what a reader
   * would guess, and it is why the assertion below is `toBeNull()` rather than
   * a path. Closing it means deciding what the path of `http://h:4500/fx` is
   * without `new URL`, which is a wire-format decision of its own; the query is
   * what Work Stream 3.2 needed and the query is what was taken.
   */
  it('takes no path out of url.full, so a client span with no query has no http facts', () => {
    expect(httpOf([text('url.full', 'https://shop.test/a')])).toBeNull();
    expect(httpOf([text('url.full', 'https://shop.test/a?x=1')])).toEqual({
      method: null,
      path: null,
      status: null,
      query: 'x=1',
    });
  });

  it('prefers the span’s own url.query over the one inside url.full', () => {
    expect(
      httpOf([text('url.query', 'own=1'), text('url.full', 'https://shop.test/a?inside=2')])?.query,
    ).toBe('own=1');
  });

  it('reports no http facts rather than an object of nulls', () => {
    expect(httpOf([text('db.system', 'postgresql')])).toBeNull();
    expect(httpOf([])).toBeNull();
    // One fact is enough to make the object worth having, including a bare 0.
    expect(httpOf([int('http.response.status_code', 0)])).toEqual({
      method: null,
      path: null,
      status: 0,
      query: null,
    });
  });

  it('reads the superseded db spellings', () => {
    expect(
      dbOf([
        text('db.system', 'mysql'),
        text('db.statement', 'SELECT 1'),
        text('db.sql.table', 'invoices'),
      ]),
    ).toEqual({ system: 'mysql', statement: 'SELECT 1', collection: 'invoices' });

    expect(dbOf([text('db.mongodb.collection', 'orders')])).toEqual({
      system: null,
      statement: null,
      collection: 'orders',
    });
  });

  it('prefers the current db spelling when a payload carries both', () => {
    expect(
      dbOf([
        text('db.system', 'mysql'),
        text('db.system.name', 'postgresql'),
        text('db.statement', 'SELECT old'),
        text('db.query.text', 'SELECT new'),
        text('db.sql.table', 'old_table'),
        text('db.collection.name', 'new_table'),
      ]),
    ).toEqual({ system: 'postgresql', statement: 'SELECT new', collection: 'new_table' });
  });

  it('reports no db facts rather than an object of nulls', () => {
    expect(dbOf([text('http.method', 'GET')])).toBeNull();
  });

  it('reads the superseded code spellings, and prefers the current pair', () => {
    expect(codeOf([text('code.filepath', 'app/old.py'), int('code.lineno', 45)])).toEqual({
      file: 'app/old.py',
      line: 45,
    });

    expect(
      codeOf([
        text('code.filepath', 'app/old.py'),
        text('code.file.path', 'app/new.py'),
        int('code.lineno', 45),
        int('code.line.number', 91),
      ]),
    ).toEqual({ file: 'app/new.py', line: 91 });
  });

  /*
   * A line with no file is an editor link that cannot be built, so the file is
   * what makes the pair worth keeping — not the other way round.
   */
  it('keeps a file with no line and drops a line with no file', () => {
    expect(codeOf([text('code.file.path', 'app/new.py')])).toEqual({
      file: 'app/new.py',
      line: null,
    });
    expect(codeOf([int('code.line.number', 91)])).toBeNull();
  });
});

/* ── AnyValue ─────────────────────────────────────────────────────────────── */

describe('the shapes an attribute value arrives in', () => {
  /*
   * proto3's JSON mapping puts an int64 on the wire as a *string*; the Node SDK
   * that produced the capture emits `200` as a number anyway. Reading only one
   * of those makes every status code from half the SDKs in the field vanish.
   */
  it('reads intValue as a number and as the string proto3 specifies', () => {
    const asNumber = only(withAttributes(ROOT_DELIVERY, [int('http.response.status_code', 200)]));
    const asString = only(withAttributes(ROOT_DELIVERY, [int('http.response.status_code', '200')]));

    expect(asNumber.http?.status).toBe(200);
    expect(asString.http?.status).toBe(200);
  });

  it('reads a stringified line number the same way', () => {
    expect(
      only(
        withAttributes(ROOT_DELIVERY, [text('code.file.path', 'app/x.py'), int('code.lineno', '45')]),
      ).code,
    ).toEqual({ file: 'app/x.py', line: 45 });
  });

  it('drops an intValue string that is not a number rather than writing NaN', () => {
    const span = only(
      withAttributes(ROOT_DELIVERY, [
        text('http.request.method', 'GET'),
        int('http.response.status_code', 'not-a-number'),
      ]),
    );

    expect(span.http).toEqual({ method: 'GET', path: null, status: null, query: null });
  });

  it('reads doubleValue, boolValue and stringValue, and drops composite values', () => {
    const span = only(
      withAttributes(ROOT_DELIVERY, [
        { key: 'http.response.status_code', value: { doubleValue: 204 } },
        { key: 'http.request.method', value: { stringValue: 'GET' } },
        { key: 'http.route', value: { boolValue: true } },
        { key: 'url.path', value: { arrayValue: { values: [] } } },
      ]),
    );

    // A boolean route and an array path are not strings, so neither reaches the
    // graph as `[object Object]` or as `"true"`.
    expect(span.http).toEqual({ method: 'GET', path: null, status: 204, query: null });
  });

  it('ignores entries with no key and values that are not objects', () => {
    const span = only(
      withAttributes(ROOT_DELIVERY, [
        { value: { stringValue: 'GET' } } as unknown as WireKeyValue,
        'http.request.method' as unknown as WireKeyValue,
        { key: 'http.request.method', value: 'GET' as unknown as WireValue },
      ]),
    );

    expect(span.http).toBeNull();
  });
});

/* ── Rejections and skips ─────────────────────────────────────────────────── */

describe('refusing a whole delivery', () => {
  it('calls a body that is not an OTLP request not-otlp', () => {
    expect(rejection(null)).toBe('not-otlp');
    expect(rejection(undefined)).toBe('not-otlp');
    expect(rejection('resourceSpans')).toBe('not-otlp');
    expect(rejection(42)).toBe('not-otlp');
    // An array is an object and is still not an `ExportTraceServiceRequest`.
    expect(rejection([{ resourceSpans: [] }])).toBe('not-otlp');
    expect(rejection({})).toBe('not-otlp');
    expect(rejection({ resourceSpans: {} })).toBe('not-otlp');
    expect(rejection({ resourceSpans: null })).toBe('not-otlp');
  });

  /*
   * Separate from `not-otlp` because they send the reader to different places:
   * an empty `resourceSpans` is an exporter with nothing to say and a missing
   * one is somebody posting the wrong thing at this endpoint.
   */
  it('distinguishes an exporter with nothing to say from the wrong payload', () => {
    expect(rejection({ resourceSpans: [] })).toBe('empty');
    expect(rejection({ resourceSpans: [{}] })).toBeNull();
  });

  it('accepts a payload whose groups are all unreadable rather than refusing it', () => {
    // `empty` is about the delivery, not about the yield: a group full of
    // rubbish is still a delivery that happened and is reported as zero spans.
    const reading = accept({ resourceSpans: [{}, null, { scopeSpans: [null, {}] }] });
    expect(reading.spans).toEqual([]);
  });

  /*
   * `not-json` and `protobuf` are on `OtlpRejection` and are deliberately not
   * reachable from here — this function takes an already-parsed body, so the
   * parse failure and the `application/x-protobuf` content type are decided by
   * the receiver in `mcp-server/otel.js` before it is called. Asserting that
   * keeps a later refactor from quietly deciding a protobuf body is `not-otlp`
   * and losing the one refusal that carries the fix in its message.
   */
  it('leaves not-json and protobuf to the receiver that reads the request', () => {
    const reasons: OtlpRejection[] = ['not-json', 'not-otlp', 'protobuf', 'empty'];
    expect(reasons).toHaveLength(4);

    const bodies: unknown[] = [null, 'ProtoBuf ', {}, { resourceSpans: [] }, []];
    for (const body of bodies) {
      const reason = rejection(body);
      expect(reason === 'not-otlp' || reason === 'empty').toBe(true);
    }
  });
});

describe('skipping one span out of a good delivery', () => {
  const skipsOf = (patch: Record<string, unknown>) => accept(patchSpan(ROOT_DELIVERY, patch)).skipped;
  const reasonOf = (patch: Record<string, unknown>) => {
    const skipped = skipsOf(patch);
    const reasons = Object.entries(skipped).filter(([, count]) => count > 0);
    expect(accept(patchSpan(ROOT_DELIVERY, patch)).spans).toEqual([]);
    expect(reasons).toHaveLength(1);
    return reasons[0]?.[0];
  };

  it('counts a bad trace id', () => {
    expect(reasonOf({ traceId: '0'.repeat(32) })).toBe('bad-trace-id');
    expect(reasonOf({ traceId: 'abc' })).toBe('bad-trace-id');
    expect(reasonOf({ traceId: `${TRACE_ID}00` })).toBe('bad-trace-id');
    expect(reasonOf({ traceId: TRACE_ID.replace('4', 'g') })).toBe('bad-trace-id');
    expect(reasonOf({ traceId: undefined })).toBe('bad-trace-id');
    expect(reasonOf({ traceId: 42 })).toBe('bad-trace-id');
  });

  it('counts a bad span id', () => {
    expect(reasonOf({ spanId: '0'.repeat(16) })).toBe('bad-span-id');
    expect(reasonOf({ spanId: '7cb4a6ed1dd21e1' })).toBe('bad-span-id');
    expect(reasonOf({ spanId: undefined })).toBe('bad-span-id');
  });

  it('counts a missing name', () => {
    expect(reasonOf({ name: undefined })).toBe('no-name');
    expect(reasonOf({ name: '' })).toBe('no-name');
    expect(reasonOf({ name: 42 })).toBe('no-name');
  });

  it('counts an unreadable or impossible time', () => {
    expect(reasonOf({ endTimeUnixNano: undefined })).toBe('bad-time');
    expect(reasonOf({ startTimeUnixNano: undefined })).toBe('bad-time');
    expect(reasonOf({ endTimeUnixNano: '1788364167354000000' })).toBe('bad-time');
    expect(reasonOf({ startTimeUnixNano: '-1788364167355000000' })).toBe('bad-time');
    expect(reasonOf({ endTimeUnixNano: 'soon' })).toBe('bad-time');
    expect(reasonOf({ endTimeUnixNano: '1.788e18' })).toBe('bad-time');
  });

  /*
   * A span that started and ended inside the same nanosecond is a real span
   * that a clock could not resolve, not a broken one — dropping it would lose
   * every fast in-process operation on a coarse timer.
   */
  it('keeps a span whose start and end are the same instant', () => {
    const instant = patchSpan(ROOT_DELIVERY, { endTimeUnixNano: '1788364167355000000' });
    expect(only(instant).durationMs).toBe(0);
  });

  it('reads the whole delivery and counts each reason separately', () => {
    const broken = {
      resourceSpans: [
        {
          resource: { attributes: [text('service.name', 'checkout-api')] },
          scopeSpans: [
            {
              spans: [
                clone(ROOT_DELIVERY).resourceSpans[0]?.scopeSpans?.[0]?.spans?.[0],
                { ...clone(ROOT_DELIVERY).resourceSpans[0]?.scopeSpans?.[0]?.spans?.[0], name: '' },
                { ...clone(ROOT_DELIVERY).resourceSpans[0]?.scopeSpans?.[0]?.spans?.[0], traceId: 'x' },
                {
                  ...clone(ROOT_DELIVERY).resourceSpans[0]?.scopeSpans?.[0]?.spans?.[0],
                  spanId: '0000000000000000',
                },
                null,
                'a span',
              ],
            },
          ],
        },
      ],
    };

    const reading = accept(broken);
    expect(reading.spans).toHaveLength(1);
    expect(reading.skipped).toEqual({
      'bad-trace-id': 1,
      'bad-span-id': 1,
      'no-name': 1,
      'bad-time': 0,
    });
  });

  /*
   * OTLP/JSON says lower-case hex and the Node SDK writes lower-case; other
   * language SDKs have historically not. Refusing upper case would be applying
   * a rule written about DevFlow's own ids to somebody else's output.
   */
  it('normalises an upper-case id instead of skipping it', () => {
    const shouty = patchSpan(ROOT_DELIVERY, {
      traceId: TRACE_ID.toUpperCase(),
      spanId: '7CB4A6ED1DD21E14',
      parentSpanId: DEVFLOW_SPAN_ID.toUpperCase(),
    });

    expect(only(shouty)).toMatchObject({
      traceId: TRACE_ID,
      spanId: '7cb4a6ed1dd21e14',
      parentSpanId: DEVFLOW_SPAN_ID,
    });
  });

  /*
   * An all-zero parent is what an SDK writes for "no parent", and it must read
   * as absent rather than as a parent nobody will ever send.
   */
  it('reads an absent or all-zero parent as no parent', () => {
    expect(only(patchSpan(ROOT_DELIVERY, { parentSpanId: undefined })).parentSpanId).toBeNull();
    expect(only(patchSpan(ROOT_DELIVERY, { parentSpanId: '' })).parentSpanId).toBeNull();
    expect(only(patchSpan(ROOT_DELIVERY, { parentSpanId: '0000000000000000' })).parentSpanId).toBeNull();
    // A malformed parent is dropped, not a reason to drop the span.
    expect(only(patchSpan(ROOT_DELIVERY, { parentSpanId: 'nope' })).parentSpanId).toBeNull();
  });

  it('reads an id predicate the same way on its own as inside a span', () => {
    expect(readTraceId(TRACE_ID)).toBe(TRACE_ID);
    expect(readTraceId(TRACE_ID.toUpperCase())).toBe(TRACE_ID);
    expect(readTraceId('0'.repeat(32))).toBeNull();
    expect(readTraceId(DEVFLOW_SPAN_ID)).toBeNull();
    expect(readSpanId(DEVFLOW_SPAN_ID)).toBe(DEVFLOW_SPAN_ID);
    expect(readSpanId('0'.repeat(16))).toBeNull();
    expect(readSpanId(TRACE_ID)).toBeNull();
    expect(readSpanId(null)).toBeNull();
  });
});

/* ── Nanoseconds ──────────────────────────────────────────────────────────── */

describe('nanosecond arithmetic that does not fit in a number', () => {
  /*
   * The capture's timestamps are ~1.79e18, two orders of magnitude past
   * `Number.MAX_SAFE_INTEGER`. `Number('1788364167355043667')` is
   * 1788364167355043600 — the low digits are gone, and they are exactly the
   * sub-millisecond end of the duration. This test is the guard on the BigInt
   * path: under `Number()` subtraction it reads 0.04352.
   */
  it('computes the real database span duration to the nanosecond', () => {
    expect(durationMs('1788364167355000000', '1788364167355043667')).toBe(0.043667);
    expect(byName('SELECT invoices').durationMs).toBe(0.043667);
  });

  it('computes every captured duration exactly', () => {
    expect(byName('InvoiceService.list').durationMs).toBe(7.472291);
    expect(byName('GET /api/v1/invoices').durationMs).toBe(7.94925);
    expect(byName('POST /api/v1/charge').durationMs).toBe(0.163542);
  });

  it('sees a one-nanosecond span that a double would round away entirely', () => {
    expect(durationMs('1788364167355000000', '1788364167355000001')).toBe(0.000001);
  });

  it('takes a bigint and a number as well as the string the wire carries', () => {
    expect(durationMs(1788364167355000000n, 1788364167355043667n)).toBe(0.043667);
    expect(durationMs(1_000, 2_500)).toBe(0.0015);
  });

  it('returns null rather than NaN for anything it cannot read', () => {
    expect(durationMs('1788364167355043667', '1788364167355000000')).toBeNull();
    expect(durationMs('', '1')).toBeNull();
    expect(durationMs('1e6', '2e6')).toBeNull();
    expect(durationMs('-1', '1')).toBeNull();
    expect(durationMs('1.5', '2')).toBeNull();
    expect(durationMs(null, '2')).toBeNull();
    expect(durationMs('1', undefined)).toBeNull();
    expect(durationMs(' 1 ', '2')).toBeNull();
  });

  /*
   * The ordering counterpart of the same hazard: these two differ in their last
   * digit and are equal as doubles, so a `Number()` comparison sorts a tree's
   * children into arrival order while looking like it sorted them.
   */
  it('orders two timestamps that are equal as doubles', () => {
    expect(compareNano('1788364167355043667', '1788364167355043668')).toBeLessThan(0);
    expect(compareNano('1788364167355043668', '1788364167355043667')).toBeGreaterThan(0);
    expect(compareNano('1788364167355043667', '1788364167355043667')).toBe(0);
  });

  it('orders by magnitude and not by string comparison', () => {
    // '9' > '10' as text; the length check is what makes it not.
    expect(compareNano('9', '10')).toBeLessThan(0);
    expect(compareNano('0000000000001788', '1788')).toBe(0);
    expect(compareNano('0', '0000')).toBe(0);
  });

  it('treats an unreadable timestamp as zero rather than throwing mid-sort', () => {
    expect(compareNano('nonsense', '1')).toBeLessThan(0);
    expect(compareNano('nonsense', 'rubbish')).toBe(0);
    expect(compareNano('', '0')).toBe(0);
  });
});

/* ── The tree ─────────────────────────────────────────────────────────────── */

describe('assembling the tree out of spans that arrived leaf-first', () => {
  /*
   * The capture arrived deepest-first, which is the ordinary case and not a
   * disorder: a span exports when it ends, and children end before parents.
   */
  it('assembles the four captured spans into the tree they were emitted from', () => {
    expect(shape(buildSpanTree(ALL_SPANS))).toEqual([
      {
        name: 'GET /api/v1/invoices',
        depth: 0,
        children: [
          {
            name: 'InvoiceService.list',
            depth: 1,
            children: [{ name: 'SELECT invoices', depth: 2, children: [] }],
          },
        ],
      },
      { name: 'POST /api/v1/charge', depth: 0, children: [] },
    ]);
  });

  /*
   * The whole of fact two. Both real roots name `00f067aa0ba902b7` — DevFlow's
   * own client span, from the `traceparent` the recorder injected — and DevFlow
   * is not an OTel SDK, so that span will never arrive. A `parentSpanId === null`
   * test finds no roots here at all and returns an empty forest for a trace
   * that is entirely well-formed.
   */
  it('roots on a parent that is not in the set, not on a span with no parent', () => {
    const roots = buildSpanTree(ALL_SPANS);

    expect(roots).toHaveLength(2);
    for (const root of roots) expect(root.span.parentSpanId).toBe(DEVFLOW_SPAN_ID);
    expect(ALL_SPANS.every((s) => s.parentSpanId !== null)).toBe(true);
  });

  it('re-parents onto the missing span the moment it does turn up', () => {
    const devflowSpan = span({ spanId: DEVFLOW_SPAN_ID, name: 'fetch /api/v1/invoices' });
    const roots = buildSpanTree([...ALL_SPANS, devflowSpan]);

    expect(roots.map((node) => node.span.name)).toEqual(['fetch /api/v1/invoices']);
    expect(roots[0]?.children.map((node) => node.span.name)).toEqual([
      'GET /api/v1/invoices',
      'POST /api/v1/charge',
    ]);
    expect(flattenTree(roots).map((node) => node.depth)).toEqual([0, 1, 2, 3, 1]);
  });

  it('orders a level by start time and keeps arrival order for a tie', () => {
    const parent = span({ spanId: 'aaaaaaaaaaaaaaaa', name: 'parent' });
    const child = (id: string, name: string, start: string) =>
      span({ spanId: id, name, parentSpanId: 'aaaaaaaaaaaaaaaa', startUnixNano: start });

    const roots = buildSpanTree([
      parent,
      child('bbbbbbbbbbbbbbbb', 'late', '1788364167355000002'),
      child('cccccccccccccccc', 'tied-second', '1788364167355000001'),
      child('dddddddddddddddd', 'early', '1788364167355000000'),
      child('eeeeeeeeeeeeeeee', 'tied-third', '1788364167355000001'),
    ]);

    expect(roots[0]?.children.map((node) => node.span.name)).toEqual([
      'early',
      'tied-second',
      'tied-third',
      'late',
    ]);
  });

  it('orders the roots by start time too', () => {
    const roots = buildSpanTree([...ALL_SPANS].reverse());
    expect(roots.map((node) => node.span.name)).toEqual([
      'GET /api/v1/invoices',
      'POST /api/v1/charge',
    ]);
  });

  it('keeps the first span when an id arrives twice', () => {
    const first = span({ spanId: 'aaaaaaaaaaaaaaaa', name: 'first' });
    const second = span({ spanId: 'aaaaaaaaaaaaaaaa', name: 'second' });

    expect(buildSpanTree([first, second]).map((node) => node.span.name)).toEqual(['first']);
  });

  /*
   * A cycle cannot happen in a well-formed trace and can trivially be posted by
   * anything that can reach an unauthenticated endpoint. The failure being
   * guarded is not a wrong tree, it is an unbounded walk inside a server that is
   * mid-request — so what matters is that this terminates and loses nothing.
   */
  it('roots a span that is its own parent rather than losing it or looping', () => {
    const self = span({ spanId: 'aaaaaaaaaaaaaaaa', parentSpanId: 'aaaaaaaaaaaaaaaa', name: 'self' });
    const roots = buildSpanTree([self]);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.children).toEqual([]);
    expect(roots[0]?.depth).toBe(0);
  });

  it('roots a pair of spans that point at each other', () => {
    const a = span({ spanId: 'aaaaaaaaaaaaaaaa', parentSpanId: 'bbbbbbbbbbbbbbbb', name: 'a' });
    const b = span({ spanId: 'bbbbbbbbbbbbbbbb', parentSpanId: 'aaaaaaaaaaaaaaaa', name: 'b' });

    const flattened = flattenTree(buildSpanTree([a, b]));
    expect(flattened.map((node) => node.span.name).sort()).toEqual(['a', 'b']);
    expect(flattened).toHaveLength(2);
  });

  it('survives a three-span cycle with a legitimate subtree hanging off it', () => {
    const ring = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
    const spans = ring.map((id, index) =>
      span({ spanId: id, parentSpanId: ring[(index + 2) % 3], name: `ring-${index}` }),
    );
    const leaf = span({ spanId: 'dddddddddddddddd', parentSpanId: ring[0], name: 'leaf' });

    const flattened = flattenTree(buildSpanTree([...spans, leaf]));
    expect(flattened).toHaveLength(4);
    expect(flattened.map((node) => node.span.name).sort()).toEqual([
      'leaf',
      'ring-0',
      'ring-1',
      'ring-2',
    ]);
  });

  it('makes an empty forest of no spans', () => {
    expect(buildSpanTree([])).toEqual([]);
    expect(flattenTree([])).toEqual([]);
  });

  it('flattens parents before children', () => {
    expect(flattenTree(buildSpanTree(ALL_SPANS)).map((node) => node.span.name)).toEqual([
      'GET /api/v1/invoices',
      'InvoiceService.list',
      'SELECT invoices',
      'POST /api/v1/charge',
    ]);
  });
});

/* ── The join ─────────────────────────────────────────────────────────────── */

describe('crossing the recording against what the backend sent', () => {
  it('joins the recorded call to the whole captured trace', () => {
    const result = joinTrace({ calls: [call()], spans: ALL_SPANS });

    expect(result.joined).toHaveLength(1);
    expect(result.awaiting).toEqual([]);
    expect(result.unrelated).toEqual([]);

    const [join] = result.joined;
    expect(join?.call.step).toBe(3);
    expect(join?.roots).toHaveLength(2);
    expect(join?.services).toEqual(['checkout-api']);
    expect(join?.spans.map((s) => s.name)).toEqual([
      'GET /api/v1/invoices',
      'InvoiceService.list',
      'SELECT invoices',
      'POST /api/v1/charge',
    ]);
  });

  it('lists the services a trace touched once each, in first-seen order', () => {
    const spans = [
      span({ spanId: 'aaaaaaaaaaaaaaaa', service: 'checkout-api' }),
      span({ spanId: 'bbbbbbbbbbbbbbbb', parentSpanId: 'aaaaaaaaaaaaaaaa', service: 'billing' }),
      span({ spanId: 'cccccccccccccccc', parentSpanId: 'bbbbbbbbbbbbbbbb', service: 'checkout-api' }),
    ];

    expect(joinTrace({ calls: [call()], spans }).joined[0]?.services).toEqual([
      'checkout-api',
      'billing',
    ]);
  });

  /*
   * The three-way split is the point of this function. "Your exporter has not
   * sent it yet" and "this call was never traced" are two different problems
   * with two different fixes, and collapsing them into "no backend data" sends
   * the reader to the wrong one — which matters more here than anywhere,
   * because spans normally arrive *before* the recording does.
   */
  it('separates a traced call still waiting for spans from one never traced', () => {
    const untraced = call({ traceId: '', step: 1, url: 'https://shop.example/health' });
    const waiting = call({ traceId: 'a'.repeat(32), step: 2 });

    const result = joinTrace({ calls: [untraced, waiting], spans: [] });

    expect(result.awaiting).toEqual(['a'.repeat(32)]);
    expect(result.joined).toEqual([]);
    expect(result.unrelated).toEqual([]);
  });

  it('drops a call whose trace id is unreadable from every one of the three lists', () => {
    const result = joinTrace({
      calls: [call({ traceId: 'not-a-trace-id' }), call({ traceId: '0'.repeat(32) })],
      spans: ALL_SPANS,
    });

    expect(result.joined).toEqual([]);
    expect(result.awaiting).toEqual([]);
    expect(result.unrelated).toEqual([TRACE_ID]);
  });

  it('names an awaited trace once however many calls carried it', () => {
    const id = 'b'.repeat(32);
    const result = joinTrace({
      calls: [call({ traceId: id, step: 1 }), call({ traceId: id, step: 2 })],
      spans: [],
    });

    expect(result.awaiting).toEqual([id]);
  });

  it('counts spans nobody recorded as unrelated rather than joining or dropping them', () => {
    const orphan = span({ traceId: 'c'.repeat(32), spanId: 'ffffffffffffffff' });
    const result = joinTrace({ calls: [call()], spans: [...ALL_SPANS, orphan] });

    expect(result.joined).toHaveLength(1);
    expect(result.unrelated).toEqual(['c'.repeat(32)]);
    expect(result.joined[0]?.spans).toHaveLength(4);
  });

  it('normalises the trace id the recording carries before matching and reporting it', () => {
    const result = joinTrace({ calls: [call({ traceId: TRACE_ID.toUpperCase() })], spans: ALL_SPANS });

    expect(result.joined).toHaveLength(1);
    expect(result.joined[0]?.call.traceId).toBe(TRACE_ID);
    expect(result.unrelated).toEqual([]);
  });

  it('joins two calls that share a trace id without double-claiming its spans', () => {
    const result = joinTrace({
      calls: [call({ step: 1 }), call({ step: 4 })],
      spans: ALL_SPANS,
    });

    expect(result.joined.map((join) => join.call.step)).toEqual([1, 4]);
    expect(result.unrelated).toEqual([]);
  });

  it('reports nothing at all for a recording with no traced calls', () => {
    expect(joinTrace({ calls: [], spans: [] })).toEqual({
      joined: [],
      awaiting: [],
      unrelated: [],
    });
  });
});

/* ── Operation names ──────────────────────────────────────────────────────── */

describe('the name an operation node is keyed on', () => {
  /*
   * Reusing `normaliseUrl`'s rule rather than writing a second one that
   * disagrees: two spans naming two invoices are one operation seen twice, and
   * keeping them apart is a node per invoice.
   */
  it('collapses an opaque path segment so two invoices are one operation', () => {
    expect(operationName('GET /api/v1/invoices/8814')).toBe('GET /api/v1/invoices/:id');
    expect(operationName('GET /api/v1/invoices/8815')).toBe('GET /api/v1/invoices/:id');
  });

  it('collapses uuids, long hex and opaque tokens', () => {
    expect(operationName('GET /users/3f2504e0-4f89-11d3-9a0c-0305e82c3301/cart')).toBe(
      'GET /users/:id/cart',
    );
    expect(operationName('GET /blobs/deadbeefdeadbeef01')).toBe('GET /blobs/:id');
    expect(operationName('GET /t/aBcDeFgHiJkLmNoPqRsTuV')).toBe('GET /t/:id');
  });

  /*
   * A span name is the user's own instrumentation's word for the thing.
   * Rewriting more of it than the hazard requires makes DevFlow's graph
   * disagree with the tracing UI they already have open.
   */
  it('leaves a name with no slash exactly as its author wrote it', () => {
    expect(operationName('checkout.charge.v2')).toBe('checkout.charge.v2');
    expect(operationName('SELECT invoices')).toBe('SELECT invoices');
    expect(operationName('88141234567890123456789012')).toBe('88141234567890123456789012');
    expect(operationName('')).toBe('');
  });

  it('leaves the first segment alone, because it is the verb and not a path part', () => {
    expect(operationName('88814/orders')).toBe('88814/orders');
    expect(operationName('GET /8814')).toBe('GET /:id');
  });

  it('leaves segments that are words, versions or short tokens', () => {
    expect(operationName('GET /api/v1/invoices')).toBe('GET /api/v1/invoices');
    expect(operationName('POST /api/v1/charge')).toBe('POST /api/v1/charge');
    // Twenty-one characters is below the opaque-token threshold; twenty-two is not.
    expect(operationName('GET /x/abcdefghijklmnopqrstu')).toBe('GET /x/abcdefghijklmnopqrstu');
    expect(operationName('GET /x/abcdefghijklmnopqrstuv')).toBe('GET /x/:id');
    // Fifteen hex characters is a word as far as this is concerned; sixteen is a blob.
    expect(operationName('GET /x/deadbeefdeadbee')).toBe('GET /x/deadbeefdeadbee');
    expect(operationName('GET /x/deadbeefdeadbeef')).toBe('GET /x/:id');
  });

  it('keeps every captured span name as the exporter wrote it', () => {
    for (const s of ALL_SPANS) expect(operationName(s.name)).toBe(s.name);
  });
});

/* ── The projection ───────────────────────────────────────────────────────── */

describe('what a joined trace may write into the graph', () => {
  const joinOf = (spans: OtelSpan[], recorded = call()) => {
    const [join] = joinTrace({ calls: [recorded], spans }).joined;
    if (!join) throw new Error('expected a join');
    return join;
  };

  const real = () => projectTrace(joinOf(ALL_SPANS));
  const endpointEdges = (projection: ReturnType<typeof projectTrace>) =>
    projection.edges.filter((edge) => edge.type === 'calls' && edge.from.kind === 'endpoint');

  it('records the service once, with the version and environment it reported', () => {
    expect(real().services).toEqual([
      { name: 'checkout-api', version: '2.4.1', environment: 'staging' },
    ]);
  });

  it('records one operation observation per span, parents before children', () => {
    expect(real().operations).toEqual([
      {
        service: 'checkout-api',
        name: 'GET /api/v1/invoices',
        kind: 'server',
        durationMs: 7.94925,
        failed: false,
        file: 'app/controllers/invoice_controller.py',
        line: 45,
      },
      {
        service: 'checkout-api',
        name: 'InvoiceService.list',
        kind: 'internal',
        durationMs: 7.472291,
        failed: false,
        file: null,
        line: null,
      },
      {
        service: 'checkout-api',
        name: 'SELECT invoices',
        kind: 'client',
        durationMs: 0.043667,
        failed: false,
        file: null,
        line: null,
      },
      {
        service: 'checkout-api',
        name: 'POST /api/v1/charge',
        kind: 'server',
        durationMs: 0.163542,
        failed: true,
        file: null,
        line: null,
      },
    ]);
  });

  it('runs every operation in a service', () => {
    const runsIn = real().edges.filter((edge) => edge.type === 'runs_in');

    expect(runsIn.map((edge) => edge.from.name)).toEqual([
      'GET /api/v1/invoices',
      'InvoiceService.list',
      'SELECT invoices',
      'POST /api/v1/charge',
    ]);
    for (const edge of runsIn) expect(edge.to).toEqual({ kind: 'service', name: 'checkout-api' });
  });

  /*
   * The one that would be wrong in a way nobody notices: an endpoint edge to
   * the `SELECT` says the browser issued the query. What the browser did was
   * call the endpoint; everything under the root was caused by the handler, and
   * the chain to the query is the `calls` edges between operations, walked.
   */
  it('draws the endpoint edge to the root operations and to nothing below them', () => {
    const edges = endpointEdges(real());

    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.from).toEqual({
        kind: 'endpoint',
        method: 'GET',
        url: 'https://shop.example/api/v1/invoices',
      });
    }
    expect(edges.map((edge) => edge.to.name)).toEqual([
      'GET /api/v1/invoices',
      'POST /api/v1/charge',
    ]);
  });

  it('draws one calls edge per parent-to-child hop', () => {
    const between = real().edges.filter(
      (edge) => edge.type === 'calls' && edge.from.kind === 'operation',
    );

    expect(between).toEqual([
      {
        type: 'calls',
        from: { kind: 'operation', service: 'checkout-api', name: 'GET /api/v1/invoices' },
        to: { kind: 'operation', service: 'checkout-api', name: 'InvoiceService.list' },
      },
      {
        type: 'calls',
        from: { kind: 'operation', service: 'checkout-api', name: 'InvoiceService.list' },
        to: { kind: 'operation', service: 'checkout-api', name: 'SELECT invoices' },
      },
    ]);
  });

  it('projects the whole captured trace into exactly eight edges', () => {
    expect(real().edges).toHaveLength(8);
  });

  /*
   * An operation that recursed is one node twice, and an edge from a node to
   * itself says nothing a reader can act on. The realistic way in is the
   * collapse above: `GET /orders/1` calling `GET /orders/2` is one operation
   * name at both ends.
   */
  it('refuses a self-edge when a child collapses onto its parent operation', () => {
    const parent = span({ spanId: 'aaaaaaaaaaaaaaaa', name: 'GET /orders/1' });
    const child = span({
      spanId: 'bbbbbbbbbbbbbbbb',
      parentSpanId: 'aaaaaaaaaaaaaaaa',
      name: 'GET /orders/2',
    });

    const projection = projectTrace(joinOf([parent, child]));

    expect(projection.operations.map((op) => op.name)).toEqual([
      'GET /orders/:id',
      'GET /orders/:id',
    ]);
    expect(projection.edges.filter((edge) => edge.from.kind === 'operation')).toEqual([
      {
        type: 'runs_in',
        from: { kind: 'operation', service: 'svc', name: 'GET /orders/:id' },
        to: { kind: 'service', name: 'svc' },
      },
    ]);
  });

  it('keeps an edge between two services that share an operation name', () => {
    const parent = span({ spanId: 'aaaaaaaaaaaaaaaa', name: 'handle', service: 'front' });
    const child = span({
      spanId: 'bbbbbbbbbbbbbbbb',
      parentSpanId: 'aaaaaaaaaaaaaaaa',
      name: 'handle',
      service: 'back',
    });

    const between = projectTrace(joinOf([parent, child])).edges.filter(
      (edge) => edge.type === 'calls' && edge.from.kind === 'operation',
    );

    expect(between).toEqual([
      {
        type: 'calls',
        from: { kind: 'operation', service: 'front', name: 'handle' },
        to: { kind: 'operation', service: 'back', name: 'handle' },
      },
    ]);
  });

  /*
   * `frequency` counts recordings, not button presses: a handler that made the
   * same downstream call forty times is one edge observed once. The forty
   * observations are still in `operations`, which is where a count belongs.
   */
  it('collapses duplicate edges inside one trace while keeping every observation', () => {
    const parent = span({ spanId: 'aaaaaaaaaaaaaaaa', name: 'GET /cart' });
    const children = ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'dddddddddddddddd'].map((id) =>
      span({ spanId: id, parentSpanId: 'aaaaaaaaaaaaaaaa', name: 'SELECT items', durationMs: 2 }),
    );

    const projection = projectTrace(joinOf([parent, ...children]));

    expect(projection.operations).toHaveLength(4);
    expect(projection.edges).toEqual([
      {
        type: 'runs_in',
        from: { kind: 'operation', service: 'svc', name: 'GET /cart' },
        to: { kind: 'service', name: 'svc' },
      },
      {
        type: 'calls',
        from: { kind: 'endpoint', method: 'GET', url: 'https://shop.example/api/v1/invoices' },
        to: { kind: 'operation', service: 'svc', name: 'GET /cart' },
      },
      {
        type: 'calls',
        from: { kind: 'operation', service: 'svc', name: 'GET /cart' },
        to: { kind: 'operation', service: 'svc', name: 'SELECT items' },
      },
      {
        type: 'runs_in',
        from: { kind: 'operation', service: 'svc', name: 'SELECT items' },
        to: { kind: 'service', name: 'svc' },
      },
    ]);
  });

  it('gives the endpoint edge to every root when a trace has more than one', () => {
    const projection = projectTrace(
      joinOf(
        [
          span({ spanId: 'aaaaaaaaaaaaaaaa', name: 'first', parentSpanId: DEVFLOW_SPAN_ID }),
          span({ spanId: 'bbbbbbbbbbbbbbbb', name: 'second', parentSpanId: DEVFLOW_SPAN_ID }),
        ],
        call({ method: 'POST', url: 'https://shop.example/checkout' }),
      ),
    );

    expect(endpointEdges(projection).map((edge) => edge.to.name)).toEqual(['first', 'second']);
    expect(endpointEdges(projection)[0]?.from).toEqual({
      kind: 'endpoint',
      method: 'POST',
      url: 'https://shop.example/checkout',
    });
  });

  it('records a service per name, taking the first version and environment seen', () => {
    const projection = projectTrace(
      joinOf([
        span({ spanId: 'aaaaaaaaaaaaaaaa', service: 'front', serviceVersion: '1.0', environment: 'prod' }),
        span({
          spanId: 'bbbbbbbbbbbbbbbb',
          parentSpanId: 'aaaaaaaaaaaaaaaa',
          service: 'front',
          serviceVersion: '1.1',
          environment: 'prod',
          name: 'inner',
        }),
      ]),
    );

    expect(projection.services).toEqual([{ name: 'front', version: '1.0', environment: 'prod' }]);
  });
});
