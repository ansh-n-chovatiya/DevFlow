/**
 * Accumulating Runtime Knowledge Graph — SQLite engine.
 *
 * Every flow the extension sends, and every component pick the panel resolves,
 * adds to this graph. Over time it is a queryable history of everything DevFlow
 * has observed about a specific application: which components are slow, which
 * endpoints fail, which source files are hotspots.
 *
 * The database lives at ~/.devflow/arkg.db (or $DEVFLOW_DIR/arkg.db) and is
 * opened once per server process. All writes are synchronous — better-sqlite3
 * runs in WAL mode, so <5ms per observation write is the normal case.
 *
 * Phase 0 foundation only. Phase 1 adds cross-session querying; Phase 3 adds
 * git SHA correlation; Phase 5 adds distributed graph sync.
 */

import Database from 'better-sqlite3';
import crypto from 'node:crypto';

/** The database, opened by `openArkg`. */
let db = null;

// ── Schema ────────────────────────────────────────────────────────────────────

const DDL = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS arkg_components (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    source_file TEXT,
    source_line INTEGER,
    git_sha TEXT,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 1,
    timing_p50_ms REAL,
    timing_p95_ms REAL,
    timing_samples TEXT,
    failure_rate REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS arkg_api_endpoints (
    id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    url_pattern TEXT NOT NULL,
    git_sha TEXT,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 1,
    timing_p50_ms REAL,
    timing_p95_ms REAL,
    timing_samples TEXT,
    failure_rate REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS arkg_source_files (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    git_sha TEXT,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS arkg_named_flows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT,
    step_count INTEGER NOT NULL,
    failure_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    git_sha TEXT,
    settings TEXT,
    content_hash TEXT
  );

  CREATE TABLE IF NOT EXISTS arkg_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    from_node_type TEXT NOT NULL,
    from_node_id TEXT NOT NULL,
    to_node_type TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    flow_id TEXT,
    timing_p50_ms REAL,
    timing_p95_ms REAL,
    timing_samples TEXT,
    frequency INTEGER NOT NULL DEFAULT 1,
    failure_rate REAL NOT NULL DEFAULT 0,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    git_sha TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_arkg_edges_from ON arkg_edges(from_node_type, from_node_id);
  CREATE INDEX IF NOT EXISTS idx_arkg_edges_to ON arkg_edges(to_node_type, to_node_id);
  CREATE INDEX IF NOT EXISTS idx_arkg_edges_type ON arkg_edges(type);
  CREATE INDEX IF NOT EXISTS idx_arkg_components_source ON arkg_components(source_file);
  CREATE INDEX IF NOT EXISTS idx_arkg_api_endpoints_url ON arkg_api_endpoints(url_pattern);
  CREATE INDEX IF NOT EXISTS idx_arkg_components_last ON arkg_components(last_observed_at);
  CREATE INDEX IF NOT EXISTS idx_arkg_api_endpoints_last ON arkg_api_endpoints(last_observed_at);
`;

// ── Identity ──────────────────────────────────────────────────────────────────

/**
 * Stable id for a component pick (name + file).
 *
 * The extension already generates hashed component ids via core/react/id.ts —
 * those come in directly from the flow's react.components table. This function
 * is only used when a component pick arrives without a pre-hashed id.
 */
function componentId(name, sourceFile) {
  return crypto
    .createHash('sha256')
    .update(`${name}|${sourceFile ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Stable id for an API endpoint.
 *
 * Strips query strings and replaces identifier-shaped path segments with :id so
 * that GET /api/users/42 and GET /api/users/99 collapse to the same pattern.
 */
function endpointId(method, url) {
  const pattern = normaliseUrl(url);
  return crypto
    .createHash('sha256')
    .update(`${method.toUpperCase()}|${pattern}`)
    .digest('hex')
    .slice(0, 16);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_BLOB = /^[0-9a-f]{12,}$/i;
const OPAQUE_TOKEN = /^(?=[\w-]*\d)[\w-]{16,}$/;

/**
 * Is this path segment a record key rather than a route word?
 *
 * `frequency` on an endpoint node only means anything if every call to the same
 * route lands on the same node, so a segment that varies per record has to
 * collapse. Numeric ids are the easy case; a UUID-keyed or ObjectId-keyed API
 * is the case that matters, because there the graph would otherwise grow one
 * node per record and accumulate nothing on any of them.
 *
 * Four shapes collapse, chosen so that every one of them is a shape no
 * hand-written route word takes:
 *
 *   - all digits — `42`
 *   - a UUID — `9f8b...`, in either case
 *   - twelve or more hex characters — Mongo ObjectIds, git SHAs, hash keys
 *   - sixteen or more word characters containing at least one digit — ULIDs,
 *     nanoids, and `checkout-a3f9c2b1` style slug-hashes
 *
 * The digit requirement on the last rule is what keeps it conservative:
 * `notification-settings` and `user-preferences` are long, but no digit means
 * no collapse. The cost of the heuristic being wrong in that direction is two
 * routes merged into one node; the cost of being wrong the other way is the
 * graph never accumulating at all, which is worse.
 */
function isOpaqueSegment(seg) {
  return /^\d+$/.test(seg) || UUID.test(seg) || HEX_BLOB.test(seg) || OPAQUE_TOKEN.test(seg);
}

function normaliseUrl(rawUrl) {
  const collapse = (path) =>
    path.split('/').map((seg) => (isOpaqueSegment(seg) ? ':id' : seg)).join('/');
  try {
    const u = new URL(rawUrl);
    return `${u.host}${collapse(u.pathname)}`;
  } catch {
    // A relative URL never parses, and it needs collapsing just as much.
    return collapse((rawUrl.split('?')[0] ?? rawUrl).split('#')[0] ?? rawUrl);
  }
}

// ── Timing percentiles (recency-biased window) ────────────────────────────────

const WINDOW_SIZE = 1000;

/**
 * Add one sample to the stored window, return updated window + p50 + p95.
 *
 * The window is a JSON array in the `timing_samples` column. Until it holds
 * WINDOW_SIZE samples every sample is kept; after that each new sample evicts a
 * uniformly random existing one. That is **not** reservoir sampling — a
 * reservoir admits the nth sample with probability k/n, so it converges on a
 * uniform view of all history and stops moving. This admits every sample with
 * probability 1, so old samples decay out at a rate of 1/WINDOW_SIZE per write
 * and the percentiles track the last few thousand observations.
 *
 * That is the behaviour this wants. `getAnomalies` asks whether an endpoint is
 * slow *now*; a p95 diluted by a thousand observations from three weeks ago
 * cannot answer that. Random eviction rather than FIFO is what keeps a single
 * burst of traffic from flushing the whole window in one flow.
 *
 * Percentiles are computed on the sorted window — exact over what it holds,
 * which is the window, not all history.
 */
function updateTimingStats(existingSamplesJson, newSampleMs) {
  let samples = [];
  if (existingSamplesJson) {
    try { samples = JSON.parse(existingSamplesJson); } catch { /* corrupt — reset */ }
  }

  if (samples.length < WINDOW_SIZE) {
    samples.push(newSampleMs);
  } else {
    const idx = Math.floor(Math.random() * WINDOW_SIZE);
    samples[idx] = newSampleMs;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = computePercentile(sorted, 0.5);
  const p95 = computePercentile(sorted, 0.95);

  return { samples: JSON.stringify(samples), p50, p95 };
}

function computePercentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[idx] ?? null;
}

// ── Failure rate (rolling window) ─────────────────────────────────────────────

/**
 * Rolling 100-observation failure rate.
 *
 * (prevRate * min(frequency-1, 99) + newFailure) / min(frequency, 100)
 * Cheap and bounded. First observation always gives 0 or 1 exactly.
 */
function updateFailureRate(prevRate, frequency, failed) {
  const window = Math.min(frequency, 100);
  const prevWeight = Math.min(frequency - 1, 99);
  return (prevRate * prevWeight + (failed ? 1 : 0)) / window;
}

// ── Open / init ───────────────────────────────────────────────────────────────

/**
 * Prepared statements, kept for the life of the connection.
 *
 * Ingesting a flow issues a fixed handful of statements once per component and
 * once per network call. `db.prepare` compiles SQL, so calling it inside those
 * loops pays the compiler for every row and puts the <5ms-per-observation
 * budget at the mercy of how long the recording was. Compiled statements are
 * bound to a connection, so this is cleared when the connection closes.
 */
const statements = new Map();

function sql(text) {
  let stmt = statements.get(text);
  if (!stmt) { stmt = db.prepare(text); statements.set(text, stmt); }
  return stmt;
}

/**
 * Add a column the DDL declares but an older database was created without.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table, so a
 * column added to the DDL never reaches a database somebody already has —
 * every read of it would come back undefined and every write would throw.
 */
function addMissingColumn(table, column, decl) {
  const present = db.prepare(`PRAGMA table_info(${table})`).all();
  if (present.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/**
 * Open (or create) the ARKG database at dbPath.
 *
 * Idempotent — safe to call multiple times. Called once at server startup.
 * Returns the database instance; the server ignores it, tests use it.
 */
export function openArkg(dbPath) {
  if (db) return db;
  db = new Database(dbPath);
  db.exec(DDL);
  addMissingColumn('arkg_edges', 'timing_samples', 'TEXT');
  addMissingColumn('arkg_named_flows', 'content_hash', 'TEXT');
  return db;
}

/** Close the database. Used in tests and for clean shutdown. */
export function closeArkg() {
  statements.clear();
  if (db) { db.close(); db = null; }
}

// ── Ingestion ─────────────────────────────────────────────────────────────────

/**
 * Ingest a complete flow JSON into the ARKG.
 *
 * Extracts component nodes, API endpoint nodes, source file nodes, the flow
 * node itself, and the edges between them. All writes run in one transaction
 * so a failure is atomic — the graph is never half-written.
 *
 * Ingesting the same flow twice counts it once. `frequency` and `failure_rate`
 * are the whole point of an *accumulating* graph — they answer "how often" and
 * "how reliably" — and pressing **Send to Claude** on one recording a second
 * time is not a second observation of the app. Without this guard a flow
 * re-sent five times reports its components as five times as hot as the ones
 * beside them, and every baseline the anomaly detector draws is off by however
 * many times somebody happened to hit the button.
 *
 * The flow node itself is still refreshed, so a re-send updates a renamed flow
 * and its `last_observed_at`.
 *
 * "The same flow" is the flow id *plus a hash of its content* — the steps and
 * the resolved React component table. A flow whose steps were edited in the
 * viewer is genuinely new evidence about the app and accumulates again, which
 * an id check alone would silently throw away. The tradeoff runs the other way
 * too: a flow re-sent after the source-map resolver has filled in component
 * sources also hashes differently and so counts twice. That is the trade taken
 * deliberately — one extra count on a re-resolve is cheap, and the alternative
 * is a graph that never learns where its components live.
 *
 * flowJson is the same payload the extension POSTs to /flows.
 */
export function ingestFlow(flowJson) {
  if (!db) return;

  const now = Date.now();
  const flowId = flowJson.id;
  const steps = flowJson.steps ?? [];
  const components = flowJson.react?.components ?? {};
  const host = flowJson.startUrl
    ? (() => { try { return new URL(flowJson.startUrl).host; } catch { return null; } })()
    : null;

  const failureCount = steps.reduce((total, step) => {
    const consoleFails = (step.consoleLogs ?? []).filter((e) => e.level === 'error').length;
    const netFails = (step.networkCalls ?? []).filter((c) => c.status === null || c.status >= 400).length;
    return total + consoleFails + netFails;
  }, 0);

  const contentHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ steps, components }))
    .digest('hex')
    .slice(0, 32);

  db.transaction(() => {
    // ── Named flow node ──────────────────────────────────────────────────────
    const existingFlow = sql('SELECT content_hash FROM arkg_named_flows WHERE id = ?').get(flowId);
    if (!existingFlow) {
      sql(`
        INSERT INTO arkg_named_flows (id, name, host, step_count, failure_count, created_at, last_observed_at, settings, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        flowId,
        flowJson.name ?? 'Unnamed',
        host,
        steps.length,
        failureCount,
        flowJson.timestamp ?? now,
        now,
        flowJson.settings ? JSON.stringify(flowJson.settings) : null,
        contentHash,
      );
    } else {
      sql(`
        UPDATE arkg_named_flows SET name = ?, host = ?, last_observed_at = ?, failure_count = ?, step_count = ?, content_hash = ? WHERE id = ?
      `).run(flowJson.name ?? 'Unnamed', host, now, failureCount, steps.length, contentHash, flowId);
    }

    // Everything below this line is accumulation, and accumulation is what a
    // second send of an unchanged recording must not do.
    if (existingFlow && existingFlow.content_hash === contentHash) return;

    // ── Component nodes ───────────────────────────────────────────────────────
    const selectComponent = sql('SELECT * FROM arkg_components WHERE id = ?');
    const insertComponent = sql(`
      INSERT INTO arkg_components (id, display_name, source_file, source_line, first_observed_at, last_observed_at, frequency)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    const updateComponent = sql(`
      UPDATE arkg_components SET
        last_observed_at = ?,
        frequency = frequency + 1,
        source_file = COALESCE(source_file, ?),
        source_line = COALESCE(source_line, ?)
      WHERE id = ?
    `);
    const selectSourceFile = sql('SELECT id FROM arkg_source_files WHERE id = ?');
    const insertSourceFile = sql(`
      INSERT INTO arkg_source_files (id, path, first_observed_at, last_observed_at)
      VALUES (?, ?, ?, ?)
    `);
    const updateSourceFile = sql(
      'UPDATE arkg_source_files SET last_observed_at = ?, frequency = frequency + 1 WHERE id = ?',
    );

    for (const [compId, comp] of Object.entries(components)) {
      const sourceFile = comp.source ?? null;
      const sourceLine = comp.line ?? null;

      if (!selectComponent.get(compId)) {
        insertComponent.run(compId, comp.name ?? compId, sourceFile, sourceLine, now, now);
      } else {
        updateComponent.run(now, sourceFile, sourceLine, compId);
      }

      // maps_to edge: component -> source file
      if (sourceFile) {
        if (!selectSourceFile.get(sourceFile)) {
          insertSourceFile.run(sourceFile, sourceFile, now, now);
        } else {
          updateSourceFile.run(now, sourceFile);
        }
        upsertEdge('maps_to', 'component', compId, 'source_file', sourceFile, flowId, now);
      }
    }

    // ── API endpoint nodes from network calls ─────────────────────────────────
    const selectEndpoint = sql('SELECT * FROM arkg_api_endpoints WHERE id = ?');
    const insertEndpoint = sql(`
      INSERT INTO arkg_api_endpoints (id, method, url_pattern, first_observed_at, last_observed_at, frequency, timing_p50_ms, timing_p95_ms, timing_samples, failure_rate)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `);
    const updateEndpoint = sql(`
      UPDATE arkg_api_endpoints SET
        last_observed_at = ?,
        frequency = frequency + 1,
        timing_p50_ms = ?,
        timing_p95_ms = ?,
        timing_samples = ?,
        failure_rate = ?
      WHERE id = ?
    `);

    for (const step of steps) {
      const owner = step.element?.react?.owner ?? null;

      for (const call of step.networkCalls ?? []) {
        const method = (call.method ?? 'GET').toUpperCase();
        const epId = endpointId(method, call.url);
        const pattern = normaliseUrl(call.url);
        const failed = call.status === null || call.status >= 400;
        const durationMs = typeof call.durationMs === 'number' ? call.durationMs : null;

        const existing = selectEndpoint.get(epId);
        if (!existing) {
          const ts = durationMs !== null
            ? updateTimingStats(null, durationMs)
            : { samples: null, p50: null, p95: null };
          insertEndpoint.run(epId, method, pattern, now, now,
            ts.p50, ts.p95, ts.samples,
            failed ? 1.0 : 0.0);
        } else {
          const ts = durationMs !== null
            ? updateTimingStats(existing.timing_samples, durationMs)
            : { samples: existing.timing_samples, p50: existing.timing_p50_ms, p95: existing.timing_p95_ms };
          const newRate = updateFailureRate(existing.failure_rate, existing.frequency + 1, failed);
          updateEndpoint.run(now, ts.p50, ts.p95, ts.samples, newRate, epId);
        }

        // calls edge: component -> api_endpoint (when component is known)
        if (owner && components[owner]) {
          upsertEdge('calls', 'component', owner, 'api_endpoint', epId, flowId, now, durationMs, failed);
        }
      }
    }

    // ── renders edges: component chain hierarchy ──────────────────────────────
    // The chain is stored outermost first (see core/react/fiber.ts, which
    // reverses a nearest-first walk to make it so), so chain[0] is the root and
    // chain[n-1] is the component the click landed in. renders(A, B) means A
    // renders inside B, which is why the deeper id is the `from`.
    for (const step of steps) {
      const chain = step.element?.react?.chain ?? [];
      for (let i = 0; i < chain.length - 1; i++) {
        upsertEdge('renders', 'component', chain[i + 1], 'component', chain[i], flowId, now);
      }
    }
  })();
}

/**
 * Ingest a single component pick from the DevTools panel locator.
 *
 * Shape: { id?, name, sourceFile, sourceLine, timingMs?, failed? }
 */
export function ingestComponentPick(pick) {
  if (!db) return;

  const now = Date.now();
  const compId = pick.id ?? componentId(pick.name ?? '', pick.sourceFile ?? '');
  const sourceFile = pick.sourceFile ?? null;
  const sourceLine = pick.sourceLine ?? null;
  const durationMs = typeof pick.timingMs === 'number' ? pick.timingMs : null;
  const failed = pick.failed === true;

  db.transaction(() => {
    const existing = sql('SELECT * FROM arkg_components WHERE id = ?').get(compId);
    if (!existing) {
      // The first sample counts. Dropping it here would leave a component that
      // is only ever picked once reporting no timing at all.
      const ts = durationMs !== null
        ? updateTimingStats(null, durationMs)
        : { samples: null, p50: null, p95: null };
      sql(`
        INSERT INTO arkg_components (id, display_name, source_file, source_line, first_observed_at, last_observed_at, frequency, timing_p50_ms, timing_p95_ms, timing_samples, failure_rate)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(compId, pick.name ?? compId, sourceFile, sourceLine, now, now,
        ts.p50, ts.p95, ts.samples,
        failed ? 1.0 : 0.0);
    } else {
      const newRate = updateFailureRate(existing.failure_rate, existing.frequency + 1, failed);
      let ts = { p50: existing.timing_p50_ms, p95: existing.timing_p95_ms, samples: existing.timing_samples };
      if (durationMs !== null) ts = updateTimingStats(existing.timing_samples, durationMs);

      sql(`
        UPDATE arkg_components SET
          last_observed_at = ?,
          frequency = frequency + 1,
          source_file = COALESCE(source_file, ?),
          source_line = COALESCE(source_line, ?),
          timing_p50_ms = ?,
          timing_p95_ms = ?,
          timing_samples = ?,
          failure_rate = ?
        WHERE id = ?
      `).run(now, sourceFile, sourceLine, ts.p50, ts.p95, ts.samples, newRate, compId);
    }
  })();
}

/**
 * Upsert an edge.
 *
 * If an edge with the same (type, from, to) tuple already exists, increment its
 * frequency, fold the sample into its timing window and update
 * last_observed_at. Otherwise insert.
 *
 * An edge keeps its own timing window rather than borrowing its endpoint node's
 * because they answer different questions: the node says how slow
 * `GET /api/cart` is, the edge says how slow it is *when CartButton is the one
 * calling it*, which is the question a blast radius is asked.
 */
function upsertEdge(type, fromType, fromId, toType, toId, flowId, now, timingMs = null, failed = false) {
  const existing = sql(
    'SELECT * FROM arkg_edges WHERE type = ? AND from_node_type = ? AND from_node_id = ? AND to_node_type = ? AND to_node_id = ?',
  ).get(type, fromType, fromId, toType, toId);

  if (!existing) {
    const ts = timingMs !== null
      ? updateTimingStats(null, timingMs)
      : { samples: null, p50: null, p95: null };
    sql(`
      INSERT INTO arkg_edges (type, from_node_type, from_node_id, to_node_type, to_node_id, flow_id, timing_p50_ms, timing_p95_ms, timing_samples, frequency, failure_rate, first_observed_at, last_observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(type, fromType, fromId, toType, toId, flowId,
      ts.p50, ts.p95, ts.samples,
      failed ? 1.0 : 0.0, now, now);
  } else {
    const ts = timingMs !== null
      ? updateTimingStats(existing.timing_samples, timingMs)
      : { samples: existing.timing_samples, p50: existing.timing_p50_ms, p95: existing.timing_p95_ms };
    const newRate = updateFailureRate(existing.failure_rate, existing.frequency + 1, failed);
    sql(`
      UPDATE arkg_edges SET
        last_observed_at = ?,
        frequency = frequency + 1,
        timing_p50_ms = ?,
        timing_p95_ms = ?,
        timing_samples = ?,
        failure_rate = ?
      WHERE id = ?
    `).run(now, ts.p50, ts.p95, ts.samples, newRate, existing.id);
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Full component node with all edges that touch it. */
export function getComponent(id) {
  if (!db) return null;
  const comp = sql('SELECT * FROM arkg_components WHERE id = ?').get(id);
  if (!comp) return null;
  const edges = sql(`
    SELECT * FROM arkg_edges
    WHERE (from_node_type = 'component' AND from_node_id = ?)
       OR (to_node_type = 'component' AND to_node_id = ?)
  `).all(id, id);
  return { ...comp, edges };
}

/**
 * All named flows in which this component appeared (via an edge), since sinceMs
 * (epoch milliseconds, 0 = all history).
 */
export function getComponentHistory(id, sinceMs = 0) {
  if (!db) return [];
  const edges = sql(`
    SELECT DISTINCT flow_id FROM arkg_edges
    WHERE (from_node_id = ? OR to_node_id = ?)
      AND flow_id IS NOT NULL
      AND last_observed_at >= ?
  `).all(id, id, sinceMs);

  const flowIds = edges.map((e) => e.flow_id);
  if (!flowIds.length) return [];

  return flowIds
    .map((fid) => sql('SELECT * FROM arkg_named_flows WHERE id = ?').get(fid))
    .filter(Boolean);
}

/**
 * Components and API endpoints deviating from their historical baseline.
 *
 * Requires >=30 observations per entity. sinceMs defaults to the last 24h.
 */
export function getAnomalies(sinceMs = Date.now() - 24 * 60 * 60 * 1000) {
  if (!db) return [];
  const anomalies = [];

  const components = sql(`
    SELECT * FROM arkg_components WHERE last_observed_at >= ? AND frequency >= 30
  `).all(sinceMs);

  for (const comp of components) {
    if (comp.failure_rate > 0.1) {
      anomalies.push({
        type: 'component',
        id: comp.id,
        name: comp.display_name,
        source: comp.source_file,
        issue: 'high_failure_rate',
        value: comp.failure_rate,
        detail: `${(comp.failure_rate * 100).toFixed(1)}% failure rate over ${comp.frequency} observations`,
      });
    }
  }

  const endpoints = sql(`
    SELECT * FROM arkg_api_endpoints WHERE last_observed_at >= ? AND frequency >= 30
  `).all(sinceMs);

  for (const ep of endpoints) {
    if (ep.failure_rate > 0.05) {
      anomalies.push({
        type: 'api_endpoint',
        id: ep.id,
        name: `${ep.method} ${ep.url_pattern}`,
        issue: 'high_failure_rate',
        value: ep.failure_rate,
        detail: `${(ep.failure_rate * 100).toFixed(1)}% failure rate over ${ep.frequency} calls`,
      });
    }
    // High variance: p95 > 3x p50 indicates occasional severe spikes.
    if (ep.timing_p50_ms && ep.timing_p95_ms && ep.timing_p95_ms > ep.timing_p50_ms * 3) {
      anomalies.push({
        type: 'api_endpoint',
        id: ep.id,
        name: `${ep.method} ${ep.url_pattern}`,
        issue: 'timing_spike',
        value: ep.timing_p95_ms,
        detail: `p95=${ep.timing_p95_ms.toFixed(0)}ms vs p50=${ep.timing_p50_ms.toFixed(0)}ms (${(ep.timing_p95_ms / ep.timing_p50_ms).toFixed(1)}x spread)`,
      });
    }
  }

  return anomalies;
}

/**
 * All components with a maps_to edge to sourceFile, optionally filtered to a
 * line range [lineStart, lineEnd] (inclusive, 1-based).
 */
export function getBlastRadius(sourceFile, lineStart, lineEnd) {
  if (!db) return [];

  let query = `
    SELECT c.* FROM arkg_components c
    INNER JOIN arkg_edges e ON e.from_node_id = c.id AND e.type = 'maps_to'
    WHERE e.to_node_id = ?
  `;
  const params = [sourceFile];

  if (lineStart !== undefined && lineEnd !== undefined) {
    query += ' AND c.source_line >= ? AND c.source_line <= ?';
    params.push(lineStart, lineEnd);
  }

  return sql(query).all(...params);
}

/**
 * Compact graph summary for get_app_architecture.
 *
 * Top 20 components by frequency + their call edges + top 10 API endpoints.
 * Designed to produce <500 tokens of text.
 */
export function getAppArchitecture() {
  if (!db) return null;

  const totalFlows = sql('SELECT COUNT(*) as n FROM arkg_named_flows').get()?.n ?? 0;
  if (totalFlows === 0) return null;

  const lastFlow = sql('SELECT MAX(last_observed_at) as t FROM arkg_named_flows').get()?.t;

  const topComponents = sql(`
    SELECT * FROM arkg_components ORDER BY frequency DESC LIMIT 20
  `).all();

  const topEndpoints = sql(`
    SELECT * FROM arkg_api_endpoints ORDER BY frequency DESC LIMIT 10
  `).all();

  const callEdges = new Map();
  for (const comp of topComponents) {
    const edges = sql(`
      SELECT e.*, ep.method, ep.url_pattern FROM arkg_edges e
      JOIN arkg_api_endpoints ep ON ep.id = e.to_node_id
      WHERE e.type = 'calls' AND e.from_node_type = 'component' AND e.from_node_id = ?
      ORDER BY e.frequency DESC LIMIT 5
    `).all(comp.id);
    if (edges.length) callEdges.set(comp.id, edges);
  }

  return {
    totalFlows,
    lastSeen: lastFlow ? new Date(lastFlow).toISOString().slice(0, 10) : null,
    topComponents: topComponents.map((c) => ({
      id: c.id,
      name: c.display_name,
      source: c.source_file,
      frequency: c.frequency,
      failureRate: c.failure_rate,
      timingP50Ms: c.timing_p50_ms,
      calls: (callEdges.get(c.id) ?? []).map((e) => ({
        endpoint: `${e.method} ${e.url_pattern}`,
        frequency: e.frequency,
        failureRate: e.failure_rate,
      })),
    })),
    topEndpoints: topEndpoints.map((e) => ({
      id: e.id,
      name: `${e.method} ${e.url_pattern}`,
      frequency: e.frequency,
      failureRate: e.failure_rate,
      timingP50Ms: e.timing_p50_ms,
      timingP95Ms: e.timing_p95_ms,
    })),
  };
}

/**
 * SQLite caps a statement at 999 bound parameters, so an `IN (…)` over an
 * unbounded id list is issued in chunks of this size.
 */
const DELETE_CHUNK = 500;

function chunked(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) out.push(ids.slice(i, i + DELETE_CHUNK));
  return out;
}

/**
 * Delete every edge touching one of these nodes, on either end.
 *
 * The node type is part of the match because ids are only unique within their
 * own table: a source file's id is its path, and nothing stops a path from
 * colliding with a component's hash. Matching on the id alone would let the
 * pruning of one node cut the edges of an unrelated one.
 */
function deleteEdgesFor(nodeType, ids) {
  for (const chunk of chunked(ids)) {
    const holes = chunk.map(() => '?').join(',');
    db.prepare(`
      DELETE FROM arkg_edges
      WHERE (from_node_type = ? AND from_node_id IN (${holes}))
         OR (to_node_type = ? AND to_node_id IN (${holes}))
    `).run(nodeType, ...chunk, nodeType, ...chunk);
  }
}

function deleteNodes(table, ids) {
  for (const chunk of chunked(ids)) {
    const holes = chunk.map(() => '?').join(',');
    db.prepare(`DELETE FROM ${table} WHERE id IN (${holes})`).run(...chunk);
  }
}

/**
 * Delete observations older than retentionDays days.
 *
 * Called periodically (same cadence as flow retention enforcement). Returns the
 * number of component and endpoint nodes pruned.
 *
 * One transaction, because a prune that dies between deleting a node and
 * deleting its edges leaves edges pointing at nothing — and `getComponent` and
 * `getAppArchitecture` both join through edges, so the damage shows up as
 * missing rows in answers rather than as an error anybody could act on.
 */
export function pruneOldObservations(retentionDays) {
  if (!db) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  return db.transaction(() => {
    const ids = (table) =>
      sql(`SELECT id FROM ${table} WHERE last_observed_at < ?`).all(cutoff).map((r) => r.id);

    const compIds = ids('arkg_components');
    const epIds = ids('arkg_api_endpoints');
    const fileIds = ids('arkg_source_files');

    deleteEdgesFor('component', compIds);
    deleteEdgesFor('api_endpoint', epIds);
    deleteEdgesFor('source_file', fileIds);

    deleteNodes('arkg_components', compIds);
    deleteNodes('arkg_api_endpoints', epIds);
    deleteNodes('arkg_source_files', fileIds);

    sql('DELETE FROM arkg_named_flows WHERE last_observed_at < ?').run(cutoff);

    return compIds.length + epIds.length;
  })();
}
