/**
 * The span holding store, and the endpoint that fills it.
 *
 * `src/core/otel` decides what a span is and what it may become. This is the
 * other half: the SQLite table the spans wait in and the request handler that
 * puts them there. Nothing here decides anything core already decided —
 * `readOtlpTraces` parses, `readTraceId` normalises, and the join and the
 * projection are read out of core at the moment somebody sends a recording.
 *
 * ## Why the spans have to wait at all
 *
 * Measured against a real exporter, not assumed: **spans arrive before the
 * recording does.** A backend exports within seconds of serving the request;
 * the person driving the browser reviews the flow and presses Send whenever
 * they are ready — a minute later, or after lunch. A receiver that dropped
 * every span it could not immediately attach to a recording would drop very
 * nearly all of them and the feature would look like it did not work. So the
 * store accepts unjoined spans as the ordinary case, and the join runs at flow
 * ingest as well as at span ingest. That is also why re-sending a recording is
 * how a trace that arrived late gets picked up.
 *
 * ## `DEVFLOW_OTEL=1`, and why that is the opposite way round from `DEVFLOW_GIT`
 *
 * `git.js` is on by default and `DEVFLOW_GIT=0` turns it off, and the argument
 * there was that it only *reads*, with a fixed argv, a directory this server
 * already opens files under. Every one of those three sentences is false here,
 * and the difference is not a matter of degree:
 *
 *   - **The input is unsolicited and from off the machine.** Every other input
 *     this server has is something the user caused — a recording they pressed
 *     Send on, a pick they clicked, a tool call a model made inside a session
 *     they started. An OTLP receiver is a socket that anything able to reach it
 *     may post to, whenever it likes, without anybody having asked.
 *   - **It writes.** A span that joins becomes `service` and `operation` nodes
 *     and `calls` edges in the ARKG — a graph that accumulates, that outlives
 *     the recording, and that a model is later asked to reason from. This is a
 *     write path into the thing the whole server exists to be trusted about.
 *   - **Nobody gets it by accident.** Turning this on is not the whole of the
 *     work: the user is already editing an exporter's configuration to point it
 *     at this URL. `DEVFLOW_OTEL=1` beside that is not a step, and defaulting
 *     to on would mean a port doing something on machines where nobody had
 *     decided it should.
 *
 * So the gate is the deliberate act and off is the default, which is the
 * inverse of `DEVFLOW_GIT` on purpose. It is an environment variable and not a
 * `config.json` key for that file's own reason: `POST /config` is reachable by
 * any page the browser visits, and a page that could set this would be choosing
 * whether a listener accepts writes.
 *
 * It is read per call, so a long-lived server picks up nothing stale.
 *
 * ## The caps, and what they are and are not for
 *
 * **This store is not a security boundary, and the caps are not pretending to
 * be one.** A trace id is 128 random bits. A page that wants to attach a
 * fabricated span to a real recording has to guess one, and if it could guess
 * one it would already be able to do worse things than lie about a database
 * query. What is actually reachable is volume: anything that can post here can
 * post a great deal, and an unbounded table on somebody's laptop is the whole
 * of the nuisance. So the answer is a bound — a cap on rows and a cap on age —
 * and not an authentication scheme that would be theatre in front of a random
 * 128-bit secret the sender already has to know.
 *
 * Retention runs off `received_at`, this machine's clock, and never off
 * `startUnixNano`, the sender's. A backend with a skewed clock is common and a
 * backend that lies about its clock is free; either one would have its spans
 * evicted on arrival, or never, if the age test were taken over a timestamp the
 * sender controls.
 *
 * ## OTLP/JSON only
 *
 * `application/x-protobuf` is the exporter default and it is refused here with
 * the one line of configuration that fixes it, rather than decoded. Core's
 * header carries the argument; the short version is that a subtly wrong varint
 * does not raise an error, it writes a plausible number into somebody's graph.
 *
 * ## What this file does not do, on purpose
 *
 * There is no HTTP server here and no route table. `handleOtlpPost` takes a
 * body and a content type and returns a status and a body, so the whole of the
 * endpoint's behaviour is exercisable without opening a port — and so the
 * transport decisions that belong to `server.js` (the body size it will read
 * off a socket at all, the path, whether the listener binds to localhost) stay
 * where the rest of this package's transport decisions are.
 */

