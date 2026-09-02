/**
 * OpenTelemetry spans, and which of them may say anything about a recording.
 *
 * ## What Tier 2 is, and what the header already bought
 *
 * Tier 1 put an id on a request. Its whole value is that the id is *also* in
 * the user's backend logs, so a person can go and grep for it — which is worth
 * having and is not correlation. This is the other end: the backend's own
 * tracer exports the spans it recorded under that id, DevFlow receives them,
 * and the request the recording watched leave the browser is joined to the work
 * it caused on the far side. That join is the FE → BE → DB chain the roadmap
 * promises, and it is the reason `traceparent`'s sampled flag is `01`.
 *
 * Pure, and for `core/trace`'s reason rather than by habit: the decisions here
 * are which spans are admissible, what a span is allowed to become in a graph
 * that outlives the recording, and what to do with a trace nobody recorded.
 * None of those should need an HTTP server on a port to exercise. The receiving
 * and the storing are `mcp-server/otel.js`.
 *
 * ## Everything below was measured against a real exporter, not read off a spec
 *
 * A throwaway service was built with `@opentelemetry/sdk-trace-node`, pointed
 * at a capturing endpoint, and made to continue a `traceparent` of exactly the
 * shape `core/trace` mints. Four facts came out of it that the specification
 * does not put anywhere near as plainly, and three of them would have been got
 * wrong by reasoning:
 *
 * 1. **Spans arrive leaf-first, children before parents.** A span is exported
 *    when it *ends*, and a child ends before its parent. The `SELECT` at depth
 *    three arrived in the first request and the root server span in the third.
 *    So nothing here may assume a parent has been seen, `buildSpanTree` takes
 *    the whole accumulated set rather than one delivery, and the receiver
 *    stores before it joins.
 *
 * 2. **The root span's parent will never arrive.** The backend parents its
 *    server span on the `traceparent` DevFlow sent — so `parentSpanId` names
 *    DevFlow's own client span, and DevFlow is not an OTel SDK and emits no
 *    spans. A parent that is absent is therefore the *ordinary* case and not a
 *    dropped delivery, which is why `buildSpanTree` roots on "parent not
 *    present" rather than on "no parent".
 *
 * 3. **Timestamps do not fit in a `number`.** `startTimeUnixNano` arrives as a
 *    JSON *string* of unix nanoseconds — `1788364167363000000`, which is larger
 *    than `Number.MAX_SAFE_INTEGER` by two orders of magnitude. Parsing one
 *    with `Number()` silently loses the low digits, and the loss lands exactly
 *    on the sub-millisecond end of a duration. They are subtracted as `BigInt`
 *    and only the *difference* — which is small — becomes a `number`.
 *
 * 4. **Ids are hex in OTLP/JSON and raw bytes in OTLP/protobuf.** That is the
 *    whole of why this reads JSON only; see below.
 *
 * ## Where a value a user can see actually appears in a trace — measured again
 *
 * Work Stream 3.2 searches spans for a value somebody read off the screen, and
 * that question was put to a second live capture rather than reasoned about:
 * express + knex + better-sqlite3 under `@opentelemetry/auto-instrumentations-node`,
 * OTLP/JSON to a capturing endpoint, continuing a `traceparent` of exactly the
 * shape `core/trace` mints. Four results, and the design was wrong before it:
 *
 * 5. **A response body is nowhere in a trace.** No auto-instrumented span
 *    carried it, on any path. A `POST` whose JSON body held the value produced
 *    a server span with no body attribute of any kind. Nothing here should ever
 *    imply otherwise.
 *
 * 6. **The value appears in exactly three places, and two of them were being
 *    dropped.** `url.query` on a server span and the query inside `url.full` on
 *    a client span — `?amount=1284.00` in plain sight — and
 *    `exception.stacktrace`, which carries the driver's own message. Both are
 *    read now. The third is `db.postgresql.values`, which is a named gap below.
 *
 * 7. **A failed query's stack trace holds the SQL its own span does not.** On
 *    the same span, `db.query.text` said `where id = ?` while the
 *    `exception.stacktrace` said `where id = '8814'` — the driver interpolates
 *    when it formats the error. So the *failure* path is the richest evidence
 *    in a trace, which is exactly backwards from the intuition, and it is the
 *    path somebody asking "why is this value wrong" is on.
 *
 * 8. **`db.query.text` carries a literal only when the application built the
 *    SQL by interpolation.** Real knex/pg/mysql2 emit `= ?` and `= $1`; the
 *    same instrumentation emits `where id = 8814` the moment the callsite
 *    concatenates. Neither "the value is in the query" nor "it never is" is
 *    true, and anything built on either belief is built on a coin flip.
 *
 * **`code.filepath` is not a fact about instrumentation, it is a fact about the
 * application.** Of the 41 official Node instrumentations, exactly one sets it
 * and that one is a Cucumber runner recording a `.feature` path. `readCode`
 * below is not wrong and is not wasted — a hand-instrumented service does set
 * it — but any renderer presenting "the handler is at `file:line`" as the
 * ordinary case is describing the rare one.
 *
 * **`db.postgresql.values` is a named gap.** `pg` with
 * `enhancedDatabaseReporting` puts the bind values — the literals a
 * parameterised `db.query.text` is missing — into an OTLP `arrayValue`, and
 * `readAnyValue` deliberately returns `null` for composite values rather than
 * writing `[object Object]` into somebody's graph. Closing it means teaching
 * `readAnyValue` about arrays, which is a wire-format decision worth taking on
 * its own rather than in the tail of a work stream.
 *
 * ## OTLP/JSON only, and protobuf named as the gap
 *
 * `application/x-protobuf` is the exporter default and is refused, with the
 * one line of exporter configuration that fixes it in the refusal. Two reasons,
 * and the second is the real one. A protobuf decoder is a second wire format to
 * get exactly right, and the failure mode of a subtly wrong varint is not an
 * error — it is a plausible number written into somebody's graph. And the user
 * is already editing exporter configuration to point it at DevFlow at all, so
 * `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json` beside the URL they must set
 * anyway is not a step, it is a word. A hand-rolled decoder would be this
 * repository asserting a fact about a foreign format nobody had run, which is
 * the shape of the last two defects mutation-testing found here.
 *
 * ## A span is an event; a graph needs something that outlives one
 *
 * This is the `caused_by` rule again and it bites harder here than anywhere.
 * A span has a random 64-bit id, happens once, and is never seen again — so a
 * node per span would be a node per request, and the ARKG would stop being an
 * accumulation and start being a log. What *is* stable across recordings is the
 * **service** (`service.name`, chosen by whoever deployed it) and the
 * **operation** (that service plus the span's name — `checkout-api` /
 * `GET /api/v1/invoices`). Those are the two node kinds, and a span is an
 * observation *of* an operation, exactly as a network call is an observation of
 * an endpoint.
 *
 * Span names are supposed to be low-cardinality and instrumentations sometimes
 * get it wrong, putting an invoice id in the name. That is the same hazard the
 * endpoint table already solved, so `operationName` collapses opaque path
 * segments the same way — reusing the rule rather than writing a second one
 * that disagrees. It collapses *only* path-shaped runs, because a span name is
 * the user's own instrumentation's word for the thing and rewriting more of it
 * than necessary would make DevFlow's graph disagree with their tracing UI.
 *
 * ## A trace nobody recorded projects onto one node, so it is not a fact
 *
 * The rule the whole graph is built on: a link reaches it only when *both* ends
 * project onto something the graph already keys stably. A span whose trace id
 * matches no recorded call has one end — it is a real thing that really
 * happened in the user's backend, and DevFlow has nothing to attach it to and
 * no business inventing a node to hold it.
 *
 * It is not dropped on arrival, though, and the measurement is why: **spans
 * normally arrive before the recording does.** The backend exports within
 * seconds of the request; the user reviews the flow and presses Send whenever
 * they are ready. Dropping unjoined spans would therefore drop very nearly all
 * of them. So the receiver holds them, and the join runs at flow ingest as well
 * as at span ingest — which also means re-sending a recording is how a trace
 * that arrived late gets joined, the same way re-ingest is how `changed_in`
 * reaches a file the graph only learned about later.
 *
 * The holding store is bounded and expires, because it is fed by an
 * unauthenticated endpoint. What it is *not* is a security boundary: a trace id
 * is 128 random bits, so a page that wants to attach a fabricated span to a
 * real recording has to guess one. Filling the store is the reachable nuisance,
 * and the cap is the answer to it.
 */

