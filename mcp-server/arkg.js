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
 *
 * ## Component identity, and why it is not the id
 *
 * The two things that feed this graph disagree about what a component *is*. A
 * flow arrives carrying the extension's own ids — an FNV hash of the display
 * name and the head of the compiled function source, minted in the MAIN world
 * by `core/react/id.ts`. A pick from the panel carries a name, a path and a
 * line and nothing else: the compiled source it would take to mint that hash
 * lives in the page and is never sent. So the server cannot derive the id, and
 * for a while it invented a second one. The same component observed both ways
 * became two rows with one `display_name`, and `frequency`, `failure_rate` and
 * every percentile were split across them — which is the one thing an
 * accumulating graph must not do.
 *
 * The fix is to stop treating the primary key as the identity. A node keeps
 * whichever id first created it, so every id already written into an edge or
 * handed to a reader still resolves, and identity is instead
 * **(display_name, source_file)** — the pair both sides can always produce.
 * `arkg_component_aliases` maps every id that has ever stood for a node to the
 * row that survived, and `canonicalId` is walked before any lookup.
 *
 * An incoming observation resolves in this order: its own id (through the
 * aliases), then an exact identity match, then — only when one candidate is
 * unambiguous — a match that fills a gap, a pick learning the file a flow never
 * resolved, or a flow id landing on a node a pick created first. When two rows
 * turn out to share an identity after the fact, they are merged: frequencies
 * sum, timing windows concatenate, failure rates fold by observation count, and
 * the loser's edges are re-pointed onto the survivor.
 *
 * `id_source` is what keeps that from over-merging. It records whether a row's
 * id is the extension's ('flow') or one this file minted from a name and a path
 * ('pick'), and only a *provisional* row — a pick's — may be folded into
 * another on the strength of a name alone. Without it, two genuinely different
 * components that a minified build both calls `Button`, seen in one recording
 * with two FNV ids and no resolved source, would collapse into one node. A row
 * predating the column is not guessed at: the two id schemes have different
 * lengths, so `backfillIdSource` reads the provenance back off the key itself.
 *
 * **The tradeoff, stated plainly.** Two components that really do share a name
 * *and* a file — a wrapper and the thing it wraps, both `Row`, both in
 * `Row.tsx` — are now one node, and their statistics are pooled. That is the
 * price, and it is the right way round: an over-merged node still answers "how
 * hot is this file's Row" approximately, while a split node answers every
 * question about a component with half of the evidence and no way for a reader
 * to tell. Where the name is ambiguous and the file unknown, nothing is guessed
 * — the observation gets its own provisional row and waits for a source to
 * arrive.
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
    failure_rate REAL NOT NULL DEFAULT 0,
    id_source TEXT
  );

  /*
   * Every id that has ever stood for a component, and the row it stands for now.
   *
   * A merge deletes one of two rows, and the id it was keyed by is not this
   * file's to forget: it is in the extension's saved flows, in edges written by
   * an earlier version, and in whatever a reader copied out of
   * get_app_architecture last week. An alias is how those keep resolving.
   */
  CREATE TABLE IF NOT EXISTS arkg_component_aliases (
    alias_id TEXT PRIMARY KEY,
    component_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
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
  CREATE INDEX IF NOT EXISTS idx_arkg_components_identity ON arkg_components(display_name, source_file);
  CREATE INDEX IF NOT EXISTS idx_arkg_component_aliases_target ON arkg_component_aliases(component_id);
  CREATE INDEX IF NOT EXISTS idx_arkg_api_endpoints_last ON arkg_api_endpoints(last_observed_at);
`;

// ── Identity ──────────────────────────────────────────────────────────────────

/**
 * Id for a component this server had to key itself.
 *
 * Only ever reached when nothing already in the graph answers to the
 * observation's identity — see `resolvePick`. It is a *provisional* key, marked
 * `id_source = 'pick'`, and an arriving flow may adopt the row it names.
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
 * The shape of an id this file minted: a sha256 prefix, sixteen hex characters.
 *
 * Every other id in the table came from the extension, and none of them can
 * look like this — `core/react/id.ts` emits ten hex characters, or `n`/`n_` and
 * eight. So the id itself carries the provenance that `id_source` records, and
 * a database written before that column existed can have it recovered rather
 * than guessed. It matters because the whole no-over-merging rule turns on it:
 * without provenance every legacy row would have to be treated as adoptable, or
 * none of them could be.
 */
const MINTED_HERE = /^[0-9a-f]{16}$/;

function backfillIdSource() {
  const unknown = db.prepare('SELECT id FROM arkg_components WHERE id_source IS NULL').all();
  if (!unknown.length) return;
  const set = db.prepare('UPDATE arkg_components SET id_source = ? WHERE id = ?');
  for (const row of unknown) set.run(MINTED_HERE.test(row.id) ? PROVISIONAL : ANCHORED, row.id);
}

// ── Component identity ────────────────────────────────────────────────────────

/** Ids minted by the extension are anchored; ids minted here are provisional. */
const ANCHORED = 'flow';
const PROVISIONAL = 'pick';

/**
 * The row an id names now, after however many merges have happened to it.
 *
 * One hop is enough because a merge re-points the loser's own aliases at the
 * survivor, so an alias never points at a row that has itself been merged away.
 */
function canonicalId(id) {
  const row = sql('SELECT component_id FROM arkg_component_aliases WHERE alias_id = ?').get(id);
  return row ? row.component_id : id;
}

function recordAlias(aliasId, componentId_, now) {
  if (!aliasId || aliasId === componentId_) return;
  sql(`
    INSERT INTO arkg_component_aliases (alias_id, component_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(alias_id) DO UPDATE SET component_id = excluded.component_id
  `).run(aliasId, componentId_, now);
}

const componentRow = (id) => sql('SELECT * FROM arkg_components WHERE id = ?').get(id) ?? null;

/** Every row carrying this display name. The candidate set for every join below. */
const namedRows = (name) =>
  sql('SELECT * FROM arkg_components WHERE display_name = ?').all(name);

/**
 * Of two rows that turn out to be one component, the one that survives.
 *
 * The older row wins, so the surviving id is the one that has been visible for
 * longest and is likeliest to be the one somebody already has. The id breaks a
 * tie only so that a merge is deterministic — two picks in the same
 * millisecond must not depend on row order.
 */
function older(a, b) {
  if (a.first_observed_at !== b.first_observed_at) {
    return a.first_observed_at < b.first_observed_at ? a : b;
  }
  return a.id <= b.id ? a : b;
}

/**
 * Which existing row a *pick* is an observation of, or null for a new one.
 *
 * A pick has no strong id, so this is the whole of its identity. An exact
 * (name, file) match is unambiguous. Everything else is a gap being filled from
 * one side or the other and is taken only when exactly one candidate could fill
 * it: a pick that knows the file joins the one same-named row that never
 * resolved a source, and a pick that does not know the file joins the one
 * same-named row there is. Two candidates and it guesses nothing.
 */
function resolvePick(name, sourceFile) {
  const named = namedRows(name);
  if (!named.length) return null;

  if (sourceFile) {
    const exact = named.filter((row) => row.source_file === sourceFile);
    if (exact.length) return exact.reduce(older);
    const unsourced = named.filter((row) => row.source_file === null);
    return unsourced.length === 1 ? unsourced[0] : null;
  }

  if (named.length === 1) return named[0];
  const unsourced = named.filter((row) => row.source_file === null);
  return unsourced.length === 1 ? unsourced[0] : null;
}

/**
 * Which existing row a *flow* component is, when its own id names none.
 *
 * Far narrower than `resolvePick`, and deliberately: the flow's id is real
 * identity — a hash over the compiled function source — so two flow ids are two
 * components even where the names agree. Only a provisional row, one a pick
 * created because it had no better key, may be adopted here. Adopting it
 * anchors it, so the next unfamiliar flow id finds nothing to take.
 */
function resolveFlowComponent(name, sourceFile) {
  const candidates = namedRows(name).filter((row) => row.id_source === PROVISIONAL);
  if (!candidates.length) return null;

  if (sourceFile) {
    const exact = candidates.filter((row) => row.source_file === sourceFile);
    if (exact.length) return exact.reduce(older);
    const unsourced = candidates.filter((row) => row.source_file === null);
    return unsourced.length === 1 ? unsourced[0] : null;
  }

  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Fold two timing windows into one.
 *
 * Concatenated and trimmed from the front, because `updateTimingStats` appends
 * and the tail is therefore the newer half of each — the half the percentiles
 * are meant to track. A row with a stored p50 but no window is a legacy row, or
 * one whose window was written before the column existed; there is nothing to
 * concatenate, so the busier of the two rows keeps its percentiles rather than
 * having them averaged into a number neither node ever observed.
 */
function mergeTimingWindows(winner, loser) {
  const parse = (json) => {
    if (!json) return [];
    try { const parsed = JSON.parse(json); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  };

  const samples = [...parse(loser.timing_samples), ...parse(winner.timing_samples)];
  if (!samples.length) {
    const busier = winner.frequency >= loser.frequency ? winner : loser;
    const other = busier === winner ? loser : winner;
    return {
      samples: null,
      p50: busier.timing_p50_ms ?? other.timing_p50_ms ?? null,
      p95: busier.timing_p95_ms ?? other.timing_p95_ms ?? null,
    };
  }

  const kept = samples.slice(-WINDOW_SIZE);
  const sorted = [...kept].sort((a, b) => a - b);
  return {
    samples: JSON.stringify(kept),
    p50: computePercentile(sorted, 0.5),
    p95: computePercentile(sorted, 0.95),
  };
}

/** Two failure rates folded by how many observations each stands for. */
function mergeFailureRates(winner, loser) {
  const total = winner.frequency + loser.frequency;
  if (total <= 0) return 0;
  return (winner.failure_rate * winner.frequency + loser.failure_rate * loser.frequency) / total;
}

const EDGE_MATCH =
  'SELECT * FROM arkg_edges WHERE type = ? AND from_node_type = ? AND from_node_id = ? AND to_node_type = ? AND to_node_id = ?';

/**
 * Move every edge off a merged-away component and onto the survivor.
 *
 * Three cases, and the second is the one that would otherwise corrupt the
 * graph. An edge whose other end is untouched is simply re-pointed. An edge
 * that now duplicates one the survivor already has is folded into it and
 * dropped, because two `calls` edges between the same pair is exactly the split
 * this merge exists to undo. An edge whose two ends have become the same node —
 * a `renders` edge between the two halves of one component — is deleted: a
 * component does not render itself, and leaving it would put a self-loop into
 * every render tree drawn from here.
 */
function repointEdges(loserId, winnerId) {
  const touching = sql(`
    SELECT * FROM arkg_edges
    WHERE (from_node_type = 'component' AND from_node_id = ?)
       OR (to_node_type = 'component' AND to_node_id = ?)
  `).all(loserId, loserId);

  const dropEdge = sql('DELETE FROM arkg_edges WHERE id = ?');

  for (const edge of touching) {
    const fromId = edge.from_node_type === 'component' && edge.from_node_id === loserId ? winnerId : edge.from_node_id;
    const toId = edge.to_node_type === 'component' && edge.to_node_id === loserId ? winnerId : edge.to_node_id;

    if (edge.from_node_type === edge.to_node_type && fromId === toId) {
      dropEdge.run(edge.id);
      continue;
    }

    const existing = sql(EDGE_MATCH).get(edge.type, edge.from_node_type, fromId, edge.to_node_type, toId);
    if (!existing || existing.id === edge.id) {
      sql('UPDATE arkg_edges SET from_node_id = ?, to_node_id = ? WHERE id = ?').run(fromId, toId, edge.id);
      continue;
    }

    const timing = mergeTimingWindows(existing, edge);
    sql(`
      UPDATE arkg_edges SET
        frequency = ?,
        failure_rate = ?,
        timing_p50_ms = ?,
        timing_p95_ms = ?,
        timing_samples = ?,
        first_observed_at = MIN(first_observed_at, ?),
        last_observed_at = MAX(last_observed_at, ?),
        flow_id = COALESCE(flow_id, ?)
      WHERE id = ?
    `).run(
      existing.frequency + edge.frequency,
      mergeFailureRates(existing, edge),
      timing.p50, timing.p95, timing.samples,
      edge.first_observed_at, edge.last_observed_at, edge.flow_id,
      existing.id,
    );
    dropEdge.run(edge.id);
  }
}

/**
 * Make two rows one, and return the id of the one that is left.
 *
 * Counts sum, because both rows counted real observations of one component and
 * the sum is what the graph was always supposed to hold. Timestamps take the
 * outer bound, so a merged node's history is as long as the longer of the two.
 * The source is coalesced rather than chosen: whichever row learned a file
 * keeps it, which is what lets a provisional row survive a merge with an
 * anchored one that never resolved a source.
 */
function mergeComponents(loserId, winnerId, now) {
  if (loserId === winnerId) return winnerId;
  const loser = componentRow(loserId);
  const winner = componentRow(winnerId);
  if (!loser || !winner) return winner ? winnerId : loserId;

  const timing = mergeTimingWindows(winner, loser);
  sql(`
    UPDATE arkg_components SET
      frequency = ?,
      failure_rate = ?,
      first_observed_at = ?,
      last_observed_at = ?,
      source_file = COALESCE(source_file, ?),
      source_line = COALESCE(source_line, ?),
      timing_p50_ms = ?,
      timing_p95_ms = ?,
      timing_samples = ?,
      id_source = ?
    WHERE id = ?
  `).run(
    winner.frequency + loser.frequency,
    mergeFailureRates(winner, loser),
    Math.min(winner.first_observed_at, loser.first_observed_at),
    Math.max(winner.last_observed_at, loser.last_observed_at),
    loser.source_file,
    loser.source_line,
    timing.p50, timing.p95, timing.samples,
    // An anchored id on either side anchors the survivor: the extension has
    // named this component, so nothing else may be adopted onto it.
    winner.id_source === ANCHORED || loser.id_source === ANCHORED ? ANCHORED : (winner.id_source ?? loser.id_source ?? null),
    winnerId,
  );

  repointEdges(loserId, winnerId);
  sql('DELETE FROM arkg_components WHERE id = ?').run(loserId);
  sql('UPDATE arkg_component_aliases SET component_id = ? WHERE component_id = ?').run(winnerId, loserId);
  recordAlias(loserId, winnerId, now);
  return winnerId;
}

/**
 * Merge anything that now shares this row's identity, and say which id survived.
 *
 * Called after every write that could have *created* a duplicate — an insert,
 * or an update that filled in a source file the row did not have before. That
 * is the "later merging" half of the scheme: a pick made against a name too
 * ambiguous to resolve sits in its own row until a flow resolves the file, at
 * which point the two are visibly one component and are made one.
 */
function reconcileIdentity(id, now) {
  const row = componentRow(id);
  if (!row) return id;

  const twins = sql(
    'SELECT * FROM arkg_components WHERE display_name = ? AND source_file IS ? AND id != ?',
  ).all(row.display_name, row.source_file, id);

  let survivor = row;
  for (const twin of twins) {
    /*
     * A file both rows name is identity enough, and folding there is what makes
     * the graph accumulate across rebuilds: the extension's id is a hash over
     * compiled source, so editing a component re-keys it, and without this a
     * component would file a fresh node every time anyone touched it.
     *
     * A file *neither* names is not identity. Two ids the extension minted
     * separately are two components — that is what the hash is for — and on a
     * minified build with no source map they are both called `e`. So a bare
     * name folds one row into another only when one of them is provisional:
     * keyed here, from a name, with nothing better behind it.
     */
    if (
      survivor.source_file === null &&
      survivor.id_source === ANCHORED &&
      twin.id_source === ANCHORED
    ) continue;

    const winner = older(survivor, twin);
    const loser = winner === survivor ? twin : survivor;
    mergeComponents(loser.id, winner.id, now);
    survivor = componentRow(winner.id) ?? winner;
  }
  return survivor.id;
}

/**
 * Fold the splits a database made before identity was a join.
 *
 * Run on every open, inside `openArkg`, because an existing `arkg.db` is the
 * only place the old two-nodes-per-component shape can still exist and there is
 * nowhere else to notice it. Both passes are a `GROUP BY … HAVING` over a table
 * of at most a few thousand rows, so on a healthy database this finds nothing
 * and costs one scan.
 *
 * Neither pass has a rule of its own. The first hands each duplicated identity
 * to `reconcileIdentity`, which is the same judgement an incoming observation
 * gets, so a database is never folded in a way a live write would not have
 * folded it. The second is the one case `reconcileIdentity` cannot see, because
 * the two rows do not agree on a source: one name, exactly two rows, one of
 * which never resolved a file, and one of which is provisional. That is
 * precisely the old flow-then-pick split on a production build, and it is the
 * same gap-filling `resolvePick` does at write time — bounded the same way, to
 * a single unambiguous candidate.
 *
 * Returns the number of rows folded away, which is the number of components
 * that were being counted twice.
 */
function mergeSplitIdentities(now = Date.now()) {
  const total = () => db.prepare('SELECT COUNT(*) AS n FROM arkg_components').get()?.n ?? 0;

  return db.transaction(() => {
    const before = total();

    const duplicates = db.prepare(`
      SELECT display_name AS name, source_file AS file FROM arkg_components
      GROUP BY display_name, source_file HAVING COUNT(*) > 1
    `).all();

    for (const group of duplicates) {
      const first = db.prepare(`
        SELECT id FROM arkg_components WHERE display_name = ? AND source_file IS ?
        ORDER BY first_observed_at ASC, id ASC LIMIT 1
      `).get(group.name, group.file);
      if (first) reconcileIdentity(first.id, now);
    }

    const pairs = db.prepare(`
      SELECT display_name AS name FROM arkg_components
      GROUP BY display_name
      HAVING COUNT(*) = 2 AND SUM(source_file IS NULL) = 1 AND SUM(id_source = ?) >= 1
    `).all(PROVISIONAL);

    for (const { name } of pairs) {
      const rows = db.prepare('SELECT * FROM arkg_components WHERE display_name = ?').all(name);
      if (rows.length !== 2) continue;
      const winner = older(rows[0], rows[1]);
      const loser = winner === rows[0] ? rows[1] : rows[0];
      mergeComponents(loser.id, winner.id, now);
    }

    return before - total();
  })();
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
  addMissingColumn('arkg_components', 'id_source', 'TEXT');
  backfillIdSource();
  mergeSplitIdentities();
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
    const insertComponent = sql(`
      INSERT INTO arkg_components (id, display_name, source_file, source_line, first_observed_at, last_observed_at, frequency, id_source)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
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

    /*
     * The flow's own component ids, mapped to the graph rows they landed on.
     *
     * The two are not the same thing: a flow id may resolve onto a row a pick
     * created first, or onto a row a merge in this very loop left behind. The
     * steps below attribute their edges through this map, because an edge
     * written against an id that is now an alias points at nothing.
     */
    const nodeFor = new Map();

    for (const [compId, comp] of Object.entries(components)) {
      const name = comp.name ?? compId;
      const sourceFile = comp.source ?? null;
      const sourceLine = comp.line ?? null;

      const known = canonicalId(compId);
      let nodeId;
      if (componentRow(known)) {
        nodeId = known;
        updateComponent.run(now, sourceFile, sourceLine, nodeId);
      } else {
        const adopted = resolveFlowComponent(name, sourceFile);
        if (adopted) {
          // The extension has now named this component, so the row stops being
          // adoptable by anything else.
          nodeId = adopted.id;
          recordAlias(compId, nodeId, now);
          updateComponent.run(now, sourceFile, sourceLine, nodeId);
          sql('UPDATE arkg_components SET id_source = ? WHERE id = ?').run(ANCHORED, nodeId);
        } else {
          nodeId = compId;
          insertComponent.run(compId, name, sourceFile, sourceLine, now, now, ANCHORED);
        }
      }

      nodeId = reconcileIdentity(nodeId, now);
      nodeFor.set(compId, nodeId);

      // maps_to edge: component -> source file
      if (sourceFile) {
        if (!selectSourceFile.get(sourceFile)) {
          insertSourceFile.run(sourceFile, sourceFile, now, now);
        } else {
          updateSourceFile.run(now, sourceFile);
        }
        upsertEdge('maps_to', 'component', nodeId, 'source_file', sourceFile, flowId, now);
      }
    }

    /** A component id as it arrived in the flow, as the row it stands for now. */
    const resolvedNode = (id) => nodeFor.get(id) ?? canonicalId(id);

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
          upsertEdge('calls', 'component', resolvedNode(owner), 'api_endpoint', epId, flowId, now, durationMs, failed);
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
        const from = resolvedNode(chain[i + 1]);
        const to = resolvedNode(chain[i]);
        // A chain whose two neighbours merged into one row is a component
        // rendering itself, which is not a fact about anything.
        if (from !== to) upsertEdge('renders', 'component', from, 'component', to, flowId, now);
      }
    }
  })();
}