import Database from 'better-sqlite3';

/*
 * Reached through the namespace and never by name, for `arkg.js`'s reason:
 * `core.js` is a build artefact and an installed copy of this package can be
 * older than the module a symbol comes from. A missing named import is a link
 * error that takes the server down at startup; a missing property costs this
 * one endpoint, which is the failure a feature nobody enabled already has.
 */
import * as core from './core.js';

// ── The gate ──────────────────────────────────────────────────────────────────

/**
 * Whether `DEVFLOW_OTEL=1` was set.
 *
 * A live binding rather than a snapshot taken at import: every entry point
 * below re-reads the environment through `otelEnabled()`, which refreshes this,
 * so a reader of `OTEL_ENABLED` gets the same answer the last call acted on.
 * Exactly `'1'` and not "anything truthy", because the value that turns a
 * listener on should be one people can grep for.
 */
export let OTEL_ENABLED = process.env.DEVFLOW_OTEL === '1';

function otelEnabled() {
  OTEL_ENABLED = process.env.DEVFLOW_OTEL === '1';
  return OTEL_ENABLED;
}

// ── Caps ──────────────────────────────────────────────────────────────────────

/**
 * How many spans may be held at once.
 *
 * A trace of ordinary depth is tens of spans, so this is on the order of a
 * thousand recordings' worth of backend work waiting to be claimed at the same
 * time — far more than the seconds-to-minutes gap this store exists to bridge
 * could ever fill honestly. At the couple of hundred bytes a row costs here it
 * is tens of megabytes at the very worst, which is a bound a laptop does not
 * notice and a flood cannot get past.
 */
const MAX_SPANS = 50_000;

/**
 * How long an unclaimed span is kept.
 *
 * The window that matters is between the backend exporting and the user
 * pressing Send, which is seconds to minutes. A day is orders of magnitude more
 * than that and still covers the real slow case — recorded something yesterday
 * evening, sent it this morning. Past that the recording is not coming: the
 * person has moved on, and a span kept for a week is a row that will be evicted
 * eventually having never once been read.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The largest body this will look at.
 *
 * The OTLP/HTTP default maximum export size is 4MiB and no conforming exporter
 * exceeds it. `server.js` owns what it will read off a socket in the first
 * place; this is the second bound, so that a caller which has not thought about
 * it cannot hand this function an arbitrarily large string to `JSON.parse`.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// ── Schema ────────────────────────────────────────────────────────────────────

/**
 * One row per span, keyed by `(trace_id, span_id)`.
 *
 * The key is the dedupe, and it is needed rather than tidy: OTel exporters
 * retry, and a delivery that timed out on the wire after being written here
 * arrives again in full. Keyed this way a re-delivery is a no-op; keyed by a
 * rowid it would be a second copy of a span, which `buildSpanTree` would then
 * have to disambiguate and `projectTrace` would count twice.
 *
 * **`start_unix_nano` is TEXT.** Unix nanoseconds are around 1.8e18 — two
 * orders of magnitude past `Number.MAX_SAFE_INTEGER` — so a REAL or an INTEGER
 * column reached through a JS `number` silently loses the low digits, and the
 * loss lands exactly on the sub-millisecond end of a duration. It arrived from
 * the exporter as a string and it leaves here as the same string; nothing in
 * this file does arithmetic on it. `compareNano` in core is how it is ordered.
 *
 * The four composite fields are JSON because they are payload this file never
 * queries on: nothing here asks "which spans had a 500", only "which spans are
 * under this trace". Columns for them would be sixteen more nullable columns to
 * keep in step with a shape core owns.
 */
const DDL = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS otel_spans (
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    parent_span_id TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    service TEXT NOT NULL,
    service_version TEXT,
    environment TEXT,
    start_unix_nano TEXT NOT NULL,
    duration_ms REAL NOT NULL,
    failed INTEGER NOT NULL DEFAULT 0,
    status_message TEXT,
    http_json TEXT,
    db_json TEXT,
    code_json TEXT,
    exception_json TEXT,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (trace_id, span_id)
  );

  CREATE INDEX IF NOT EXISTS otel_spans_trace ON otel_spans (trace_id);
  CREATE INDEX IF NOT EXISTS otel_spans_received ON otel_spans (received_at);