import { pos1, type Pos1 } from '../react/positions.js';
import type { FlowPayload } from '../../shared/types.js';

/* ── The wire, as the exporter actually writes it ─────────────────────────── */

/**
 * `Span.kind`, which arrives as a number.
 *
 * Named here rather than compared as integers at the use site because `2` is
 * `SERVER` and `3` is `CLIENT` and there is no reading of the code that makes
 * that memorable. The values are OTLP's and are frozen by the protocol.
 */
export type SpanKind = 'unspecified' | 'internal' | 'server' | 'client' | 'producer' | 'consumer';

const KINDS: readonly SpanKind[] = [
  'unspecified',
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
];

/** `Status.code`: 0 unset, 1 OK, 2 ERROR. Only 2 is a failure. */
const STATUS_ERROR = 2;

/**
 * One span, flattened out of the three levels OTLP nests it under.
 *
 * The resource is repeated onto every span deliberately. OTLP groups spans
 * under a resource to save bytes on the wire, and every consumer of this wants
 * to know which service a span belongs to while holding the span — so the
 * grouping is undone once, here, rather than by every caller carrying a pair.
 */
export interface OtelSpan {
  traceId: string;
  spanId: string;
  /** Absent when the span is a root, and absent when its parent is elsewhere. */
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  /** `service.name` from the resource. Every OTel SDK sets it. */
  service: string;
  serviceVersion: string | null;
  environment: string | null;
  /** Unix nanoseconds, kept as the string it arrived as — see the header. */
  startUnixNano: string;
  durationMs: number;
  /** `status.code === 2`. An unset status is not a failure. */
  failed: boolean;
  statusMessage: string | null;
  /** HTTP and database attributes, kept flat and only where present. */
  http: {
    method: string | null;
    path: string | null;
    status: number | null;
    /** The query string, which is where a value most often travels in plain sight. */
    query: string | null;
  } | null;
  db: { system: string | null; statement: string | null; collection: string | null } | null;
  /** `code.filepath` and `code.lineno`, when the instrumentation records them. */
  code: { file: string; line: Pos1 | null } | null;
  /** The first `exception` event, which is where a stack trace and message live. */
  exception: {
    type: string | null;
    message: string | null;
    /** The driver's own text, which is measured to carry what the attributes do not. */
    stacktrace: string | null;
  } | null;
}