/**
 * Ingest a single component pick from the DevTools panel locator.
 *
 * Shape: { id?, name, sourceFile, sourceLine, timingMs?, failed? }
 *
 * The pick's node is *found* before it is keyed. `id` is a caller's assertion
 * that it already knows the node — the HTTP endpoint never passes one — and
 * even then it is followed through the aliases and abandoned if it names
 * nothing, because the identity a pick can actually vouch for is its name and
 * its file. A minted id is the last resort and the only one marked provisional.
 */
export function ingestComponentPick(pick) {
  if (!db) return;

  const now = Date.now();
  const name = pick.name ?? '';
  const sourceFile = pick.sourceFile ?? null;
  const sourceLine = pick.sourceLine ?? null;
  const durationMs = typeof pick.timingMs === 'number' ? pick.timingMs : null;
  const failed = pick.failed === true;

  db.transaction(() => {
    const asserted = typeof pick.id === 'string' && pick.id ? canonicalId(pick.id) : null;
    const matched = (asserted && componentRow(asserted)) || resolvePick(name, sourceFile);
    const compId = matched ? matched.id : (pick.id ?? componentId(name, sourceFile));
    if (matched) recordAlias(pick.id, compId, now);

    const existing = matched ?? null;
    if (!existing) {
      // The first sample counts. Dropping it here would leave a component that
      // is only ever picked once reporting no timing at all.
      const ts = durationMs !== null
        ? updateTimingStats(null, durationMs)
        : { samples: null, p50: null, p95: null };
      sql(`
        INSERT INTO arkg_components (id, display_name, source_file, source_line, first_observed_at, last_observed_at, frequency, timing_p50_ms, timing_p95_ms, timing_samples, failure_rate, id_source)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(compId, pick.name ?? compId, sourceFile, sourceLine, now, now,
        ts.p50, ts.p95, ts.samples,
        failed ? 1.0 : 0.0,
        // Anchored only when the caller vouched for the id. Nothing on the wire
        // does, so a pick's own row stays adoptable by the flow that names it.
        pick.id ? ANCHORED : PROVISIONAL);
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

    // A pick that has just taught the graph which file a component lives in may
    // have made it a visible twin of a row that already knew.
    reconcileIdentity(compId, now);
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

/**
 * Full component node with all edges that touch it.
 *
 * The id is followed through the aliases first, so an id read out of a saved
 * flow, or out of an answer given before a merge, still lands on the row that
 * holds the observations it was asking about.
 */
export function getComponent(id) {
  if (!db) return null;
  const target = canonicalId(id);
  const comp = sql('SELECT * FROM arkg_components WHERE id = ?').get(target);
  if (!comp) return null;
  const edges = sql(`
    SELECT * FROM arkg_edges
    WHERE (from_node_type = 'component' AND from_node_id = ?)
       OR (to_node_type = 'component' AND to_node_id = ?)
  `).all(target, target);
  return { ...comp, edges };
}

/**
 * The component a reader means when they type a name, or null.
 *
 * Names are what a person has in front of them — in a stack trace, in the file
 * they are reading — and ids are a hash. Without this the only name lookup in
 * the system ran through `getAppArchitecture`, which meant a name resolved only
 * to the twenty busiest components and only once a flow had been ingested: a
 * component known solely from picks was unreachable by any argument a caller
 * could plausibly hold.
 *
 * Case-insensitive, because the caller is quoting a name rather than a key. A
 * name shared by several rows — different files, so genuinely different
 * components — resolves to the most observed of them, which is the one a bare
 * name most likely meant and the only one that can be chosen without asking.
 */
export function getComponentByName(name) {
  if (!db) return null;
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (!wanted) return null;

  const row = sql(`
    SELECT id FROM arkg_components WHERE display_name = ? COLLATE NOCASE
    ORDER BY frequency DESC, last_observed_at DESC, id ASC LIMIT 1
  `).get(wanted);
  return row ? getComponent(row.id) : null;
}

/**
 * All named flows in which this component appeared (via an edge), since sinceMs
 * (epoch milliseconds, 0 = all history).
 */
export function getComponentHistory(id, sinceMs = 0) {
  if (!db) return [];
  const target = canonicalId(id);
  const edges = sql(`
    SELECT DISTINCT flow_id FROM arkg_edges
    WHERE (from_node_id = ? OR to_node_id = ?)
      AND flow_id IS NOT NULL
      AND last_observed_at >= ?
  `).all(target, target, sinceMs);

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
 *
 * Null means *nothing has ever been observed*, and it used to mean "no flow has
 * been ingested" — which made a graph built entirely from panel picks invisible
 * to every tool that reads this, including the name lookup that used to route
 * through it. Picks are the half of the evidence that arrives while somebody is
 * reading code rather than recording, and a graph that has only those still has
 * something to say. `totalFlows` of 0 alongside a component list is a state the
 * caller has to render, not a state this refuses to report.
 */
export function getAppArchitecture() {
  if (!db) return null;

  const count = (table) => sql(`SELECT COUNT(*) as n FROM ${table}`).get()?.n ?? 0;
  const totalFlows = count('arkg_named_flows');
  const totalComponents = count('arkg_components');
  const totalEndpoints = count('arkg_api_endpoints');
  if (totalFlows === 0 && totalComponents === 0 && totalEndpoints === 0) return null;

  const lastFlow = sql('SELECT MAX(last_observed_at) as t FROM arkg_named_flows').get()?.t;
  const lastComponent = sql('SELECT MAX(last_observed_at) as t FROM arkg_components').get()?.t;
  const lastSeenAt = Math.max(lastFlow ?? 0, lastComponent ?? 0) || null;

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
    totalComponents,
    totalEndpoints,
    lastSeen: lastSeenAt ? new Date(lastSeenAt).toISOString().slice(0, 10) : null,
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

    // An alias to a node that no longer exists resolves to nothing, which reads
    // as "never observed" — the same answer, one lookup later. Dropped with the
    // node so the table does not outgrow the graph it points into.
    for (const chunk of chunked(compIds)) {
      const holes = chunk.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM arkg_component_aliases WHERE component_id IN (${holes}) OR alias_id IN (${holes})`,
      ).run(...chunk, ...chunk);
    }

    deleteNodes('arkg_components', compIds);
    deleteNodes('arkg_api_endpoints', epIds);
    deleteNodes('arkg_source_files', fileIds);

    sql('DELETE FROM arkg_named_flows WHERE last_observed_at < ?').run(cutoff);

    return compIds.length + epIds.length;
  })();
}