`;

/** The database, opened by `openSpanStore`. Null when the feature is off. */
let db = null;

/** Compiled statements, bound to the connection and dropped when it closes. */
const statements = new Map();

function sql(text) {
  let stmt = statements.get(text);
  if (!stmt) {
    stmt = db.prepare(text);
    statements.set(text, stmt);
  }
  return stmt;
}

/**
 * Open (or create) the span store.
 *
 * Idempotent, like `openArkg`, and returns the handle for the same reason: the
 * server ignores it and tests use it.
 *
 * **Returns `null` when `DEVFLOW_OTEL` is not `1`**, and creates no file. A
 * feature nobody enabled should leave nothing on disk to explain later, and the
 * readers below all degrade to an empty answer rather than throwing — so
 * `server.js` may call this unconditionally at startup and the gate is still
 * the only thing that decides whether anything happens.
 */
export function openSpanStore(dbPath) {
  if (!otelEnabled()) return null;
  if (db) return db;
  db = new Database(dbPath);
  db.exec(DDL);
  return db;
}

/** Close the store. Used in tests and for clean shutdown. */
export function closeSpanStore() {
  statements.clear();
  if (db) {
    db.close();
    db = null;
  }
}

// ── Writing ───────────────────────────────────────────────────────────────────

const INSERT = `
  INSERT OR IGNORE INTO otel_spans (
    trace_id, span_id, parent_span_id, name, kind, service, service_version,
    environment, start_unix_nano, duration_ms, failed, status_message,
    http_json, db_json, code_json, exception_json, received_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const json = (value) => (value === null || value === undefined ? null : JSON.stringify(value));

/**
 * Hold a batch of spans, and report what was new.
 *
 * `INSERT OR IGNORE`, so a re-delivered span is a duplicate rather than a
 * second row **and keeps its original `received_at`**. That second half is the
 * part worth stating: refreshing the timestamp on re-delivery would let an
 * exporter that retries forever keep a span past the age cap indefinitely,
 * which is the one way a retention rule can be defeated by ordinary,
 * well-behaved client behaviour.
 *
 * The caps are enforced here rather than only in `pruneSpanStore`, because a
 * bound that depends on somebody remembering to call a sweeper is not a bound.
 * `receivedAtMs` is a parameter so that a test can place a span in time; the
 * server passes nothing and gets the clock.
 */
export function storeSpans(spans, receivedAtMs = Date.now()) {
  if (!db || !Array.isArray(spans) || spans.length === 0) return { stored: 0, duplicates: 0 };

  const insert = sql(INSERT);
  const write = db.transaction((batch) => {
    let stored = 0;
    let duplicates = 0;
    for (const span of batch) {
      const result = insert.run(
        span.traceId,
        span.spanId,
        span.parentSpanId ?? null,
        span.name,
        span.kind,
        span.service,
        span.serviceVersion ?? null,
        span.environment ?? null,
        String(span.startUnixNano),
        span.durationMs,
        span.failed ? 1 : 0,
        span.statusMessage ?? null,
        json(span.http),
        json(span.db),
        json(span.code),
        json(span.exception),
        receivedAtMs,
      );
      if (result.changes > 0) stored += 1;
      else duplicates += 1;
    }
    return { stored, duplicates };
  });

  const counted = write(spans);
  enforceCaps(receivedAtMs);
  return counted;
}

// ── Reading ───────────────────────────────────────────────────────────────────

/**
 * How many trace ids go into one `IN (...)` list.
 *
 * SQLite's compiled variable limit is the thing being stayed under, and a
 * recording with hundreds of traced calls is entirely ordinary. Well below any
 * build's limit, and the chunking costs one extra query per five hundred.
 */
const CHUNK = 500;

const COLUMNS = `
  trace_id, span_id, parent_span_id, name, kind, service, service_version,
  environment, start_unix_nano, duration_ms, failed, status_message,
  http_json, db_json, code_json, exception_json
`;

/**
 * Every held span for these trace ids, in the shape core hands out.
 *
 * The ids go through core's `readTraceId` rather than being trusted or checked
 * again here — it is the same normalisation the write path applied, so an
 * upper-case id in a recording finds the lower-case rows an SDK exported, and
 * there is exactly one rule about what a trace id is.
 *
 * Rows come back in arrival order. Ordering is `buildSpanTree`'s job and it
 * sorts by start time itself; arrival order is what makes its documented
 * tie-break stable.
 */
export function spansForTraces(traceIds) {
  if (!db || !Array.isArray(traceIds) || traceIds.length === 0) return [];

  const wanted = [];
  for (const raw of traceIds) {
    const id = core.readTraceId(raw);
    if (id && !wanted.includes(id)) wanted.push(id);
  }
  if (wanted.length === 0) return [];

  const out = [];
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const holes = chunk.map(() => '?').join(', ');
    const rows = sql(
      `SELECT ${COLUMNS} FROM otel_spans WHERE trace_id IN (${holes}) ORDER BY rowid ASC`,
    ).all(...chunk);
    for (const row of rows) out.push(readRow(row));
  }
  return out;
}