/**
 * Why one span in an otherwise-good payload was not kept.
 *
 * Separate reasons rather than a count, because they are four different things
 * to tell somebody whose spans are not appearing, and three of them are their
 * configuration rather than a bug here.
 */
export type SpanSkip = 'bad-trace-id' | 'bad-span-id' | 'no-name' | 'bad-time';

/** Why a whole delivery was refused. */
export type OtlpRejection =
  | 'not-json'
  | 'not-otlp'
  | 'protobuf'
  | 'empty';

export interface OtlpReading {
  spans: OtelSpan[];
  /** Per-reason counts for spans dropped out of an accepted payload. */
  skipped: Record<SpanSkip, number>;
}

const noSkips = (): Record<SpanSkip, number> => ({
  'bad-trace-id': 0,
  'bad-span-id': 0,
  'no-name': 0,
  'bad-time': 0,
});

/* ── Reading the payload ──────────────────────────────────────────────────── */

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/**
 * Whether a string is a usable trace id.
 *
 * Deliberately the same rule as `core/trace`'s `isTraceId` and deliberately not
 * an import of it: this one also has to accept **upper-case** hex. OTLP/JSON
 * says lower-case, the Node SDK writes lower-case, and other language SDKs have
 * historically not — so the wire is normalised on the way in and the id the
 * recording carries is compared against the normalised form. Importing the
 * injector's predicate would make a stricter reader of somebody else's output
 * out of a rule written about our own.
 */
export const readTraceId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const id = value.toLowerCase();
  return TRACE_ID.test(id) && !/^0+$/.test(id) ? id : null;
};

export const readSpanId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const id = value.toLowerCase();
  return SPAN_ID.test(id) && !/^0+$/.test(id) ? id : null;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * One OTLP `AnyValue` as something printable.
 *
 * Every scalar case is handled and the composite ones are not: an array or a
 * map attribute becomes `null` rather than a `[object Object]` written into a
 * graph. `intValue` is read as a string *or* a number on purpose — proto3's
 * JSON mapping says int64 goes on the wire as a string, and the Node SDK
 * emits `500` as a number anyway. Both were observed; both are accepted.
 */
function readAnyValue(value: unknown): string | number | boolean | null {
  if (!isRecord(value)) return null;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  if (typeof value.intValue === 'number') return value.intValue;
  if (typeof value.intValue === 'string') {
    const n = Number(value.intValue);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value.doubleValue === 'number') return value.doubleValue;
  return null;
}

