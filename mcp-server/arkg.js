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
 *
 * ## Application state, and the one thing a subscriber list cannot say
 *
 * A recording that read the app's state carries two kinds of fact, observed at
 * two different granularities. The patches are per *key*: a step that
 * dispatched `addToCart` names `/cart/items/0`, and `cart` is the key that
 * moved. The subscriber list is per *store*: a component is on it because its
 * own fiber carried a dependency on the store, which says it reads the store
 * and says nothing at all about which key of it.
 *
 * So `subscribes_to` runs component → **store**, and there is an
 * `arkg_state_stores` node for it to point at. Crossing a store's subscribers
 * with a store's keys is one line shorter and asserts a fact nobody observed: a
 * component that reads `state.cart` would come out of the graph with an edge to
 * `state.auth`, indistinguishable from an edge somebody actually saw. Keys hang
 * off their store by `store_id`, so "which keys does the store this component
 * reads have" is one query away — left as a hop because that is what it is.
 *
 * A state key node carries `frequency` and `change_count` and no percentiles.
 * Nothing times a key, so `timing_p50`/`timing_p95` on one would be columns
 * that are always NULL — the exact shape of the `git_sha` columns the audit
 * called out, and the reason the roadmap's "properties on every node" line is
 * deliberately not followed here. `frequency` counts the recordings a key was
 * observed in; `change_count` counts the steps whose patch touched it, which is
 * the question the node exists to answer and the one `frequency` cannot: a key
 * present in every recording and never once written is not a hotspot.
 *
 * A key's id is **(store kind, store label, key name)** and never the
 * `StateStoreRef.id` the recording minted. That id is documented stable for the
 * life of *one recording*, so keying on it would file a fresh `cart` node every
 * time anybody pressed Record and the counts would never rise above 1. The cost
 * is that two unlabelled stores of the same kind — the page said nothing about
 * either — are one node, and their keys pool. That is the right way round for
 * the same reason the component join is: an over-merged node answers
 * approximately, while a per-recording node answers nothing, twice.
 *
 * ## What a baseline can be here, and what it cannot
 *
 * `getAnomalies` used to compare an entity to a constant — 10% failures, a p95
 * three times the p50 — and a constant is not a baseline. It says the same
 * thing about an endpoint that has always taken 8ms and one that has always
 * taken 800ms. The test the roadmap asked for is whether an entity is outside
 * its *own* past, and the one distribution this graph holds is `timing_samples`:
 * the recency-biased window `updateTimingStats` keeps per node. So the σ test is
 * over that window and over nothing else — the mean and the population σ of the
 * window, against the window's own p95. Population σ rather than sample σ
 * because the window is not a sample of something wider: the question is
 * whether one number of this window sits outside this window's spread, and at
 * thirty samples the two differ by under two per cent regardless.
 *
 * Against a well-behaved distribution a p95 lands near μ + 1.64σ, so 2σ is the
 * point where the tail is heavier than the body predicts. That is the same
 * "occasional severe spike" the p95/p50 rule was reaching for, said against the
 * entity's history instead of against a number chosen here. It is deliberately
 * deaf to a lone outlier: a p95 ignores the top five per cent of its window, so
 * this fires when the slow tail is *broad*, not when one call once took a
 * second.
 *
 * A σ of zero is an entity that did the identical thing every time it was
 * observed. Every deviation from a distribution with no width is infinite, and
 * reporting them would make the steadiest endpoint in the graph the loudest row
 * in the answer. Nothing has moved, so nothing is reported.
 *
 * **Failure rate stays a threshold, and is labelled one.** A σ test needs a
 * distribution, and what the graph holds per entity is a single rolling rate —
 * one scalar, not a sample of past rates. There is no honest σ to take of it,
 * so the 10% and 5% thresholds stay, every anomaly carries `basis: 'threshold'`
 * or `basis: 'baseline'` so a reader can tell which it is holding, and the
 * failure-rate `detail` says in words that it is a threshold. Turning it into a
 * baseline means storing a per-flow failure history per entity — a new table
 * and a new retention question — and it is left undone rather than done badly.
 *
 * "Not enough observations" is not "nothing is wrong", and one empty array
 * cannot tell a caller which of the two it was handed. `getAnomalyReport` is
 * the shape that can: `examined` is how many entities had the observations to
 * be judged and `tooNew` is how many were in the window and short of them.
 * `getAnomalies` stays the array it always was, so nothing that reads it has to
 * change to keep working.
 *
 * ## Causality, and which links survive the recording they were found in
 *
 * `buildCausalGraph` links *events*: in this recording `net:3.1` caused
 * `log:3.2`. Those refs mean nothing in a graph that accumulates across
 * recordings — the same fault as `StateStoreRef.id` — so an edge between two of
 * them is a row that answers no question the second time anybody reads it. A
 * causal link is therefore written only when both of its ends project onto a
 * node this file already keys stably: a network event onto its `api_endpoint`,
 * a state event onto its `state_store`, a step onto the component it was
 * attributed to.
 *
 * A console entry projects onto nothing. Its identity is a message string, and
 * there is no node type here that keys one; the nearest thing available would
 * be a `console_message` node invented to give the link somewhere to land,
 * which is the cross product this file refuses everywhere else. So every link
 * with a `log:` end is dropped, and "a click caused a fetch that logged an
 * error" reaches this graph as the click → fetch half alone. The whole chain
 * lives in the recording, which is the one place its refs still mean something.
 * Two of `core/causal`'s four bases — `named` and `followed` — only ever end on
 * a console entry, so as that module stands today neither of them reaches this
 * graph at all. That is a property of what is observable, not a rule here: a
 * `named` link between two events that both project would be written the same
 * as any other.
 *
 * The step → network link is dropped as well, and for the opposite reason: it
 * projects onto the pair `calls` already joins, out of the same fact. An
 * `attributed` link *is* the recorder having filed the call under the open step,
 * which is the whole of what `calls` is built from, so a `caused_by` row beside
 * it would be one observation counted twice under two names. What is left is
 * the two pairs nothing else in this graph asserts: a component to the store
 * its interaction moved, and an endpoint to the store its response was echoed
 * into.
 *
 * `basis` and `confidence` ride inside the edge's `type` —
 * `caused_by:named:high` — rather than in two columns beside it, because they
 * are identity and not property. `upsertEdge` matches on (type, from, to), so a
 * column would let a `followed`/`low` observation of a pair overwrite an
 * `attributed`/`high` one and leave a guess wearing the evidence of an
 * observation, which is precisely what Work Stream 1.3 was told not to ship. In
 * the type they are part of the key instead: one row per pair *per kind of
 * evidence*, each accumulating its own frequency, and no reader can hold the
 * edge without also holding what it was built on.
 */