const parse = (text) => (text === null || text === undefined ? null : JSON.parse(text));

function readRow(row) {
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    name: row.name,
    kind: row.kind,
    service: row.service,
    serviceVersion: row.service_version,
    environment: row.environment,
    startUnixNano: row.start_unix_nano,
    durationMs: row.duration_ms,
    failed: row.failed === 1,
    statusMessage: row.status_message,
    http: parse(row.http_json),
    db: parse(row.db_json),
    code: parse(row.code_json),
    exception: parse(row.exception_json),
  };
}

/**
 * What is being held.
 *
 * `oldestMs` and `newestMs` are arrival times on this machine's clock, not span
 * start times, because the question this answers is about retention — "is the
 * store keeping up" and "how far back does what is waiting go" — and not about
 * when anything happened in the user's backend.
 */
export function spanStoreStats() {
  if (!db) return { spans: 0, traces: 0, oldestMs: null, newestMs: null };
  const row = sql(`
    SELECT COUNT(*) AS spans,
           COUNT(DISTINCT trace_id) AS traces,
           MIN(received_at) AS oldest,
           MAX(received_at) AS newest
    FROM otel_spans
  `).get();
  return {
    spans: row.spans,
    traces: row.traces,
    oldestMs: row.oldest ?? null,
    newestMs: row.newest ?? null,
  };
}

/**
 * Enforce both caps. Age first, so the row cap is measured against what is left.
 *
 * Eviction is oldest-arrival-first and by `rowid` on a tie, which is arrival
 * order within the same millisecond. Evicting by start time instead would let a
 * sender with a clock set to 1970 push out everything real on arrival.
 */
export function pruneSpanStore(now = Date.now()) {
  if (!db) return { removed: 0 };
  return { removed: enforceCaps(now) };
}

function enforceCaps(now) {
  let removed = sql('DELETE FROM otel_spans WHERE received_at < ?').run(now - MAX_AGE_MS).changes;

  const over = sql('SELECT COUNT(*) AS n FROM otel_spans').get().n - MAX_SPANS;
  if (over > 0) {
    removed += sql(`
      DELETE FROM otel_spans WHERE rowid IN (
        SELECT rowid FROM otel_spans ORDER BY received_at ASC, rowid ASC LIMIT ?
      )
    `).run(over).changes;
  }
  return removed;
}

// ── The endpoint ──────────────────────────────────────────────────────────────

/** The one line of exporter configuration that turns a refusal into a delivery. */
const PROTOCOL_FIX = 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json';

const refuse = (status, error, message) => ({ status, body: { error, message } });

