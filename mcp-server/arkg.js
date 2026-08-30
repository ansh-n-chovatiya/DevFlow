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
    settings TEXT
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
 * Strips query strings and replaces numeric path segments with :id so that
 * GET /api/users/42 and GET /api/users/99 collapse to the same pattern.
 */
function endpointId(method, url) {
  const pattern = normaliseUrl(url);
  return crypto
    .createHash('sha256')
    .update(`${method.toUpperCase()}|${pattern}`)
    .digest('hex')
    .slice(0, 16);
}

function normaliseUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split('/').map((seg) =>
      /^\d+$/.test(seg) ? ':id' : seg,
    );
    return `${u.host}${parts.join('/')}`;
  } catch {
    return rawUrl.split('?')[0] ?? rawUrl;
  }
}

// ── Timing percentiles (reservoir sampling) ───────────────────────────────────

const RESERVOIR_SIZE = 1000;

/**
 * Add one sample to a stored reservoir, return updated reservoir + p50 + p95.
 *
 * The reservoir is stored as a JSON array in the timing_samples column. A
 * full reservoir replaces a random element (reservoir sampling). Percentiles are
 * computed on the sorted reservoir — accurate to within the reservoir size.
 */
function updateTimingStats(existingSamplesJson, newSampleMs) {
  let samples = [];
  if (existingSamplesJson) {
    try { samples = JSON.parse(existingSamplesJson); } catch { /* corrupt — reset */ }
  }

  if (samples.length < RESERVOIR_SIZE) {
    samples.push(newSampleMs);
  } else {
    const idx = Math.floor(Math.random() * RESERVOIR_SIZE);
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
 * Open (or create) the ARKG database at dbPath.
 *
 * Idempotent — safe to call multiple times. Called once at server startup.
 * Returns the database instance; the server ignores it, tests use it.
 */
export function openArkg(dbPath) {
  if (db) return db;
  db = new Database(dbPath);
  db.exec(DDL);
  return db;
}

/** Close the database. Used in tests and for clean shutdown. */
export function closeArkg() {
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
 * flowJson is the same payload the extension POSTs to /flows.
 */
export function ingestFlow(flowJson) {
  if (!db) return;

  const now = Date.now();
  const flowId = flowJson.id;
  const host = flowJson.startUrl
    ? (() => { try { return new URL(flowJson.startUrl).host; } catch { return null; } })()
    : null;

  const failureCount = (flowJson.steps ?? []).reduce((total, step) => {
    const consoleFails = (step.consoleLogs ?? []).filter((e) => e.level === 'error').length;
    const netFails = (step.networkCalls ?? []).filter((c) => c.status === null || c.status >= 400).length;
    return total + consoleFails + netFails;
  }, 0);

  db.transaction(() => {
    // ── Named flow node ──────────────────────────────────────────────────────
    const existingFlow = db.prepare('SELECT id FROM arkg_named_flows WHERE id = ?').get(flowId);
    if (!existingFlow) {
      db.prepare(`
        INSERT INTO arkg_named_flows (id, name, host, step_count, failure_count, created_at, last_observed_at, settings)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        flowId,
        flowJson.name ?? 'Unnamed',
        host,
        (flowJson.steps ?? []).length,
        failureCount,
        flowJson.timestamp ?? now,
        now,
        flowJson.settings ? JSON.stringify(flowJson.settings) : null,
      );
    } else {
      db.prepare(`
        UPDATE arkg_named_flows SET last_observed_at = ?, failure_count = ?, step_count = ? WHERE id = ?
      `).run(now, failureCount, (flowJson.steps ?? []).length, flowId);
    }

    // ── Component nodes ───────────────────────────────────────────────────────
    const components = flowJson.react?.components ?? {};
    for (const [compId, comp] of Object.entries(components)) {
      const sourceFile = comp.source ?? null;
      const sourceLine = comp.line ?? null;

      const existing = db.prepare('SELECT * FROM arkg_components WHERE id = ?').get(compId);
      if (!existing) {
        db.prepare(`
          INSERT INTO arkg_components (id, display_name, source_file, source_line, first_observed_at, last_observed_at, frequency)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(compId, comp.name ?? compId, sourceFile, sourceLine, now, now);
      } else {
        db.prepare(`
          UPDATE arkg_components SET
            last_observed_at = ?,
            frequency = frequency + 1,
            source_file = COALESCE(source_file, ?),
            source_line = COALESCE(source_line, ?)
          WHERE id = ?
        `).run(now, sourceFile, sourceLine, compId);
      }

      // maps_to edge: component -> source file
      if (sourceFile) {
        const existingFile = db.prepare('SELECT id FROM arkg_source_files WHERE id = ?').get(sourceFile);
        if (!existingFile) {
          db.prepare(`
            INSERT INTO arkg_source_files (id, path, first_observed_at, last_observed_at)
            VALUES (?, ?, ?, ?)
          `).run(sourceFile, sourceFile, now, now);
        } else {
          db.prepare('UPDATE arkg_source_files SET last_observed_at = ?, frequency = frequency + 1 WHERE id = ?')
            .run(now, sourceFile);
        }
        upsertEdge('maps_to', 'component', compId, 'source_file', sourceFile, flowId, now);
      }
    }

    // ── API endpoint nodes from network calls ─────────────────────────────────
    for (const step of flowJson.steps ?? []) {
      const owner = step.element?.react?.owner ?? null;

      for (const call of step.networkCalls ?? []) {
        const method = (call.method ?? 'GET').toUpperCase();
        const epId = endpointId(method, call.url);
        const pattern = normaliseUrl(call.url);
        const failed = call.status === null || call.status >= 400;
        const durationMs = typeof call.durationMs === 'number' ? call.durationMs : null;

        const existing = db.prepare('SELECT * FROM arkg_api_endpoints WHERE id = ?').get(epId);
        if (!existing) {
          const ts = durationMs !== null
            ? updateTimingStats(null, durationMs)
            : { samples: null, p50: null, p95: null };
          db.prepare(`
            INSERT INTO arkg_api_endpoints (id, method, url_pattern, first_observed_at, last_observed_at, frequency, timing_p50_ms, timing_p95_ms, timing_samples, failure_rate)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
          `).run(epId, method, pattern, now, now,
            ts.p50, ts.p95, ts.samples,
            failed ? 1.0 : 0.0);
        } else {
          const ts = durationMs !== null
            ? updateTimingStats(existing.timing_samples, durationMs)
            : { samples: existing.timing_samples, p50: existing.timing_p50_ms, p95: existing.timing_p95_ms };
          const newRate = updateFailureRate(existing.failure_rate, existing.frequency + 1, failed);
          db.prepare(`
            UPDATE arkg_api_endpoints SET
              last_observed_at = ?,
              frequency = frequency + 1,
              timing_p50_ms = ?,
              timing_p95_ms = ?,
              timing_samples = ?,
              failure_rate = ?
            WHERE id = ?
          `).run(now, ts.p50, ts.p95, ts.samples, newRate, epId);
        }

        // calls edge: component -> api_endpoint (when component is known)
        if (owner && components[owner]) {
          upsertEdge('calls', 'component', owner, 'api_endpoint', epId, flowId, now, durationMs, failed);
        }
      }
    }

    // ── renders edges: component chain hierarchy ──────────────────────────────
    // chain[0] is most-specific; chain[n-1] is outermost.
    // renders(A, B) means A renders inside B.
    for (const step of flowJson.steps ?? []) {
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
    const existing = db.prepare('SELECT * FROM arkg_components WHERE id = ?').get(compId);
    if (!existing) {
      db.prepare(`
        INSERT INTO arkg_components (id, display_name, source_file, source_line, first_observed_at, last_observed_at, frequency, failure_rate)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `).run(compId, pick.name ?? compId, sourceFile, sourceLine, now, now, failed ? 1.0 : 0.0);
    } else {
      const newRate = updateFailureRate(existing.failure_rate, existing.frequency + 1, failed);
      let ts = { p50: existing.timing_p50_ms, p95: existing.timing_p95_ms, samples: existing.timing_samples };
      if (durationMs !== null) ts = updateTimingStats(existing.timing_samples, durationMs);

      db.prepare(`
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
 * If an edge with the same (type, from, to) tuple already exists, increment
 * its frequency and update last_observed_at. Otherwise insert.
 */
function upsertEdge(type, fromType, fromId, toType, toId, flowId, now, timingMs = null, failed = false) {
  const existing = db
    .prepare('SELECT * FROM arkg_edges WHERE type = ? AND from_node_type = ? AND from_node_id = ? AND to_node_type = ? AND to_node_id = ?')
    .get(type, fromType, fromId, toType, toId);

  if (!existing) {
    const ts = timingMs !== null ? updateTimingStats(null, timingMs) : { p50: null, p95: null };
    db.prepare(`
      INSERT INTO arkg_edges (type, from_node_type, from_node_id, to_node_type, to_node_id, flow_id, timing_p50_ms, timing_p95_ms, frequency, failure_rate, first_observed_at, last_observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(type, fromType, fromId, toType, toId, flowId,
      ts.p50, ts.p95,
      failed ? 1.0 : 0.0, now, now);
  } else {
    const newRate = updateFailureRate(existing.failure_rate, existing.frequency + 1, failed);
    db.prepare('UPDATE arkg_edges SET last_observed_at = ?, frequency = frequency + 1, failure_rate = ? WHERE id = ?')
      .run(now, newRate, existing.id);
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Full component node with all edges that touch it. */
export function getComponent(id) {
  if (!db) return null;
  const comp = db.prepare('SELECT * FROM arkg_components WHERE id = ?').get(id);
  if (!comp) return null;
  const edges = db.prepare(`
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
  const edges = db.prepare(`
    SELECT DISTINCT flow_id FROM arkg_edges
    WHERE (from_node_id = ? OR to_node_id = ?)
      AND flow_id IS NOT NULL
      AND last_observed_at >= ?
  `).all(id, id, sinceMs);

  const flowIds = edges.map((e) => e.flow_id);
  if (!flowIds.length) return [];

  return flowIds
    .map((fid) => db.prepare('SELECT * FROM arkg_named_flows WHERE id = ?').get(fid))
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

  const components = db.prepare(`
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

  const endpoints = db.prepare(`
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

  return db.prepare(query).all(...params);
}

/**
 * Compact graph summary for get_app_architecture.
 *
 * Top 20 components by frequency + their call edges + top 10 API endpoints.
 * Designed to produce <500 tokens of text.
 */
export function getAppArchitecture() {
  if (!db) return null;

  const totalFlows = db.prepare('SELECT COUNT(*) as n FROM arkg_named_flows').get()?.n ?? 0;
  if (totalFlows === 0) return null;

  const lastFlow = db.prepare('SELECT MAX(last_observed_at) as t FROM arkg_named_flows').get()?.t;

  const topComponents = db.prepare(`
    SELECT * FROM arkg_components ORDER BY frequency DESC LIMIT 20
  `).all();

  const topEndpoints = db.prepare(`
    SELECT * FROM arkg_api_endpoints ORDER BY frequency DESC LIMIT 10
  `).all();

  const callEdges = new Map();
  for (const comp of topComponents) {
    const edges = db.prepare(`
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
 * Delete observations older than retentionDays days.
 *
 * Called periodically (same cadence as flow retention enforcement). Returns the
 * number of nodes pruned.
 */
export function pruneOldObservations(retentionDays) {
  if (!db) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let pruned = 0;

  const compIds = db.prepare('SELECT id FROM arkg_components WHERE last_observed_at < ?').all(cutoff).map((r) => r.id);
  for (const id of compIds) {
    db.prepare('DELETE FROM arkg_edges WHERE from_node_id = ? OR to_node_id = ?').run(id, id);
    db.prepare('DELETE FROM arkg_components WHERE id = ?').run(id);
    pruned++;
  }

  const epIds = db.prepare('SELECT id FROM arkg_api_endpoints WHERE last_observed_at < ?').all(cutoff).map((r) => r.id);
  for (const id of epIds) {
    db.prepare('DELETE FROM arkg_edges WHERE from_node_id = ? OR to_node_id = ?').run(id, id);
    db.prepare('DELETE FROM arkg_api_endpoints WHERE id = ?').run(id);
    pruned++;
  }

  db.prepare('DELETE FROM arkg_named_flows WHERE last_observed_at < ?').run(cutoff);
  db.prepare('DELETE FROM arkg_source_files WHERE last_observed_at < ?').run(cutoff);

  return pruned;
}