import Database from 'better-sqlite3';
import crypto from 'node:crypto';

/*
 * The causal builder is reached through the namespace and never by name.
 *
 * `core.js` is a build artefact, and an installed copy of this package can
 * easily be older than the module the symbol comes from. A missing *named*
 * import is a link error, which takes the whole server down at startup over a
 * feature that is an addition to one query; a missing *property* costs a flow
 * its causal edges, which is already what happens for a recording that has no
 * causal links in it.
 */
import * as core from './core.js';

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

  /*
   * A store one or more recordings read, keyed by what survives a recording.
   *
   * change_count is steps in which the store moved at all, which is where an
   * operation at the empty pointer — a replace of the whole store, naming no
   * key — is counted, since there is no key it could honestly be charged to.
   */
  CREATE TABLE IF NOT EXISTS arkg_state_stores (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 1,
    change_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS arkg_state_keys (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    store_kind TEXT NOT NULL,
    store_label TEXT,
    key_name TEXT NOT NULL,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 1,
    change_count INTEGER NOT NULL DEFAULT 0
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
  CREATE INDEX IF NOT EXISTS idx_arkg_state_keys_store ON arkg_state_keys(store_id);
  CREATE INDEX IF NOT EXISTS idx_arkg_state_keys_last ON arkg_state_keys(last_observed_at);
  CREATE INDEX IF NOT EXISTS idx_arkg_state_stores_last ON arkg_state_stores(last_observed_at);
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

/**
 * Stable id for a store, and for one top-level key of one store.
 *
 * Keyed on what outlives a recording — the kind and the label the page gave it
 * — because `StateStoreRef.id` does not: it is stable for the life of one
 * recording only, and a node keyed by it would be a new node per Send. A store
 * the page never named has an empty label, so every unlabelled store of one
 * kind is one node; see the header for why that is the tolerable direction.
 */
function stateStoreId(kind, label) {
  return crypto.createHash('sha256').update(`state|${kind}|${label ?? ''}`).digest('hex').slice(0, 16);
}

function stateKeyId(kind, label, key) {
  return crypto
    .createHash('sha256')
    .update(`state-key|${kind}|${label ?? ''}|${key}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * The state key one patch operation touched, or null when it names none.
 *
 * RFC 6901: the first segment of `/cart/items/0` is the key, and `~1` and `~0`
 * are `/` and `~` written so a segment can contain them. The two replacements
 * are ordered and the order is the whole correctness of this function — `~0`
 * first turns the escaped literal `~01` into `~1` and then into `/`, inventing
 * a key separator the app never had. `~1` first is the only order that
 * round-trips.
 *
 * Two paths name no key. The empty pointer `""` replaced the entire store, so
 * every key changed and none is named; charging it to the keys already on file
 * would credit keys it may have deleted and miss the ones it added, so it is
 * counted on the store instead and on no key. A path that is not a pointer at
 * all — no leading `/` — is not understood, and a guess about it would be
 * indistinguishable in the graph from an observation.
 */
function pointerHead(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  const segment = path.slice(1).split('/')[0] ?? '';
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
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

  /*
   * The state block joins the hash only when there is one. A flow that carries
   * no state stringifies to exactly the bytes it did before this existed, so
   * every recording already in somebody's database keeps the hash it was stored
   * under and a re-send of it is still a re-send. The step deltas are inside
   * `steps` and were always hashed; what this adds is the store list, so a
   * recording re-sent after the page revealed another subscriber counts as the
   * new evidence it is.
   */
  const contentHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ steps, components, ...(flowJson.state ? { state: flowJson.state } : {}) }))
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

    // Inside the guard above, and it has to be: `change_count` is a count of
    // steps that changed something, and a second Send of one recording is not a
    // second time the application changed anything.
    ingestState(flowJson, steps, resolvedNode, flowId, now);

    // Inside it for the same reason. A causal edge's frequency is how many
    // recordings showed one thing following from another; a re-send of one
    // recording is not a second showing.
    ingestCausal(flowJson, steps, resolvedNode, flowId, now);
  })();
}

// ── Application state ─────────────────────────────────────────────────────────

/**
 * Write the stores, the state keys and the subscribes_to edges of one flow.
 *
 * A no-op unless the recording actually read state: `state` absent is every
 * flow recorded before this existed, and `read: false` is a recording that
 * could not read state — a page with no React, capture switched off, no store
 * recognised. None of the three is evidence of anything, and re-ingesting one
 * must leave the graph exactly as it was.
 *
 * `resolveComponent` maps a component id as the flow wrote it onto the row it
 * landed on, which is the same indirection the `calls` and `renders` edges go
 * through: a subscriber id written straight into an edge points at nothing the
 * moment that component's row is merged into another.
 */
function ingestState(flowJson, steps, resolveComponent, flowId, now) {
  const state = flowJson.state;
  if (!state || state.read !== true) return;
  const stores = Array.isArray(state.stores) ? state.stores : [];
  if (!stores.length) return;

  /** The recording's own store id → the node it stands for, for this flow only. */
  const nodeForStore = new Map();
  for (const store of stores) {
    if (!store || typeof store.id !== 'string') continue;
    const kind = typeof store.kind === 'string' ? store.kind : '';
    const label = typeof store.label === 'string' ? store.label : null;
    nodeForStore.set(store.id, { id: stateStoreId(kind, label), kind, label, store });
  }

  /*
   * Counted before anything is written, because both counts are per *flow*, not
   * per operation: a store seen in forty steps of one recording is one
   * observation of that store, and a key touched three times in one step is one
   * step in which it changed.
   */
  const storeChanges = new Map();
  const keyChanges = new Map();

  for (const step of steps) {
    for (const delta of step.state ?? []) {
      const node = delta && nodeForStore.get(delta.store);
      // A delta naming a store the flow never described is unreadable: there is
      // no kind and no label to key it by, so there is no node to charge it to.
      if (!node) continue;
      const ops = Array.isArray(delta.patch) ? delta.patch : [];
      if (!ops.length) continue;

      storeChanges.set(node.id, (storeChanges.get(node.id) ?? 0) + 1);

      const touched = new Set();
      for (const op of ops) {
        const key = pointerHead(op?.path);
        if (key !== null) touched.add(key);
      }
      for (const key of touched) {
        const id = stateKeyId(node.kind, node.label, key);
        const seen = keyChanges.get(id);
        if (seen) seen.changes += 1;
        else keyChanges.set(id, { node, key, changes: 1 });
      }
    }
  }

  const upsertStore = sql(`
    INSERT INTO arkg_state_stores (id, kind, label, first_observed_at, last_observed_at, frequency, change_count)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_observed_at = excluded.last_observed_at,
      frequency = frequency + 1,
      change_count = change_count + excluded.change_count
  `);
  const upsertKey = sql(`
    INSERT INTO arkg_state_keys (id, store_id, store_kind, store_label, key_name, first_observed_at, last_observed_at, frequency, change_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_observed_at = excluded.last_observed_at,
      frequency = frequency + 1,
      change_count = change_count + excluded.change_count
  `);

  const written = new Set();
  for (const node of nodeForStore.values()) {
    // One recording may describe the same store twice — two contexts with one
    // displayName are one node here — and that is one observation of it.
    if (written.has(node.id)) continue;
    written.add(node.id);
    upsertStore.run(node.id, node.kind, node.label, now, now, storeChanges.get(node.id) ?? 0);
  }

  for (const [id, { node, key, changes }] of keyChanges) {
    upsertKey.run(id, node.id, node.kind, node.label, key, now, now, changes);
  }

  /*
   * subscribes_to is component → store, never component → key. `subscribers` is
   * a property of the store — a component is on it because its fiber depended
   * on the store — so an edge to one of the store's keys would be arithmetic
   * presented as observation. See the header.
   */
  // Kept across the whole loop, not per store: one recording naming a
  // component twice — on one store listed twice, or under two ids that turned
  // out to be one row — saw it read that store once.
  const drawn = new Set();
  for (const node of nodeForStore.values()) {
    const subscribers = Array.isArray(node.store.subscribers) ? node.store.subscribers : [];
    for (const sub of subscribers) {
      if (typeof sub !== 'string') continue;
      const from = resolveComponent(sub);
      // An edge from a component the graph has no row for is unreachable from
      // `getComponent`, which is the only way anybody reads these.
      if (!from || !componentRow(from) || drawn.has(`${node.id}|${from}`)) continue;
      drawn.add(`${node.id}|${from}`);
      upsertEdge('subscribes_to', 'component', from, 'state_store', node.id, flowId, now);
    }
  }
}

// ── Causality ─────────────────────────────────────────────────────────────────

/**
 * Basis and confidence are written into the edge type, so neither may contain
 * the separator that would make the type unparseable — and a value this file
 * has never heard of is kept rather than rejected, because a later basis in
 * `core/causal` is still evidence and a whitelist frozen here would silently
 * drop the links carrying it.
 */
const CAUSAL_TOKEN = /^[a-z]+$/;

const CAUSAL_PREFIX = 'caused_by:';

function causalType(basis, confidence) {
  if (typeof basis !== 'string' || typeof confidence !== 'string') return null;
  if (!CAUSAL_TOKEN.test(basis) || !CAUSAL_TOKEN.test(confidence)) return null;
  return `${CAUSAL_PREFIX}${basis}:${confidence}`;
}

/**
 * Where each ref's numbers point in the recording, worked out from the graph.
 *
 * None of the numbering in a ref is this file's to assume. A step is numbered
 * `stepNumber ?? i + 1` by `core/causal`, so a recording whose steps carry
 * their own numbers is numbered by the recording and not by the array; and the
 * base the calls within a step are counted from is that module's business,
 * which it has already changed once. Copying either rule here would be a second
 * copy of somebody else's arithmetic, wrong the first time they touch it and
 * silent when it goes wrong — the failure would be no causal edges, for ever,
 * with every test still green.
 *
 * What is structural, and what this reads instead: the module emits exactly one
 * event per step and exactly one per network call, in the recording's order for
 * steps. So the step events in order *are* the steps in order, and a step's
 * network indices, sorted, are a permutation of its calls' positions — the kth
 * smallest index is `networkCalls[k]` whatever the module started counting
 * from.
 */
function causalPositions(events) {
  const steps = new Map();
  const indices = new Map();

  for (const event of events ?? []) {
    if (event?.kind === 'step') {
      if (!steps.has(event.step)) steps.set(event.step, steps.size);
      continue;
    }
    if (event?.kind !== 'network') continue;
    const parsed = core.parseEventRef(event.ref);
    if (!parsed || typeof parsed.index !== 'number') continue;
    const seen = indices.get(event.step) ?? new Set();
    seen.add(parsed.index);
    indices.set(event.step, seen);
  }

  const network = new Map();
  for (const [step, seen] of indices) {
    [...seen].sort((a, b) => a - b).forEach((value, rank) => network.set(`${step}.${value}`, rank));
  }
  return { steps, network };
}

/**
 * The stable node one causal event ref stands for, or null when it has none.
 *
 * Every part of the ref is looked up in the recording rather than trusted: a
 * ref naming a step, a call or a delta the flow does not contain yields null
 * and its link is dropped, which is what keeps a change in the grammar from
 * writing edges out of misread indices instead of writing none.
 *
 * The node must already exist. A causal edge is read back through
 * `getCausalEdges` and `getComponent`, both of which resolve the far end, so an
 * edge to a row that was never written is a row nobody can follow — and the
 * component, endpoint and store writers have all run by the time this is
 * called, so a miss here means the flow genuinely never described that node.
 */
function causalNode(ref, flowJson, steps, positions, resolveComponent) {
  const parsed = core.parseEventRef(ref);
  if (!parsed) return null;
  const step = steps[positions.steps.get(parsed.step) ?? -1];
  if (!step) return null;

  if (parsed.kind === 'step') {
    const owner = step.element?.react?.owner;
    if (typeof owner !== 'string') return null;
    const id = resolveComponent(owner);
    return id && componentRow(id) ? { type: 'component', id } : null;
  }

  if (parsed.kind === 'network') {
    const call = step.networkCalls?.[positions.network.get(`${parsed.step}.${parsed.index}`) ?? -1];
    if (!call || typeof call.url !== 'string') return null;
    const id = endpointId((call.method ?? 'GET').toUpperCase(), call.url);
    return sql('SELECT id FROM arkg_api_endpoints WHERE id = ?').get(id) ? { type: 'api_endpoint', id } : null;
  }

  if (parsed.kind === 'state') {
    /*
     * A state ref's index is the store's id *and* the delta's position, joined
     * by a character neither this file nor the store id gets a say in. The
     * position is there so that two deltas for one store cannot collide, and it
     * is of no use here — every delta of one store projects onto the one node —
     * so the store is taken as the longest id the index begins with and the
     * rest is left alone. Longest, because `s1` is a prefix of `s10`, and a
     * shorter match would file one store's delta under another's node.
     */
    const index = String(parsed.index ?? '');
    const stores = Array.isArray(flowJson.state?.stores) ? flowJson.state.stores : [];
    let store = null;
    for (const entry of stores) {
      if (!entry || typeof entry.id !== 'string' || !index.startsWith(entry.id)) continue;
      if (index.length > entry.id.length && /[\w-]/.test(index[entry.id.length])) continue;
      if (!store || entry.id.length > store.id.length) store = entry;
    }
    if (!store) return null;

    const id = stateStoreId(
      typeof store.kind === 'string' ? store.kind : '',
      typeof store.label === 'string' ? store.label : null,
    );
    return sql('SELECT id FROM arkg_state_stores WHERE id = ?').get(id) ? { type: 'state_store', id } : null;
  }

  // `console` lands here, and so does any kind the module gains later. Both are
  // "no stable node", which is the one answer that cannot invent a row.
  return null;
}

/**
 * Write the `caused_by` edges of one flow.
 *
 * Read the type as a sentence, the way every other edge in this table reads:
 * the `from` is the effect and the `to` is the cause, so `GET /api/cart
 * caused_by CartButton`. `CausalLink` runs the other way — its `from` is the
 * cause, as the DAG in VISION.md draws it — and it is turned round in the one
 * line at the bottom of this function.
 *
 * Both symbols are required, not just the builder. `parseEventRef` is the
 * module's own reader for its own syntax, and its header says why: a ref parsed
 * in two places is a syntax that has already forked. So a bundle that ships one
 * without the other writes no causal edges, which is the same thing a bundle
 * that predates them both does, and neither costs the recording anything else.
 *
 * A builder that throws costs this flow its causal edges and nothing else. It
 * runs inside the ingestion transaction, so letting the throw escape would roll
 * back the components, the endpoints and the state of a recording that had
 * those to give, over a link it could not work out.
 */
function ingestCausal(flowJson, steps, resolveComponent, flowId, now) {
  if (typeof core.buildCausalGraph !== 'function' || typeof core.parseEventRef !== 'function') return;

  let graph;
  try {
    graph = core.buildCausalGraph(flowJson);
  } catch {
    return;
  }
  const links = graph?.links;
  if (!Array.isArray(links) || !links.length) return;

  const positions = causalPositions(graph.events);

  /*
   * One recording is one observation of an edge, however many of its links
   * project onto it.
   *
   * The projection is many-to-one by construction: every delta of one store
   * lands on that store's node, so a response echoed into two keys of one store
   * is two links and one fact — that endpoint's body reached that store, seen
   * once. Counting it twice would put a number in `frequency` that no reader
   * can arrive at from the recordings, and it is the same double-count
   * `ingestState` keeps its own `drawn` set to avoid.
   *
   * Keyed on the whole edge identity, basis and confidence included, because
   * that is what `upsertEdge` keys on: a `named` link and a `followed` one
   * between the same two nodes are two claims and two rows, and each is still
   * entitled to its own single observation.
   */
  const drawn = new Set();

  for (const link of links) {
    const type = causalType(link?.basis, link?.confidence);
    if (!type) continue;

    const cause = causalNode(link.from, flowJson, steps, positions, resolveComponent);
    const effect = causalNode(link.to, flowJson, steps, positions, resolveComponent);
    if (!cause || !effect) continue;
    // Two events of one recording that project onto one node — two calls to the
    // same endpoint pattern, two deltas on one store. Whatever caused what, it
    // was not this node causing itself.
    if (cause.type === effect.type && cause.id === effect.id) continue;
    /*
     * The one pair this graph already draws, from the same fact.
     *
     * A component and an endpoint can only be linked by an `attributed` step →
     * network link, and `attributed` is the recorder having filed the call
     * under the open step — which is exactly what the `calls` edge above is
     * built from, owner and all. Writing it again under a second name is one
     * observation counted twice, and a reader adding the two frequencies gets a
     * number the application never did.
     */
    if (
      (cause.type === 'component' && effect.type === 'api_endpoint') ||
      (cause.type === 'api_endpoint' && effect.type === 'component')
    ) continue;

    const key = `${type}|${effect.type}|${effect.id}|${cause.type}|${cause.id}`;
    if (drawn.has(key)) continue;
    drawn.add(key);

    upsertEdge(type, effect.type, effect.id, cause.type, cause.id, flowId, now);
  }
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
 * Full component node with the structural edges that touch it.
 *
 * The id is followed through the aliases first, so an id read out of a saved
 * flow, or out of an answer given before a merge, still lands on the row that
 * holds the observations it was asking about.
 *
 * `caused_by` is not in this list, and `getCausalEdges` is where it lives. Every
 * other type here is one row per relation — a component maps to a file, calls
 * an endpoint, subscribes to a store — while a causal edge is one row per
 * *kind of evidence*, so a component with three sorts of evidence for one store
 * would put three rows into a list whose readers are counting relations. The
 * same argument the other way round is why they are keyed that way: see the
 * header. A reader who wants them asks for them and gets the basis and the
 * confidence named, rather than a type string to take apart.
 */
export function getComponent(id) {
  if (!db) return null;
  const target = canonicalId(id);
  const comp = sql('SELECT * FROM arkg_components WHERE id = ?').get(target);
  if (!comp) return null;
  const edges = sql(`
    SELECT * FROM arkg_edges
    WHERE ((from_node_type = 'component' AND from_node_id = ?)
       OR (to_node_type = 'component' AND to_node_id = ?))
      AND type NOT LIKE '${CAUSAL_PREFIX}%'
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
 * The state keys observed since sinceMs, busiest first.
 *
 * Ordered by `change_count` rather than `frequency` because the question a
 * state key is asked is which parts of the store actually move: a key present
 * in every recording and never written is the least interesting row in the
 * table, and `frequency` alone would put it at the top.
 *
 * `storeId` is here so a caller holding a `subscribes_to` edge — which points
 * at a store, because that is the granularity a subscriber was observed at —
 * can find the keys of the store it points at without a second lookup.
 */
export function getStateKeys(sinceMs = 0) {
  if (!db) return [];
  return sql(`
    SELECT * FROM arkg_state_keys WHERE last_observed_at >= ?
    ORDER BY change_count DESC, frequency DESC, key_name ASC
  `).all(sinceMs).map((row) => ({
    id: row.id,
    key: row.key_name,
    storeId: row.store_id,
    storeKind: row.store_kind,
    storeLabel: row.store_label,
    frequency: row.frequency,
    changeCount: row.change_count,
    lastObservedAt: row.last_observed_at,
  }));
}

/**
 * The causal edges touching one node, in both directions.
 *
 * `cause` and `effect` are named rather than left as `from` and `to` because
 * the row stores the effect first — the type reads as a sentence — and a
 * reader who guesses that wrong has the answer exactly backwards. `basis` and
 * `confidence` come back off the type they are keyed by, so a `named` link and
 * a `followed` one between the same pair are two rows here and never one.
 *
 * A component id is followed through the aliases, as everywhere else; the other
 * node types have no aliases to follow.
 */
export function getCausalEdges(nodeType, nodeId) {
  if (!db) return [];
  const target = nodeType === 'component' ? canonicalId(nodeId) : nodeId;

  return sql(`
    SELECT * FROM arkg_edges
    WHERE type LIKE '${CAUSAL_PREFIX}%'
      AND ((from_node_type = ? AND from_node_id = ?) OR (to_node_type = ? AND to_node_id = ?))
    ORDER BY frequency DESC, last_observed_at DESC
  `).all(nodeType, target, nodeType, target).map((row) => {
    const [, basis, confidence] = row.type.split(':');
    return {
      effect: { type: row.from_node_type, id: row.from_node_id },
      cause: { type: row.to_node_type, id: row.to_node_id },
      basis,
      confidence,
      frequency: row.frequency,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at,
    };
  });
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

/** Nothing is judged until it has been observed this many times. */
const MIN_OBSERVATIONS = 30;

/** How far outside its own window a value has to sit before it is reported. */
const SIGMA_THRESHOLD = 2;

/**
 * The fixed failure rates, and the reason they are still fixed.
 *
 * These are thresholds and the answer says so. The graph keeps one rolling
 * failure rate per entity — `updateFailureRate` folds each observation into the
 * previous number — which is a scalar, and a scalar has no spread to be two
 * standard deviations outside of. Presenting a constant as a baseline would be
 * the more dishonest of the two available mistakes.
 */
const FAILURE_THRESHOLD = { component: 0.1, api_endpoint: 0.05 };

/**
 * Mean, σ and p95 of one entity's own timing window, or null when it has none.
 *
 * The window is the entity's recent history — see `updateTimingStats` — and it
 * is the only distribution in this database. p95 is recomputed from it rather
 * than read off `timing_p95_ms` so that the sentence a reader is handed is
 * internally consistent: one window, one mean, one σ, one p95 taken from the
 * same numbers.
 */
function timingBaseline(samplesJson) {
  let samples = [];
  if (samplesJson) {
    try {
      const parsed = JSON.parse(samplesJson);
      if (Array.isArray(parsed)) samples = parsed.filter((n) => typeof n === 'number' && Number.isFinite(n));
    } catch { /* corrupt — no baseline, rather than a baseline of nothing */ }
  }
  if (samples.length < MIN_OBSERVATIONS) return null;

  const mean = samples.reduce((total, n) => total + n, 0) / samples.length;
  const variance = samples.reduce((total, n) => total + (n - mean) ** 2, 0) / samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: samples.length, mean, sigma: Math.sqrt(variance), p95: computePercentile(sorted, 0.95) };
}

/**
 * The timing anomaly for one entity, or null.
 *
 * A σ of zero is the whole reason this returns null rather than dividing: the
 * entity did the identical thing on every observation, so there is no width to
 * be outside of and nothing has moved. Dividing would report every steady node
 * in the graph at infinite deviation, which is the loudest possible way to say
 * nothing happened.
 */
function timingAnomaly(entity, samplesJson) {
  const base = timingBaseline(samplesJson);
  if (!base || base.sigma === 0 || base.p95 === null) return null;

  const deviation = (base.p95 - base.mean) / base.sigma;
  if (deviation <= SIGMA_THRESHOLD) return null;

  return {
    ...entity,
    issue: 'timing_spike',
    basis: 'baseline',
    value: base.p95,
    detail:
      `p95=${base.p95.toFixed(0)}ms is ${deviation.toFixed(1)}σ above its own baseline ` +
      `(mean=${base.mean.toFixed(0)}ms, σ=${base.sigma.toFixed(0)}ms over ${base.n} recent observations)`,
  };
}

function failureAnomaly(entity, rate, frequency, unit) {
  const limit = FAILURE_THRESHOLD[entity.type];
  if (!(rate > limit)) return null;
  return {
    ...entity,
    issue: 'high_failure_rate',
    basis: 'threshold',
    value: rate,
    detail:
      `${(rate * 100).toFixed(1)}% failure rate over ${frequency} ${unit}, above a fixed ` +
      `${(limit * 100).toFixed(0)}% threshold — a threshold and not a baseline, because the graph ` +
      'keeps one rolling rate per entity and no distribution of rates to take a σ of',
  };
}

/**
 * What the graph found, and what it did not yet have enough to look at.
 *
 * The two are different answers and an array cannot hold both. `examined` is
 * the entities that had `MIN_OBSERVATIONS` behind them and were judged;
 * `tooNew` is the entities that were observed inside the window and were not
 * judged at all. A caller holding `anomalies: []` reads `tooNew` to find out
 * whether it was told that nothing is wrong or that nothing is known yet.
 *
 * `examined` counts entities that were judged, not entities that had a
 * *baseline*: an entity can clear the observation bar on `frequency` and still
 * carry no timing window — nothing timed it — in which case the failure
 * threshold applied to it and the σ test had nothing to run on.
 */
export function getAnomalyReport(sinceMs = Date.now() - 24 * 60 * 60 * 1000) {
  const empty = { minObservations: MIN_OBSERVATIONS, examined: 0, tooNew: 0, anomalies: [] };
  if (!db) return empty;

  const anomalies = [];
  let examined = 0;
  let tooNew = 0;

  const partition = (table) => {
    const rows = sql(`SELECT * FROM ${table} WHERE last_observed_at >= ?`).all(sinceMs);
    const ready = rows.filter((row) => row.frequency >= MIN_OBSERVATIONS);
    examined += ready.length;
    tooNew += rows.length - ready.length;
    return ready;
  };

  for (const comp of partition('arkg_components')) {
    const entity = {
      type: 'component',
      id: comp.id,
      name: comp.display_name,
      source: comp.source_file,
    };
    const failure = failureAnomaly(entity, comp.failure_rate, comp.frequency, 'observations');
    if (failure) anomalies.push(failure);
    const timing = timingAnomaly(entity, comp.timing_samples);
    if (timing) anomalies.push(timing);
  }

  for (const ep of partition('arkg_api_endpoints')) {
    const entity = { type: 'api_endpoint', id: ep.id, name: `${ep.method} ${ep.url_pattern}` };
    const failure = failureAnomaly(entity, ep.failure_rate, ep.frequency, 'calls');
    if (failure) anomalies.push(failure);
    const timing = timingAnomaly(entity, ep.timing_samples);
    if (timing) anomalies.push(timing);
  }

  return { minObservations: MIN_OBSERVATIONS, examined, tooNew, anomalies };
}

/**
 * Components and API endpoints outside their own recent history.
 *
 * The list `getAnomalyReport` found, and the shape every existing caller reads.
 * Requires MIN_OBSERVATIONS observations of an entity before it says anything
 * about it; `getAnomalyReport` is where "found nothing" and "had nothing to
 * look at" are told apart. sinceMs defaults to the last 24h.
 */
export function getAnomalies(sinceMs = Date.now() - 24 * 60 * 60 * 1000) {
  return getAnomalyReport(sinceMs).anomalies;
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

  /*
   * The state keys are an *addition* to this answer, so they are absent from it
   * entirely until something has been observed — a graph with no state reads
   * exactly as it read before the column existed, and a caller written against
   * that shape cannot tell this changed. Eight, because the budget here is
   * <500 tokens and the twenty components and ten endpoints above already spend
   * most of it; the busiest keys are the ones a bounded summary is for, and
   * `getStateKeys` is where the rest of them live.
   */
  const topStateKeys = sql(`
    SELECT key_name, store_kind, store_label, frequency, change_count FROM arkg_state_keys
    ORDER BY change_count DESC, frequency DESC, key_name ASC LIMIT 8
  `).all();

  return {
    totalFlows,
    totalComponents,
    totalEndpoints,
    lastSeen: lastSeenAt ? new Date(lastSeenAt).toISOString().slice(0, 10) : null,
    ...(topStateKeys.length
      ? {
          topStateKeys: topStateKeys.map((k) => ({
            key: k.key_name,
            store: k.store_label ? `${k.store_kind} ${k.store_label}` : k.store_kind,
            frequency: k.frequency,
            changeCount: k.change_count,
          })),
        }
      : {}),
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
    const storeIds = ids('arkg_state_stores');
    const keyIds = ids('arkg_state_keys');

    deleteEdgesFor('component', compIds);
    deleteEdgesFor('api_endpoint', epIds);
    deleteEdgesFor('source_file', fileIds);
    deleteEdgesFor('state_store', storeIds);

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
    deleteNodes('arkg_state_stores', storeIds);
    deleteNodes('arkg_state_keys', keyIds);

    sql('DELETE FROM arkg_named_flows WHERE last_observed_at < ?').run(cutoff);

    // The count is components and endpoints, as it has always been: it is
    // reported to a reader as how much of the graph went stale, and adding two
    // node types to it would move a number nobody changed the retention of.
    return compIds.length + epIds.length;
  })();
}