/**
 * A whole OTLP/HTTP export request, as a status and a body.
 *
 * Every refusal names what to change, because the person on the other end of
 * this is looking at an exporter's error log and not at this source. That is
 * the entire reason the protobuf case is a message and not a 415 with an empty
 * body: "415" tells them the format was wrong, and `PROTOCOL_FIX` tells them
 * the assignment to type into the configuration they already have open.
 *
 * The status codes, and why each one:
 *
 *   - **404 when the feature is off.** Not 403. There is no receiver here
 *     unless somebody turned one on, and that is a truer answer than "you may
 *     not" — it also declines to confirm to an unsolicited caller that this
 *     port has an OTLP endpoint hiding behind a permission. The body still
 *     names `DEVFLOW_OTEL=1`, because the one caller who deserves an
 *     explanation is the user who pointed their own exporter here.
 *   - **415 for protobuf**, which is what 415 is for, and for any content type
 *     that is positively not JSON. A missing content type is *not* refused:
 *     something posting JSON without a header is answered by trying to parse
 *     it, which is a better failure than an argument about a header.
 *   - **400 for `not-json` and `not-otlp`.** Both are the sender posting the
 *     wrong thing at this URL and both are fixed by the sender.
 *   - **200 for `empty`.** Core distinguishes an empty `resourceSpans` from a
 *     missing one precisely because they are different events: the second is
 *     somebody posting the wrong thing, the first is a healthy exporter with
 *     nothing to say. OTLP/HTTP says a successful export is 200 with a
 *     `partialSuccess`, and answering an idle exporter with 400 would fill a
 *     user's logs with errors describing nothing wrong.
 *
 * On success the body is OTLP's own `partialSuccess`, and it is filled in
 * rather than always `{}`: `readOtlpTraces` already counts why each unusable
 * span was dropped, and those counts are the answer to "my spans are not
 * appearing" — three of the four reasons are the sender's instrumentation. An
 * empty `partialSuccess` means every span in the delivery was kept.
 */
export function handleOtlpPost(bodyText, contentType) {
  if (!otelEnabled()) {
    return refuse(
      404,
      'disabled',
      'DevFlow is not receiving OpenTelemetry spans. Start the MCP server with DEVFLOW_OTEL=1 to enable the receiver.',
    );
  }

  const type = String(contentType ?? '').toLowerCase();
  if (type.includes('protobuf')) {
    return refuse(
      415,
      'protobuf',
      `DevFlow reads OTLP/JSON only. Set ${PROTOCOL_FIX} on the exporter beside the endpoint URL you already configured.`,
    );
  }
  if (type && !type.includes('json')) {
    return refuse(
      415,
      'unsupported-media-type',
      `DevFlow reads OTLP/JSON only. Set ${PROTOCOL_FIX} on the exporter beside the endpoint URL you already configured.`,
    );
  }

  const text = typeof bodyText === 'string' ? bodyText : '';
  if (text.length > MAX_BODY_BYTES) {
    return refuse(
      413,
      'too-large',
      `OTLP request body exceeds ${MAX_BODY_BYTES} bytes. Lower the exporter's batch size.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse(400, 'not-json', 'OTLP request body is not valid JSON.');
  }

  const reading = core.readOtlpTraces(parsed);
  if (reading.rejected) return rejection(reading.rejected);

  if (!db) {
    return refuse(
      503,
      'no-store',
      'DevFlow is receiving spans but the span store is not open. This is a server startup fault, not an exporter one.',
    );
  }

  storeSpans(reading.spans);

  const rejectedSpans = Object.values(reading.skipped).reduce((a, b) => a + b, 0);
  if (rejectedSpans === 0) return { status: 200, body: { partialSuccess: {} } };

  const why = Object.entries(reading.skipped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ');
  return {
    status: 200,
    body: { partialSuccess: { rejectedSpans, errorMessage: `spans dropped (${why})` } },
  };
}

function rejection(reason) {
  switch (reason) {
    case 'protobuf':
      return refuse(
        415,
        'protobuf',
        `DevFlow reads OTLP/JSON only. Set ${PROTOCOL_FIX} on the exporter beside the endpoint URL you already configured.`,
      );
    case 'not-json':
      return refuse(400, 'not-json', 'OTLP request body is not valid JSON.');
    case 'empty':
      // Nothing to say is not an error; see the header on `handleOtlpPost`.
      return { status: 200, body: { partialSuccess: {} } };
    case 'not-otlp':
    default:
      return refuse(
        400,
        'not-otlp',
        'Body is JSON but is not an OTLP ExportTraceServiceRequest: no resourceSpans array.',
      );
  }
}

export default handleOtlpPost;