/** An OTLP `KeyValue[]` as a flat map, dropping composite values. */
function readAttributes(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const entry of asArray(raw)) {
    if (!isRecord(entry) || typeof entry.key !== 'string') continue;
    const value = readAnyValue(entry.value);
    if (value !== null) out[entry.key] = value;
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A duration in milliseconds from two unix-nanosecond strings.
 *
 * `BigInt` because the inputs do not fit in a `number` — see the header, fact
 * three. Only the difference crosses back, and a duration that does not fit in
 * a `number` is a span that lasted a hundred thousand years, so it does not.
 * A negative or unreadable pair returns `null`, which is what makes `bad-time`
 * a skip reason rather than a `NaN` in the graph.
 */
export function durationMs(start: unknown, end: unknown): number | null {
  const a = readNano(start);
  const b = readNano(end);
  if (a === null || b === null || b < a) return null;
  return Number(b - a) / 1e6;
}

function readNano(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  const text =
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
  if (text === null || !/^\d+$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

/**
 * Read one OTLP/JSON `ExportTraceServiceRequest`.
 *
 * Takes the already-parsed body rather than the text, because whoever read the
 * request has to handle a `JSON.parse` failure anyway and this module has no
 * business deciding what a malformed HTTP body is. `'not-otlp'` is returned for
 * a body that parses and has no `resourceSpans` — a distinct answer from an
 * empty one, because the first is somebody posting the wrong thing here and the
 * second is an exporter with nothing to say.
 */
export function readOtlpTraces(body: unknown): OtlpReading | { rejected: OtlpRejection } {
  if (!isRecord(body)) return { rejected: 'not-otlp' };
  if (!Array.isArray(body.resourceSpans)) return { rejected: 'not-otlp' };
  if (body.resourceSpans.length === 0) return { rejected: 'empty' };

  const spans: OtelSpan[] = [];
  const skipped = noSkips();

  for (const resourceSpan of body.resourceSpans) {
    if (!isRecord(resourceSpan)) continue;
    const resource = isRecord(resourceSpan.resource)
      ? readAttributes(resourceSpan.resource.attributes)
      : {};
    const service = str(resource['service.name']) ?? UNNAMED_SERVICE;
    const serviceVersion = str(resource['service.version']);
    const environment =
      str(resource['deployment.environment.name']) ?? str(resource['deployment.environment']);

    for (const scopeSpan of asArray(resourceSpan.scopeSpans)) {
      if (!isRecord(scopeSpan)) continue;
      for (const raw of asArray(scopeSpan.spans)) {
        const span = readSpan(raw, service, serviceVersion, environment, skipped);
        if (span) spans.push(span);
      }
    }
  }

  return { spans, skipped };
}

/**
 * The name a service gets when the resource carries none.
 *
 * One node rather than one per anonymous deployment, on `stateStoreId`'s
 * argument: an unnamed thing collapsing into one node is a loss a reader can
 * see, and a node per unnamed thing is a graph that grows without anybody
 * noticing. Every OTel SDK sets `service.name`, so this is the pathological
 * case rather than the ordinary one.
 */
export const UNNAMED_SERVICE = '(unnamed service)';

function readSpan(
  raw: unknown,
  service: string,
  serviceVersion: string | null,
  environment: string | null,
  skipped: Record<SpanSkip, number>,
): OtelSpan | null {
  if (!isRecord(raw)) return null;

  const traceId = readTraceId(raw.traceId);
  if (!traceId) {
    skipped['bad-trace-id'] += 1;
    return null;
  }
  const spanId = readSpanId(raw.spanId);
  if (!spanId) {
    skipped['bad-span-id'] += 1;
    return null;
  }
  const name = str(raw.name);
  if (!name) {
    skipped['no-name'] += 1;
    return null;
  }
  const duration = durationMs(raw.startTimeUnixNano, raw.endTimeUnixNano);
  if (duration === null) {
    skipped['bad-time'] += 1;
    return null;
  }

  const attributes = readAttributes(raw.attributes);
  const status = isRecord(raw.status) ? raw.status : null;

  return {
    traceId,
    spanId,
    parentSpanId: readSpanId(raw.parentSpanId),
    name,
    kind: KINDS[typeof raw.kind === 'number' ? raw.kind : 0] ?? 'unspecified',
    service,
    serviceVersion,
    environment,
    /*
     * `String(...)` and not a fallback: `durationMs` above has already refused
     * anything this cannot read, so by here the field is a digit string or a
     * number. A `?? '0'` would be a default for a case that cannot arrive, and
     * a default nobody can reach is a claim about the code that is not true.
     */
    startUnixNano: String(raw.startTimeUnixNano),
    durationMs: duration,
    failed: num(status?.code) === STATUS_ERROR,
    statusMessage: str(status?.message),
    http: readHttp(attributes),
    db: readDb(attributes),
    code: readCode(attributes),
    exception: readException(raw.events),
  };
}

/**
 * HTTP attributes, reading the current names and the ones they replaced.
 *
 * OTel renamed these in the 1.x semantic-convention stabilisation —
 * `http.method` became `http.request.method`, `http.status_code` became
 * `http.response.status_code`, and `http.target`/`http.route` became
 * `url.path`. Both spellings are still in the field, because an application's
 * span names come from whatever instrumentation version it pinned. Reading only
 * the new ones would silently produce spans with no HTTP facts against every
 * slightly older service, which reads as "DevFlow does not understand my
 * backend" rather than as a version skew.
 */
function readHttp(attributes: Record<string, string | number | boolean>): OtelSpan['http'] {
  const method = str(attributes['http.request.method']) ?? str(attributes['http.method']);
  const path =
    str(attributes['url.path']) ?? str(attributes['http.route']) ?? str(attributes['http.target']);
  const status =
    num(attributes['http.response.status_code']) ?? num(attributes['http.status_code']);
  const query = readQueryString(attributes);
  return method || path || query || status !== null ? { method, path, status, query } : null;
}

/**
 * The query string, kept because it is where a value travels in plain sight.
 *
 * Measured, and it is one of only three places in a trace a value a user can
 * see was ever observed: a server span carries `url.query` and a client span
 * carries the whole `url.full`, so `?amount=1284.00` is right there while the
 * response body it eventually lands in is nowhere in the trace at all. Reading
 * only `url.path` — which is what this did — made the commonest case of a value
 * crossing the wire invisible to the layer built to find it.
 *
 * Cut out of `url.full` textually rather than with `new URL`. That constructor
 * has already been the source of one wrong load-bearing comment in this
 * repository, this string is whatever a foreign exporter wrote, and the
 * question here — "what is after the first `?` and before any `#`" — does not
 * need a parser to answer.
 */
function readQueryString(attributes: Record<string, string | number | boolean>): string | null {
  const own = str(attributes['url.query']);
  if (own) return own.replace(/^\?/, '') || null;
  /*
   * `http.target` last, and it is the reason the *path* above prefers the
   * route over it: the superseded spelling put the path and the query in one
   * string. Preferring the route loses the query, and this is where it is
   * picked back up. Unreachable from a current SDK — those code paths are gone
   * from the shipped instrumentations, measured — so it is for a service that
   * has pinned an old one, exactly like the spellings beside it.
   */
  const full =
    str(attributes['url.full']) ?? str(attributes['http.url']) ?? str(attributes['http.target']);
  if (!full) return null;
  const mark = full.indexOf('?');
  if (mark === -1) return null;
  const hash = full.indexOf('#', mark);
  return full.slice(mark + 1, hash === -1 ? undefined : hash) || null;
}

/** Database attributes, current names first and the superseded ones behind. */
function readDb(attributes: Record<string, string | number | boolean>): OtelSpan['db'] {
  const system = str(attributes['db.system.name']) ?? str(attributes['db.system']);
  const statement = str(attributes['db.query.text']) ?? str(attributes['db.statement']);
  const collection =
    str(attributes['db.collection.name']) ??
    str(attributes['db.sql.table']) ??
    str(attributes['db.mongodb.collection']);
  return system || statement || collection ? { system, statement, collection } : null;
}

/**
 * `code.filepath` and `code.lineno`.
 *
 * The line goes through `pos1` because OTel's `code.lineno` is what an editor
 * shows — 1-based — and this is exactly the edge `pos1` exists for: a number
 * arriving from a foreign system that is already 1-based. It is asserted, never
 * converted; there is no bridge back and none is wanted.
 */
function readCode(attributes: Record<string, string | number | boolean>): OtelSpan['code'] {
  const file = str(attributes['code.file.path']) ?? str(attributes['code.filepath']);
  if (!file) return null;
  const raw = num(attributes['code.line.number']) ?? num(attributes['code.lineno']);
  return { file, line: raw === null ? null : pos1(raw) };
}

/** The first `exception` event on a span, which is where a thrown error lands. */
function readException(events: unknown): OtelSpan['exception'] {
  for (const event of asArray(events)) {
    if (!isRecord(event) || event.name !== 'exception') continue;
    const attributes = readAttributes(event.attributes);
    return {
      type: str(attributes['exception.type']),
      message: str(attributes['exception.message']),
      stacktrace: str(attributes['exception.stacktrace']),
    };
  }
  return null;
}

/* ── Assembling a tree out of spans that arrived in any order ─────────────── */

export interface SpanNode {
  span: OtelSpan;
  children: SpanNode[];
  /** Depth from the root of the tree this node is in. */
  depth: number;
}

/**
 * The forest a set of spans makes.
 *
 * **Roots are spans whose parent is not in the set**, not spans with no parent,
 * and that is fact two from the header rather than a convenience: the backend
 * parents its top span on the `traceparent` DevFlow sent, so the ordinary root
 * names a span id that will never arrive because DevFlow emits no spans. A
 * `parentSpanId === null` test would find no roots at all in the common case
 * and return an empty forest for a perfectly good trace.
 *
 * A span whose `parentSpanId` points into a cycle is rooted rather than
 * dropped. Cycles cannot occur in a well-formed trace and can trivially be
 * posted by anything that can reach the endpoint, and the failure this guards
 * is the one that matters: an unbounded walk in a server handling a request.
 *
 * Ordering within a level is by start time, so reading the tree top to bottom
 * reads in the order the work happened. Ties keep arrival order, which makes
 * the output stable for a test.
 */
export function buildSpanTree(spans: readonly OtelSpan[]): SpanNode[] {
  const byId = new Map<string, OtelSpan>();
  for (const span of spans) if (!byId.has(span.spanId)) byId.set(span.spanId, span);

  const nodes = new Map<string, SpanNode>();
  for (const span of byId.values()) nodes.set(span.spanId, { span, children: [], depth: 0 });

  const roots: SpanNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.span.parentSpanId;
    const parent = parentId === null ? undefined : nodes.get(parentId);
    if (!parent || parent === node || descendsFrom(parent, node, nodes)) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  const byStart = (a: SpanNode, b: SpanNode) => compareNano(a.span.startUnixNano, b.span.startUnixNano);
  const settle = (node: SpanNode, depth: number) => {
    node.depth = depth;
    node.children.sort(byStart);
    for (const child of node.children) settle(child, depth + 1);
  };
  roots.sort(byStart);
  for (const root of roots) settle(root, 0);
  return roots;
}

/** Whether `candidate` is already below `node`, walking up from `candidate`. */
function descendsFrom(
  candidate: SpanNode,
  node: SpanNode,
  nodes: ReadonlyMap<string, SpanNode>,
): boolean {
  const seen = new Set<string>();
  let cursor: SpanNode | undefined = candidate;
  while (cursor) {
    if (cursor === node) return true;
    if (seen.has(cursor.span.spanId)) return true;
    seen.add(cursor.span.spanId);
    const parentId: string | null = cursor.span.parentSpanId;
    cursor = parentId === null ? undefined : nodes.get(parentId);
  }
  return false;
}

/** Numeric order over two unix-nanosecond strings, without going through a `number`. */
export function compareNano(a: string, b: string): number {
  const clean = (v: string) => (/^\d+$/.test(v) ? v.replace(/^0+(?=\d)/, '') : '0');
  const x = clean(a);
  const y = clean(b);
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Every node of a forest, parents before children. */
export function flattenTree(roots: readonly SpanNode[]): SpanNode[] {
  const out: SpanNode[] = [];
  const walk = (node: SpanNode) => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

/* ── The join ─────────────────────────────────────────────────────────────── */

/** One recorded request that carried a trace id, as the flow holds it. */
export interface TracedCall {
  traceId: string;
  /** The step the call belongs to, as the recording numbers steps. */
  step: number;
  method: string;
  url: string;
}

/**
 * The traced calls a recording carries.
 *
 * Here rather than in the server because there are now three callers of it —
 * the graph ingest, `get_backend_trace`, and the backend layer of
 * `core/provenance` — and two of them are on the other side of the bundle. A
 * second copy is how the step a tool *filters* on stops being the step it
 * *prints*: the server's own copy numbered steps by position while every
 * renderer beside it prefers the step's own `stepNumber`, so a flow whose
 * numbers do not match its positions filtered on one and printed the other.
 * DevFlow's sender renumbers on the way out, which is why nobody had seen it;
 * `POST /flows` accepts a flow from any page the browser visits, which is why
 * that is not a reason to leave two.
 *
 * A call has a `traceId` only when the injection rule allowed one — off by
 * default, only while recording, and only to an origin the user named — so on
 * almost every recording this is empty and the whole of Tier 2 costs nothing.
 */
export function tracedCallsOf(flow: FlowPayload): TracedCall[] {
  const out: TracedCall[] = [];
  /*
   * `Array.isArray` on both, though the types promise it. A flow arrives over
   * loopback from any page the browser visits and `POST /flows` validates its
   * id and little else, so `steps: 5` is a shape this has to survive rather
   * than a shape the compiler has ruled out.
   */
  const steps = Array.isArray(flow?.steps) ? flow.steps : [];
  steps.forEach((step, index) => {
    const number = typeof step?.stepNumber === 'number' ? step.stepNumber : index + 1;
    const calls = Array.isArray(step?.networkCalls) ? step.networkCalls : [];
    for (const call of calls) {
      const traceId = readTraceId(call?.traceId);
      if (!traceId) continue;
      out.push({
        traceId,
        step: number,
        method: typeof call?.method === 'string' && call.method ? call.method : 'GET',
        url: typeof call?.url === 'string' ? call.url : '',
      });
    }
  });
  return out;
}

/** One recorded call and the backend work found under its id. */
export interface TraceJoin {
  call: TracedCall;
  roots: SpanNode[];
  /** Every span under this trace, parents before children. */
  spans: OtelSpan[];
  /** Distinct `service.name`s the trace touched, in first-seen order. */
  services: string[];
}

export interface JoinResult {
  joined: TraceJoin[];
  /** Trace ids the recording carries that no span has arrived for. */
  awaiting: string[];
  /** Trace ids spans arrived for that this recording does not carry. */
  unrelated: string[];
}

/**
 * Cross what the recording carries against what the backend sent.
 *
 * Three outcomes rather than two, and the third is the honest one: a trace id
 * on a recorded call with no spans against it is *not* the same as a call that
 * was never traced, and telling a user "no backend data" when the real answer
 * is "your exporter has not sent it yet, or is not pointed here" sends them to
 * the wrong place entirely. `awaiting` is that distinction and every renderer
 * is expected to keep it.
 *
 * `unrelated` is spans held for traces this recording knows nothing about. It
 * is not an error and is not written to the graph — see the header on why a
 * trace with one end is not a fact — but it is worth counting, because "spans
 * are arriving and none of them are yours" and "no spans are arriving" are two
 * different configuration problems.
 */
export function joinTrace(input: {
  calls: readonly TracedCall[];
  spans: readonly OtelSpan[];
}): JoinResult {
  const spansByTrace = new Map<string, OtelSpan[]>();
  for (const span of input.spans) {
    const list = spansByTrace.get(span.traceId);
    if (list) list.push(span);
    else spansByTrace.set(span.traceId, [span]);
  }

  const joined: TraceJoin[] = [];
  const awaiting: string[] = [];
  const claimed = new Set<string>();

  for (const call of input.calls) {
    const traceId = readTraceId(call.traceId);
    if (!traceId) continue;
    const spans = spansByTrace.get(traceId);
    if (!spans || spans.length === 0) {
      if (!awaiting.includes(traceId)) awaiting.push(traceId);
      continue;
    }
    claimed.add(traceId);
    const roots = buildSpanTree(spans);
    const ordered = flattenTree(roots).map((node) => node.span);
    const services: string[] = [];
    for (const span of ordered) if (!services.includes(span.service)) services.push(span.service);
    joined.push({ call: { ...call, traceId }, roots, spans: ordered, services });
  }

  const unrelated = [...spansByTrace.keys()].filter((id) => !claimed.has(id));
  return { joined, awaiting, unrelated };
}

/* ── What a span is allowed to become in the graph ────────────────────────── */

/**
 * The name an operation node is keyed on.
 *
 * Opaque path segments collapse to `:id`, the same rule `normaliseUrl` applies
 * to endpoints — a span named `GET /api/v1/invoices/8814` and one named
 * `GET /api/v1/invoices/8815` are one operation observed twice, and keeping
 * them apart would make a node per invoice. The collapse is applied only to
 * slash-separated runs so that a span legitimately named `checkout.charge.v2`
 * is left exactly as its author wrote it.
 */
export function operationName(name: string): string {
  if (!name.includes('/')) return name;
  /*
   * The early return above is a short-circuit and nothing more — a name with no
   * slash is one segment at `index === 0`, which is exempt anyway, so deleting
   * that line changes no answer. **The `index === 0` exemption is the actual
   * rule** and deleting *it* silently rewrites `88814/orders` to `:id/orders`.
   * Said here because mutation-testing found exactly that asymmetry: the line
   * that looks load-bearing is not, and the clause that looks incidental is.
   */
  return name
    .split('/')
    .map((segment, index) => (index === 0 ? segment : isOpaque(segment) ? ':id' : segment))
    .join('/');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_BLOB = /^[0-9a-f]{16,}$/i;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{22,}$/;

function isOpaque(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    UUID.test(segment) ||
    HEX_BLOB.test(segment) ||
    OPAQUE_TOKEN.test(segment)
  );
}

/** One service, as the graph keys it. */
export interface ServiceObservation {
  name: string;
  version: string | null;
  environment: string | null;
}

/** One operation, as the graph keys it, plus this sighting's numbers. */
export interface OperationObservation {
  service: string;
  name: string;
  kind: SpanKind;
  durationMs: number;
  failed: boolean;
  /** Where the handler is written, when the instrumentation said. */
  file: string | null;
  line: Pos1 | null;
}

/** One edge a joined trace justifies. */
export type OtelEdge =
  /** The recorded request → the operation that answered it. */
  | { type: 'calls'; from: { kind: 'endpoint'; method: string; url: string }; to: OperationRef }
  /** One operation → the operation it caused. */
  | { type: 'calls'; from: OperationRef; to: OperationRef }
  /** An operation → the service it ran in. */
  | { type: 'runs_in'; from: OperationRef; to: { kind: 'service'; name: string } };

export interface OperationRef {
  kind: 'operation';
  service: string;
  name: string;
}

export interface OtelProjection {
  services: ServiceObservation[];
  operations: OperationObservation[];
  edges: OtelEdge[];
}

/**
 * What one joined trace may write into the graph.
 *
 * Every edge here has both ends on a node the graph keys stably, which is the
 * whole admission rule. The endpoint end comes from the recording — the call
 * DevFlow watched leave the browser, which already has an `api_endpoint` node —
 * and the operation end from a span. That is the join, and it is the only place
 * a browser observation and a backend observation meet.
 *
 * **Only root operations get the endpoint edge.** A root is what answered the
 * request; everything below it was caused by that, not by the browser, and
 * drawing `endpoint → SELECT invoices` would claim the page issued the query.
 * The chain to the query is the `calls` edges between operations, walked.
 *
 * A self-edge is refused for `caused_by`'s reason — an operation that
 * recursed is one node twice, and an edge from a node to itself says nothing
 * a reader can act on. Duplicate edges within one trace collapse: a handler
 * that made the same downstream call forty times is one edge observed once,
 * because `frequency` counts recordings and not button presses.
 */
export function projectTrace(join: TraceJoin): OtelProjection {
  const services = new Map<string, ServiceObservation>();
  const operations: OperationObservation[] = [];
  const edges: OtelEdge[] = [];
  const drawn = new Set<string>();

  const refOf = (span: OtelSpan): OperationRef => ({
    kind: 'operation',
    service: span.service,
    name: operationName(span.name),
  });

  const add = (edge: OtelEdge) => {
    const key = JSON.stringify(edge);
    if (drawn.has(key)) return;
    drawn.add(key);
    edges.push(edge);
  };

  for (const node of flattenTree(join.roots)) {
    const span = node.span;
    if (!services.has(span.service)) {
      services.set(span.service, {
        name: span.service,
        version: span.serviceVersion,
        environment: span.environment,
      });
    }

    const ref = refOf(span);
    operations.push({
      service: span.service,
      name: ref.name,
      kind: span.kind,
      durationMs: span.durationMs,
      failed: span.failed,
      file: span.code?.file ?? null,
      line: span.code?.line ?? null,
    });
    add({ type: 'runs_in', from: ref, to: { kind: 'service', name: span.service } });

    if (node.depth === 0) {
      add({
        type: 'calls',
        from: { kind: 'endpoint', method: join.call.method, url: join.call.url },
        to: ref,
      });
    }
    for (const child of node.children) {
      const childRef = refOf(child.span);
      if (childRef.service === ref.service && childRef.name === ref.name) continue;
      add({ type: 'calls', from: ref, to: childRef });
    }
  }

  return { services: [...services.values()], operations, edges };
}
