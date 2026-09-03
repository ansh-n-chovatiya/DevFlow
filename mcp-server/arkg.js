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
 * ## Which build a thing was last seen in
 *
 * `git_sha` was declared on five tables and written by nothing, and this file's
 * own header used it as the example of the defect it was complaining about. It
 * is written now, and the rule is one expression — `joinableSha` in `core/git`
 * — because a rule about a column dies the moment a sixth write site is added
 * by somebody who had not read the fifth.
 *
 * The column means **the last commit at which this node was observed with a
 * clean working tree**, and each half of that carries weight. *Last*, because
 * the COALESCE runs new-over-old, unlike the `source_file` beside it which
 * keeps what it knows. *Clean*, because a bare SHA column has no room beside it
 * to record that the tree was dirty, and a dirty tree names a build that exists
 * on no machine. The recording's own `meta.json` keeps the whole truth, dirt
 * and branch included; this keeps only what can be joined on.
 *
 * Crossed with a `changed_in` edge that is the fact worth having: a component
 * whose `git_sha` is older than the commit that last changed its file is a
 * component the graph knows about from before the change, which is exactly the
 * thing a reader must not take for current.
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

  /*
   * A commit at which DevFlow observed something — a recording that arrived, or
   * a component somebody picked — and the only node here that is not itself an
   * observation of a running application.
   *
   * One is filed whenever a git_sha is written anywhere, and never otherwise,
   * so every git_sha in this database has a row here to point at. That is what
   * makes the cross worth doing: without the commit node there is nothing for a
   * changed_in edge to land on and the column is a bare hash again.
   *
   * It carries no timing_p50_ms, timing_p95_ms or failure_rate: nothing times a
   * commit and nothing fails one, so those would be three more columns that are
   * always NULL, which is the defect the git_sha columns were the example of.
   * The same argument as arkg_state_keys, for the same reason.
   *
   * It carries no frequency either, and that one is worth a sentence because
   * the count is genuinely wanted — how many recordings were made at this
   * commit. It is a join away: every flow node has a git_sha, so counting them
   * answers exactly, while a counter here would have to decide whether pressing
   * Send twice on one recording is two recordings and would drift from the join
   * the first time it decided wrong. Left as a hop, because that is what it is.
   */
  CREATE TABLE IF NOT EXISTS arkg_git_commits (
    id TEXT PRIMARY KEY,
    short_sha TEXT NOT NULL,
    subject TEXT NOT NULL,
    author TEXT,
    committed_at INTEGER NOT NULL,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL
  );

  /*
   * A service the backend's own tracer named, and another node here that is
   * deliberately neither timed nor failed.
   *
   * service.name is chosen by whoever deployed the thing and is the same
   * string in next month's recording, which is the whole reason it is a node: a
   * span id is 64 random bits that happen once, so a node per span would make
   * this a log rather than an accumulation. See core/otel's header.
   *
   * It carries no timing_p50_ms, timing_p95_ms or failure_rate, on the same
   * argument as arkg_git_commits and arkg_state_keys: nothing *runs* a service.
   * A percentile here would be over whatever mix of its operations happened to
   * be recorded — a service whose health check is called a thousand times looks
   * fast because of the health check — and a failure rate would move when that
   * mix changed rather than when anything failed. Both numbers are real one hop
   * away, on arkg_operations, where a row is a thing that actually ran.
   *
   * version and environment are last-observed values and not identity. A
   * service redeployed at 2.4.2 is the same service; keying them in would file
   * a fresh node per release and reset every count that makes this a graph.
   */
  CREATE TABLE IF NOT EXISTS arkg_services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT,
    environment TEXT,
    git_sha TEXT,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 1
  );

  /*
   * One operation of one service — checkout-api / GET /api/v1/invoices.
   *
   * This one *is* timed and *does* fail, because unlike the service above it a
   * row here is a unit of work: every span carrying this name measured the same
   * thing, so a percentile over them answers a question, and a status of ERROR
   * on one is that unit failing. It is the backend's half of what
   * arkg_api_endpoints is for the browser's, and it is deliberately shaped the
   * same so that a reader crossing the two is comparing like with like.
   *
   * name is operationName's answer and never the raw span name: an
   * instrumentation that put an invoice id in the name would otherwise file a
   * node per invoice, which is the hazard arkg_api_endpoints already solved.
   *
   * service_name sits beside service_id for arkg_state_keys' reason — the
   * name is what a caller asks with and what an answer has to print, and a join
   * for it on every read buys nothing that the denormalised column does not.
   */
  CREATE TABLE IF NOT EXISTS arkg_operations (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    service_name TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT,
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

  /*
   * Which facts of one recording's trace have already been counted for it.
   *
   * frequency counts recordings everywhere in this file, and a trace breaks
   * the assumption every other ingest gets to make — that a recording arrives
   * once, whole. Spans arrive leaf-first in as many deliveries as the exporter
   * felt like sending, and the join re-runs on each one, so a single recording's
   * trace is projected and handed here several times over with more of the tree
   * in it each time. ingestFlow's content hash cannot decide that: every
   * delivery genuinely *is* new evidence, and the spans it repeats genuinely are
   * not, and one hash over the payload has to call the pair the same thing.
   *
   * So the ledger is per fact rather than per payload. A service, an operation
   * or an edge is counted the first time this recording shows it and never
   * again, whichever delivery it turned up in — which is also what makes
   * re-sending a recording free, the same way the content hash makes it free
   * for everything else.
   *
   * It holds no observations of its own and answers no question: it is
   * bookkeeping, and it is a table rather than a column because the thing being
   * remembered is a set whose size is the size of the trace.
   */
  CREATE TABLE IF NOT EXISTS arkg_trace_observations (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL
  );

  /*
   * A production issue somebody else's users hit, and the one table here whose
   * counts are not DevFlow's own observations.
   *
   * Its own table rather than columns on arkg_source_files, and that is the
   * whole of the design. "frequency" everywhere else in this database counts
   * *recordings DevFlow made*; "event_count" here counts *events a provider saw
   * in production*. Adding a production number into an observation column would
   * silently change what every existing figure means, and nothing downstream
   * would notice: getAnomalies would start reading a mixture, and the baseline
   * it computes would be over two different units.
   *
   * Keyed on the provider's own issue id because that is the only identifier in
   * a crash payload that is stable across deliveries -- the same requirement
   * caused_by and changed_in are held to. An event id happens once; an issue id
   * is the same string next week, which is what makes this a node rather than a
   * log line.
   *
   * It carries no timing_p50_ms, timing_p95_ms or failure_rate, on
   * arkg_git_commits' argument: nothing times an issue, and a failure rate over
   * a thing that is by definition a failure is not a number.
   */
  CREATE TABLE IF NOT EXISTS arkg_production_errors (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    error_type TEXT NOT NULL,
    culprit TEXT,
    level TEXT,
    event_count INTEGER NOT NULL DEFAULT 1,
    url TEXT,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL
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
  CREATE INDEX IF NOT EXISTS idx_arkg_git_commits_last ON arkg_git_commits(last_observed_at);
  CREATE INDEX IF NOT EXISTS idx_arkg_services_last ON arkg_services(last_observed_at);
  CREATE INDEX IF NOT EXISTS idx_arkg_operations_service ON arkg_operations(service_id);
  CREATE INDEX IF NOT EXISTS idx_arkg_operations_name ON arkg_operations(service_name);
  CREATE INDEX IF NOT EXISTS idx_arkg_operations_last ON arkg_operations(last_observed_at);
  CREATE INDEX IF NOT EXISTS idx_arkg_trace_observations_flow ON arkg_trace_observations(flow_id);
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
 * Stable ids for the two things a backend trace projects onto.
 *
 * Keyed on the names and on nothing else, for `stateStoreId`'s reason said
 * about a different ephemeral id: a span id is 64 random bits, is never seen
 * twice, and a node keyed on one would be a row per request that no second
 * recording could ever accumulate onto. What survives is the name whoever
 * deployed the service chose, and the operation name their instrumentation
 * chose — already through `core/otel`'s `operationName` by the time it reaches
 * here, so the record-shaped segments are collapsed and two requests for two
 * invoices are one operation observed twice.
 */
function serviceId(name) {
  return crypto.createHash('sha256').update(`service|${name}`).digest('hex').slice(0, 16);
}

function operationId(service, name) {
  return crypto
    .createHash('sha256')
    .update(`operation|${service}|${name}`)
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
/**
 * Which of two merged rows' commits the survivor keeps.
 *
 * `git_sha` means *the last commit at which this row was observed with a clean
 * tree*, so a merge has to keep the later of the two rather than the winner's —
 * and "later" is decidable here without asking git, because every `git_sha` in
 * this database has an `arkg_git_commits` row and that row carries the commit
 * date. That is the second thing the commit node is for.
 *
 * A SHA with no node is one written by a version of this file that did not file
 * them; it loses to a SHA that can be dated, and wins against nothing. Two
 * undated SHAs keep the survivor's, and that tie-break is arbitrary rather than
 * a decision — with no dates there is no fact preferring either, so it is
 * deliberately not asserted anywhere. A test over it would be a test of this
 * line rather than of anything true.
 */
function laterCommit(a, b) {
  if (!a || a === b) return b ?? a ?? null;
  if (!b) return a;

  const at = (sha) =>
    sql('SELECT committed_at FROM arkg_git_commits WHERE id = ?').get(sha)?.committed_at ?? null;
  const [whenA, whenB] = [at(a), at(b)];
  if (whenA === null) return whenB === null ? a : b;
  if (whenB === null) return a;
  return whenB > whenA ? b : a;
}

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
      id_source = ?,
      git_sha = ?
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
    laterCommit(winner.git_sha, loser.git_sha),
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
 *
 * Returns whether the ingest was new evidence, so the caller can decide whether
 * to file the commit node beside it. Every `git_sha` this file writes has a
 * `arkg_git_commits` row to point at, and that invariant only holds if the two
 * writes are gated on one answer.
 */
export function ingestFlow(flowJson, git = null) {
  if (!db) return;

  const now = Date.now();
  /*
   * The commit every node and edge this ingest touches is stamped with, or
   * null.
   *
   * `joinableSha` is the whole of the rule and it lives in `core/git`: a
   * `git_sha` column is a join key with no room beside it to say "but the
   * working tree was dirty", so a dirty observation writes nothing and the
   * column means *the last commit at which this was observed with a clean
   * tree*. The flow's own `meta.json` keeps the whole truth, dirt included;
   * this keeps only what can be joined on.
   */
  const gitSha = core.joinableSha?.(git) ?? null;
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

  return db.transaction(() => {
    // ── Named flow node ──────────────────────────────────────────────────────
    const existingFlow = sql('SELECT content_hash FROM arkg_named_flows WHERE id = ?').get(flowId);

    /*
     * Whether this ingest is new evidence about the application — decided once,
     * because it gates two different things and they have to agree.
     *
     * It gates the accumulation below, which it always did. It also gates the
     * commit stamp, and that is the correction: the flow node is refreshed on
     * every send so that a renamed recording updates, and `git_sha` rode along
     * inside that refresh — so re-sending a byte-identical recording a week
     * later relabelled the *flow* with today's commit while every component and
     * source file in it kept the commit it was actually recorded at. The two
     * columns then disagreed about one observation, and the disagreement landed
     * exactly on the cross the column exists for: the component read as last
     * seen *before* a change its own flow now claimed to be after.
     *
     * A re-send is not a second observation of the application — that rule
     * already governs `frequency`, `failure_rate` and `change_count`. A commit
     * stamp is evidence, not bookkeeping, so it belongs with them.
     */
    const accumulating = !existingFlow || existingFlow.content_hash !== contentHash;

    if (!existingFlow) {
      sql(`
        INSERT INTO arkg_named_flows (id, name, host, step_count, failure_count, created_at, last_observed_at, settings, content_hash, git_sha)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        gitSha,
      );
    } else {
      sql(`
        UPDATE arkg_named_flows SET name = ?, host = ?, last_observed_at = ?, failure_count = ?, step_count = ?, content_hash = ?, git_sha = COALESCE(?, git_sha) WHERE id = ?
      `).run(
        flowJson.name ?? 'Unnamed',
        host,
        now,
        failureCount,
        steps.length,
        contentHash,
        accumulating ? gitSha : null,
        flowId,
      );
    }

    // Everything below this line is accumulation, and accumulation is what a
    // second send of an unchanged recording must not do.
    if (!accumulating) return false;

    // ── Component nodes ───────────────────────────────────────────────────────
    const insertComponent = sql(`
      INSERT INTO arkg_components (id, display_name, source_file, source_line, first_observed_at, last_observed_at, frequency, id_source, git_sha)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    /*
     * `git_sha` is the one column here that takes the *new* value in
     * preference to the old, and the COALESCE is the other way round from the
     * two above it on purpose. `source_file` keeps what it knows because a
     * later observation that lost the file learned nothing; the commit keeps
     * the newer because the column's whole meaning is *last* observed clean.
     */
    const updateComponent = sql(`
      UPDATE arkg_components SET
        last_observed_at = ?,
        frequency = frequency + 1,
        source_file = COALESCE(source_file, ?),
        source_line = COALESCE(source_line, ?),
        git_sha = COALESCE(?, git_sha)
      WHERE id = ?
    `);
    const selectSourceFile = sql('SELECT id FROM arkg_source_files WHERE id = ?');
    const insertSourceFile = sql(`
      INSERT INTO arkg_source_files (id, path, first_observed_at, last_observed_at, git_sha)
      VALUES (?, ?, ?, ?, ?)
    `);
    const updateSourceFile = sql(
      'UPDATE arkg_source_files SET last_observed_at = ?, frequency = frequency + 1, git_sha = COALESCE(?, git_sha) WHERE id = ?',
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
        updateComponent.run(now, sourceFile, sourceLine, gitSha, nodeId);
      } else {
        const adopted = resolveFlowComponent(name, sourceFile);
        if (adopted) {
          // The extension has now named this component, so the row stops being
          // adoptable by anything else.
          nodeId = adopted.id;
          recordAlias(compId, nodeId, now);
          updateComponent.run(now, sourceFile, sourceLine, gitSha, nodeId);
          sql('UPDATE arkg_components SET id_source = ? WHERE id = ?').run(ANCHORED, nodeId);
        } else {
          nodeId = compId;
          insertComponent.run(compId, name, sourceFile, sourceLine, now, now, ANCHORED, gitSha);
        }
      }

      nodeId = reconcileIdentity(nodeId, now);
      nodeFor.set(compId, nodeId);

      // maps_to edge: component -> source file
      if (sourceFile) {
        if (!selectSourceFile.get(sourceFile)) {
          insertSourceFile.run(sourceFile, sourceFile, now, now, gitSha);
        } else {
          updateSourceFile.run(now, gitSha, sourceFile);
        }
        upsertEdge('maps_to', 'component', nodeId, 'source_file', sourceFile, flowId, now, null, false, gitSha);
      }
    }

    /** A component id as it arrived in the flow, as the row it stands for now. */
    const resolvedNode = (id) => nodeFor.get(id) ?? canonicalId(id);

    // ── API endpoint nodes from network calls ─────────────────────────────────
    const selectEndpoint = sql('SELECT * FROM arkg_api_endpoints WHERE id = ?');
    const insertEndpoint = sql(`
      INSERT INTO arkg_api_endpoints (id, method, url_pattern, first_observed_at, last_observed_at, frequency, timing_p50_ms, timing_p95_ms, timing_samples, failure_rate, git_sha)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `);
    const updateEndpoint = sql(`
      UPDATE arkg_api_endpoints SET
        last_observed_at = ?,
        frequency = frequency + 1,
        timing_p50_ms = ?,
        timing_p95_ms = ?,
        timing_samples = ?,
        failure_rate = ?,
        git_sha = COALESCE(?, git_sha)
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
            failed ? 1.0 : 0.0, gitSha);
        } else {
          const ts = durationMs !== null
            ? updateTimingStats(existing.timing_samples, durationMs)
            : { samples: existing.timing_samples, p50: existing.timing_p50_ms, p95: existing.timing_p95_ms };
          const newRate = updateFailureRate(existing.failure_rate, existing.frequency + 1, failed);
          updateEndpoint.run(now, ts.p50, ts.p95, ts.samples, newRate, gitSha, epId);
        }

        // calls edge: component -> api_endpoint (when component is known)
        if (owner && components[owner]) {
          upsertEdge('calls', 'component', resolvedNode(owner), 'api_endpoint', epId, flowId, now, durationMs, failed, gitSha);
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
        if (from !== to) upsertEdge('renders', 'component', from, 'component', to, flowId, now, null, false, gitSha);
      }
    }

    // Inside the guard above, and it has to be: `change_count` is a count of
    // steps that changed something, and a second Send of one recording is not a
    // second time the application changed anything.
    ingestState(flowJson, steps, resolvedNode, flowId, now, gitSha);

    // Inside it for the same reason. A causal edge's frequency is how many
    // recordings showed one thing following from another; a re-send of one
    // recording is not a second showing.
    ingestCausal(flowJson, steps, resolvedNode, flowId, now, gitSha);
    return true;
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
function ingestState(flowJson, steps, resolveComponent, flowId, now, gitSha = null) {
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
      upsertEdge('subscribes_to', 'component', from, 'state_store', node.id, flowId, now, null, false, gitSha);
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
function ingestCausal(flowJson, steps, resolveComponent, flowId, now, gitSha = null) {
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

    upsertEdge(type, effect.type, effect.id, cause.type, cause.id, flowId, now, null, false, gitSha);
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
export function ingestComponentPick(pick, git = null) {
  if (!db) return;

  const now = Date.now();
  // Clean trees only, for the reason `ingestFlow` gives: this column is a join
  // key with nowhere to record a caveat.
  const gitSha = core.joinableSha?.(git) ?? null;
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
        INSERT INTO arkg_components (id, display_name, source_file, source_line, first_observed_at, last_observed_at, frequency, timing_p50_ms, timing_p95_ms, timing_samples, failure_rate, id_source, git_sha)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      `).run(compId, pick.name ?? compId, sourceFile, sourceLine, now, now,
        ts.p50, ts.p95, ts.samples,
        failed ? 1.0 : 0.0,
        // Anchored only when the caller vouched for the id. Nothing on the wire
        // does, so a pick's own row stays adoptable by the flow that names it.
        pick.id ? ANCHORED : PROVISIONAL,
        gitSha);
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
          failure_rate = ?,
          git_sha = COALESCE(?, git_sha)
        WHERE id = ?
      `).run(now, sourceFile, sourceLine, ts.p50, ts.p95, ts.samples, newRate, gitSha, compId);
    }

    // A pick that has just taught the graph which file a component lives in may
    // have made it a visible twin of a row that already knew.
    reconcileIdentity(compId, now);
  })();
}

/**
 * One commit, and the source files it changed, into the graph.
 *
 * Called after `ingestFlow`, and the order is load-bearing: the flow is what
 * creates the source file nodes, and this draws no edge to a file the graph has
 * not already keyed.
 *
 * ## Both ends must land on a node the graph already keys
 *
 * That is the rule `caused_by` was built to, and it does more work here. Every
 * other edge in this file joins two things observed in one browser; this joins
 * a path git printed to a path a bundler wrote, and the two agree only after
 * `core/git`'s `matchSourceFile` has said so — exactly, or by an unambiguous
 * suffix, and never by a guess. Two files ending `src/index.ts` in a monorepo
 * is precisely where a suffix rule becomes a coin toss, and a coin toss belongs
 * in neither column of an edge. So a commit that touched forty files may draw
 * three edges, and that is the honest number: the graph has seen three of them
 * running.
 *
 * A merge commit reaches here with no files at all — see `parseLog` in
 * `core/git` — and becomes a commit node with no edges, which is true.
 */
export function ingestCommit(commit, files = [], prefix = '') {
  if (!db || !commit || !core.isSha?.(commit.sha)) return 0;

  const now = Date.now();

  return db.transaction(() => {
    const existing = sql('SELECT id FROM arkg_git_commits WHERE id = ?').get(commit.sha);
    if (!existing) {
      sql(`
        INSERT INTO arkg_git_commits (id, short_sha, subject, author, committed_at, first_observed_at, last_observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        commit.sha,
        core.shortSha(commit.sha),
        commit.subject ?? '',
        commit.author ?? null,
        commit.committedAt ?? now,
        now,
        now,
      );
    } else {
      sql('UPDATE arkg_git_commits SET last_observed_at = ? WHERE id = ?').run(now, commit.sha);
    }

    if (!files.length) return 0;

    /*
     * Read once and matched in memory. The alternative is a LIKE per changed
     * path, which is a scan per file for a join that has to consider every
     * candidate anyway — and `matchSourceFile` refuses an ambiguous suffix,
     * which means it has to see all of them to know.
     */
    const known = sql('SELECT id FROM arkg_source_files').all().map((row) => row.id);
    if (!known.length) return 0;

    let drawn = 0;
    for (const file of files) {
      const projectPath = core.projectRelative(prefix, file);
      if (!projectPath) continue;
      const node = core.matchSourceFile(known, projectPath);
      if (!node) continue;
      insertFactEdge('changed_in', 'source_file', node, 'git_commit', commit.sha, now);
      drawn += 1;
    }
    return drawn;
  })();
}

// ── Backend traces ────────────────────────────────────────────────────────────

/**
 * Whether this recording has yet been counted for one fact of its trace.
 *
 * The insert *is* the question: `INSERT OR IGNORE` under a primary key asks and
 * answers in one statement, so there is no window between a `SELECT` that found
 * nothing and the write that acts on it — which matters because two deliveries
 * of one trace can reach here back to back and the count they are racing over
 * is the one thing this whole file is for.
 *
 * See the DDL comment on `arkg_trace_observations` for why the ledger is per
 * fact rather than per payload.
 */
function firstSightingInFlow(flowId, subject, now) {
  const id = crypto.createHash('sha256').update(`${flowId}|${subject}`).digest('hex').slice(0, 16);
  return (
    sql('INSERT OR IGNORE INTO arkg_trace_observations (id, flow_id, observed_at) VALUES (?, ?, ?)')
      .run(id, flowId, now).changes > 0
  );
}

/** A run of samples folded into one timing window, through the one funnel. */
function foldSamples(existing, samples) {
  let result = null;
  let json = existing.samples;
  for (const sample of samples) {
    result = updateTimingStats(json, sample);
    json = result.samples;
  }
  return result ?? existing;
}

/** One end of a projected trace edge, as a node type and id this file keys. */
function traceEdgeEnd(end) {
  if (!end || typeof end !== 'object') return null;
  switch (end.kind) {
    /*
     * The endpoint node `ingestFlow` already made for this call, and it has to
     * be that one: the join's whole value is that a request the browser watched
     * leave and the work it caused on the far side meet on one row. A second id
     * scheme here would draw the edge to an endpoint node nothing else in the
     * graph points at, and the FE → BE chain would be two disconnected halves
     * that looked joined. `endpointId` normalises the method and the URL, so
     * the recording's spelling of them reaches the same node either way.
     */
    case 'endpoint':
      return typeof end.url === 'string'
        ? { type: 'api_endpoint', id: endpointId(String(end.method ?? 'GET'), end.url) }
        : null;
    case 'operation':
      return typeof end.service === 'string' && typeof end.name === 'string'
        ? { type: 'operation', id: operationId(end.service, end.name) }
        : null;
    case 'service':
      return typeof end.name === 'string' ? { type: 'service', id: serviceId(end.name) } : null;
    default:
      return null;
  }
}

/**
 * What one projected trace may write into the graph.
 *
 * `projection` is exactly `core/otel`'s `projectTrace` answer, and every
 * decision about *what* is admissible was made there: both ends of every edge
 * already land on a node this file keys stably, a trace nobody recorded never
 * reaches here at all, and the duplicates one trace contains are already
 * collapsed. Nothing below re-derives any of that or filters what core
 * admitted — this is the SQL and only the SQL, which is the same division
 * `ingestCausal` keeps with `buildCausalGraph`.
 *
 * **Additive and non-fatal.** A trace is an addition to a recording and the
 * recording is the thing being kept, so a throw in here is swallowed and
 * reported as nothing accumulated, exactly as `arkgTry` does for every call the
 * server makes into this file. The receiver may not be behind that funnel —
 * spans arrive on their own endpoint — so the guarantee is made here as well as
 * there rather than assumed of a caller.
 *
 * `gitSha` is the *joinable* sha and not a raw HEAD: `joinableSha`'s rule is
 * that a dirty tree writes nothing, because the column is a join key with no
 * room beside it to record a caveat. A caller holding the checkout itself may
 * pass that instead and the rule is applied here, so there is exactly one place
 * a dirty tree becomes no sha however the caller reached it. Nothing files a
 * commit node from here: the sha is the recording's, and `ingestFlow` returning
 * true is what already filed the row it points at.
 *
 * Returns how many services, operations and edges this call was new evidence
 * for, which is what a receiver logging "joined 4 spans, counted 2" needs.
 */
export function ingestTrace(projection, flowId, gitSha = null, now = Date.now()) {
  const nothing = { services: 0, operations: 0, edges: 0 };
  // A projection with no recording to attribute it to cannot be deduplicated,
  // and an observation that can be counted twice is worse than one not counted.
  if (!db || !projection || typeof flowId !== 'string' || !flowId) return nothing;

  const sha = typeof gitSha === 'string' ? gitSha : (core.joinableSha?.(gitSha) ?? null);
  const services = Array.isArray(projection.services) ? projection.services : [];
  const operations = Array.isArray(projection.operations) ? projection.operations : [];
  const edges = Array.isArray(projection.edges) ? projection.edges : [];
  if (!services.length && !operations.length && !edges.length) return nothing;

  /*
   * Every span of one operation in this trace, folded into one observation of
   * it — and the two halves of that fold are counted in different units on
   * purpose.
   *
   * `frequency` counts *recordings*, as it does everywhere here: a handler that
   * ran forty times inside one request is one thing this recording showed, and
   * counting it forty times would put a number in the column that no reader can
   * arrive at from the recordings they have. The failure verdict is per
   * recording for the same reason — did this operation fail in this recording —
   * so one ERROR span is a yes and the rolling rate stays a fraction of
   * recordings, which is what `updateFailureRate` is being handed a frequency
   * for.
   *
   * The timing window is not counted in recordings, because it is not a count:
   * it is the distribution `getAnomalies` asks whether a number sits outside
   * of, and every one of those forty spans measured that distribution once. The
   * alternative is to reduce them to a representative — a mean, a max — and
   * write that, which is a number the application never produced sitting in a
   * window of numbers it did.
   */
  const sightings = new Map();
  for (const op of operations) {
    if (!op || typeof op.service !== 'string' || typeof op.name !== 'string') continue;
    const id = operationId(op.service, op.name);
    const seen = sightings.get(id) ?? {
      id,
      service: op.service,
      name: op.name,
      // 'unspecified' is the reader's answer for a span that carried no kind at
      // all, so it is not allowed to overwrite a kind another span supplied.
      kind: null,
      samples: [],
      failed: false,
      file: null,
      line: null,
    };
    if (typeof op.durationMs === 'number' && Number.isFinite(op.durationMs)) {
      seen.samples.push(op.durationMs);
    }
    if (op.failed === true) seen.failed = true;
    if (seen.kind === null && typeof op.kind === 'string' && op.kind !== 'unspecified') {
      seen.kind = op.kind;
    }
    // The line is taken from whichever span supplied the file, never crossed
    // from another one: a path from one span and a line from a different one is
    // a source location nobody observed.
    if (seen.file === null && typeof op.file === 'string' && op.file) {
      seen.file = op.file;
      seen.line = typeof op.line === 'number' ? op.line : null;
    }
    sightings.set(id, seen);
  }

  try {
    return db.transaction(() => {
      let newServices = 0;
      let newOperations = 0;
      let newEdges = 0;

      for (const service of services) {
        if (!service || typeof service.name !== 'string') continue;
        if (!firstSightingInFlow(flowId, `service|${service.name}`, now)) continue;
        upsertService(service, sha, now);
        newServices += 1;
      }

      for (const op of sightings.values()) {
        if (!firstSightingInFlow(flowId, `operation|${op.id}`, now)) continue;
        upsertOperation(op, sha, now);
        newOperations += 1;
      }

      for (const edge of edges) {
        if (!edge || typeof edge.type !== 'string') continue;
        const from = traceEdgeEnd(edge.from);
        const to = traceEdgeEnd(edge.to);
        if (!from || !to) continue;
        const subject = `edge|${edge.type}|${from.type}|${from.id}|${to.type}|${to.id}`;
        if (!firstSightingInFlow(flowId, subject, now)) continue;
        /*
         * No timing on a trace edge, and that is the honest shape rather than a
         * gap. A `calls` edge from a component carries one because it was built
         * from one network call with one duration; these are built from a set of
         * spans, and the operation's latency already lives on its node with
         * every span of it folded in. The failure verdict does travel, because
         * the callee either failed in this recording or it did not, and that is
         * the same single fact whichever edge reached it.
         */
        const failed = to.type === 'operation' && (sightings.get(to.id)?.failed ?? false);
        upsertEdge(edge.type, from.type, from.id, to.type, to.id, flowId, now, null, failed, sha);
        newEdges += 1;
      }

      return { services: newServices, operations: newOperations, edges: newEdges };
    })();
  } catch {
    // Swallowed for the reason in the doc comment above: the graph is an
    // addition to a recording and may never cost one. The transaction rolls
    // back, so a half-written trace is not left behind either.
    return nothing;
  }
}

/**
 * One service node, created or observed again.
 *
 * `version` and `environment` take the new value in preference to the old, the
 * way `git_sha` does and unlike the `source_file` beside it: a service that has
 * been redeployed is at the new version, and the column means what it was last
 * seen running. A COALESCE the other way would pin a node to the first release
 * anybody happened to record.
 */
function upsertService(service, gitSha, now) {
  const id = serviceId(service.name);
  const version = typeof service.version === 'string' ? service.version : null;
  const environment = typeof service.environment === 'string' ? service.environment : null;

  const existing = sql('SELECT id FROM arkg_services WHERE id = ?').get(id);
  if (!existing) {
    sql(`
      INSERT INTO arkg_services (id, name, version, environment, git_sha, first_observed_at, last_observed_at, frequency)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, service.name, version, environment, gitSha, now, now);
  } else {
    sql(`
      UPDATE arkg_services SET
        last_observed_at = ?,
        frequency = frequency + 1,
        version = COALESCE(?, version),
        environment = COALESCE(?, environment),
        git_sha = COALESCE(?, git_sha)
      WHERE id = ?
    `).run(now, version, environment, gitSha, id);
  }
  return id;
}

/**
 * One operation node, created or observed again.
 *
 * Shaped exactly like the endpoint upsert above it, down to the COALESCE
 * directions: `source_file` and `source_line` keep what they know, because an
 * instrumentation that stopped reporting `code.filepath` taught the graph
 * nothing; `git_sha` takes the newer, because the column means *last* observed
 * clean.
 */
function upsertOperation(op, gitSha, now) {
  const existing = sql('SELECT * FROM arkg_operations WHERE id = ?').get(op.id);

  if (!existing) {
    const ts = foldSamples({ samples: null, p50: null, p95: null }, op.samples);
    sql(`
      INSERT INTO arkg_operations (id, service_id, service_name, name, kind, source_file, source_line, git_sha, first_observed_at, last_observed_at, frequency, timing_p50_ms, timing_p95_ms, timing_samples, failure_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      op.id, serviceId(op.service), op.service, op.name, op.kind, op.file, op.line, gitSha,
      now, now, ts.p50, ts.p95, ts.samples, op.failed ? 1.0 : 0.0,
    );
    return;
  }

  const ts = foldSamples(
    { samples: existing.timing_samples, p50: existing.timing_p50_ms, p95: existing.timing_p95_ms },
    op.samples,
  );
  const newRate = updateFailureRate(existing.failure_rate, existing.frequency + 1, op.failed);
  sql(`
    UPDATE arkg_operations SET
      last_observed_at = ?,
      frequency = frequency + 1,
      kind = COALESCE(kind, ?),
      source_file = COALESCE(source_file, ?),
      source_line = COALESCE(source_line, ?),
      timing_p50_ms = ?,
      timing_p95_ms = ?,
      timing_samples = ?,
      failure_rate = ?,
      git_sha = COALESCE(?, git_sha)
    WHERE id = ?
  `).run(now, op.kind, op.file, op.line, ts.p50, ts.p95, ts.samples, newRate, gitSha, op.id);
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
function upsertEdge(type, fromType, fromId, toType, toId, flowId, now, timingMs = null, failed = false, gitSha = null) {
  const existing = sql(
    'SELECT * FROM arkg_edges WHERE type = ? AND from_node_type = ? AND from_node_id = ? AND to_node_type = ? AND to_node_id = ?',
  ).get(type, fromType, fromId, toType, toId);

  if (!existing) {
    const ts = timingMs !== null
      ? updateTimingStats(null, timingMs)
      : { samples: null, p50: null, p95: null };
    sql(`
      INSERT INTO arkg_edges (type, from_node_type, from_node_id, to_node_type, to_node_id, flow_id, timing_p50_ms, timing_p95_ms, timing_samples, frequency, failure_rate, first_observed_at, last_observed_at, git_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(type, fromType, fromId, toType, toId, flowId,
      ts.p50, ts.p95, ts.samples,
      failed ? 1.0 : 0.0, now, now, gitSha);
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
        failure_rate = ?,
        git_sha = COALESCE(?, git_sha)
      WHERE id = ?
    `).run(now, ts.p50, ts.p95, ts.samples, newRate, gitSha, existing.id);
  }
}

/**
 * A `changed_in` edge: a source file was touched by a commit.
 *
 * Written by a different function from every other edge because it is a
 * different kind of claim. Every other edge here is an *observation of a
 * running application* — this component called that endpoint, and `frequency`
 * counts the recordings that showed it. A commit changed a file once, in 2023,
 * and will not do it again: incrementing a frequency on the second recording
 * made at that commit would be counting how often somebody pressed Record and
 * filing it as a fact about the repository.
 *
 * So an existing row is left exactly as it is, and re-ingesting is how a file
 * the graph only learned about later gets its edge at all.
 */
function insertFactEdge(type, fromType, fromId, toType, toId, now) {
  sql(`
    INSERT INTO arkg_edges (type, from_node_type, from_node_id, to_node_type, to_node_id, frequency, failure_rate, first_observed_at, last_observed_at)
    SELECT ?, ?, ?, ?, ?, 1, 0, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM arkg_edges WHERE type = ? AND from_node_type = ? AND from_node_id = ? AND to_node_type = ? AND to_node_id = ?
    )
  `).run(type, fromType, fromId, toType, toId, now, now, type, fromType, fromId, toType, toId);
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
/**
 * One commit node, or null.
 *
 * The graph holds a commit only because a recording or a pick arrived while it
 * was checked out, so this answers a narrower question than `git cat-file`:
 * *was DevFlow running at this commit?* That is exactly what the forensics
 * walk needs it for — a component's `git_sha` names a sighting, and the
 * sighting's date is what every candidate is measured against. When the
 * sighting predates the walk's window this is the only place its date exists.
 */
export function getCommit(sha) {
  if (!db || !core.isSha?.(sha)) return null;
  return sql('SELECT * FROM arkg_git_commits WHERE id = ?').get(sha) ?? null;
}

/**
 * One source file node, or null.
 *
 * It carries a `git_sha` on the same terms every other node does — the last
 * commit it was observed at with a clean tree — so a file asked about directly
 * anchors the same way a component does, rather than being the one subject the
 * walk cannot divide.
 */
export function getSourceFile(id) {
  if (!db || typeof id !== 'string') return null;
  return sql('SELECT * FROM arkg_source_files WHERE id = ?').get(id) ?? null;
}

/** Every commit node the graph holds, as a set of SHAs, for marking a walk. */
export function getCommitShas() {
  if (!db) return new Set();
  return new Set(sql('SELECT id FROM arkg_git_commits').all().map((row) => row.id));
}

/**
 * One production issue and the source files its stack actually reaches.
 *
 * The edge is `errored_in`, from the issue to a source file, and it is drawn
 * under `changed_in`'s rule exactly: **both ends must land on a node the graph
 * already keys stably**, so a frame is joined only through `matchSourceFile` —
 * after normalisation, or by a suffix exactly one known file answers, and never
 * by a guess. A production stack in a minified build names chunk paths that
 * match nothing here, and drawing an edge on a near-miss would file somebody
 * else's crash against a file nobody has evidence for.
 *
 * So a ten-frame stack may draw one edge, or none, and none is a real answer:
 * it means this graph has never watched code run in any file that crash
 * touched. `insertFactEdge` rather than `upsertEdge`, on `changed_in`'s
 * argument — an issue reached a file or it did not, and a second delivery of
 * the same issue is not a second fact about the repository.
 *
 * The count is `MAX`ed rather than added. A provider re-delivers the same issue
 * with a cumulative total, so summing would multiply it by however many times a
 * relay fired.
 */
export function ingestProductionError(error) {
  if (!db || !error || typeof error.id !== 'string' || !error.id) return 0;

  const now = Date.now();

  return db.transaction(() => {
    const existing = sql('SELECT event_count FROM arkg_production_errors WHERE id = ?').get(error.id);
    if (existing) {
      sql(`
        UPDATE arkg_production_errors
           SET event_count = MAX(event_count, ?),
               culprit = COALESCE(?, culprit),
               level = COALESCE(?, level),
               url = COALESCE(?, url),
               last_seen_at = MAX(COALESCE(last_seen_at, 0), COALESCE(?, 0)),
               last_observed_at = ?
         WHERE id = ?
      `).run(
        error.count ?? 1,
        error.culprit ?? null,
        error.level ?? null,
        error.url ?? null,
        error.lastSeenMs ?? null,
        now,
        error.id,
      );
    } else {
      sql(`
        INSERT INTO arkg_production_errors
          (id, provider, error_type, culprit, level, event_count, url,
           first_seen_at, last_seen_at, first_observed_at, last_observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        error.id,
        error.provider ?? 'unknown',
        error.type ?? 'Error',
        error.culprit ?? null,
        error.level ?? null,
        error.count ?? 1,
        error.url ?? null,
        error.firstSeenMs ?? null,
        error.lastSeenMs ?? null,
        now,
        now,
      );
    }

    const known = sql('SELECT id FROM arkg_source_files').all().map((row) => row.id);
    if (!known.length) return 0;

    let drawn = 0;
    const seen = new Set();
    for (const frame of error.frames ?? []) {
      if (!frame || typeof frame.filename !== 'string') continue;
      const node = core.matchSourceFile(known, frame.filename);
      if (!node || seen.has(node)) continue;
      seen.add(node);
      insertFactEdge('errored_in', 'production_error', error.id, 'source_file', node, now);
      drawn += 1;
    }
    return drawn;
  })();
}

/**
 * The production issues whose stacks reach one source file.
 *
 * Read where somebody is about to change that file, which is the only moment
 * this is worth anything: a crash in production and a file you are editing are
 * the same question asked from two ends.
 */
export function getProductionErrors(sourceFile, limit = 10) {
  if (!db) return [];
  return sql(`
    SELECT e.* FROM arkg_production_errors e
    INNER JOIN arkg_edges g
       ON g.from_node_id = e.id AND g.type = 'errored_in' AND g.to_node_id = ?
    ORDER BY e.event_count DESC
    LIMIT ?
  `).all(sourceFile, Math.max(1, Math.trunc(limit)));
}

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
 * Every source file the graph has observed, and the components seen in each.
 *
 * The candidate set `compare_flows_across_deploys` crosses a commit range
 * against, and the reason that tool can say something `git log --name-only`
 * cannot: these are the files DevFlow has actually watched code run in, pooled
 * across every recording and every pick rather than only the two being
 * compared.
 *
 * A file with an empty list is a real entry and not a gap — a source file node
 * exists because something mapped to it, and a component whose row was later
 * merged away leaves the file behind. It still says "this file has been seen",
 * which is the question being asked.
 */
export function getObservedFiles() {
  if (!db) return {};

  const files = {};
  for (const row of sql('SELECT id FROM arkg_source_files').all()) files[row.id] = [];

  for (const row of sql(`
    SELECT e.to_node_id AS file, c.display_name AS component
    FROM arkg_edges e
    JOIN arkg_components c ON c.id = e.from_node_id
    WHERE e.type = 'maps_to'
  `).all()) {
    const list = (files[row.file] ??= []);
    if (row.component && !list.includes(row.component)) list.push(row.component);
  }

  for (const list of Object.values(files)) list.sort();
  return files;
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
/**
 * Every named thing in the graph, reduced to the text it can be found by.
 *
 * This is the corpus `core/navigator` searches, and it is deliberately a dumb
 * projection: an id, what the thing is called, and one secondary string worth
 * matching. The matching itself is pure and lives in `src/core/`, where it can
 * be tested without a database — the same split `buildCausalGraph` and the
 * causal tools make.
 *
 * Bounded per kind and ordered by how often each was observed — except recorded
 * flows, which have no observation count and are ordered by recency instead.
 * The caller is told which, because "the most observed" and "the most recent"
 * are different sets and the reply says one of them out loud. A graph that has outgrown the cap would otherwise
 * answer "nothing matched" for a component it holds and never looked at, which
 * is the one answer this must not give silently.
 */
export function getNamedEntities(perKind = 2000) {
  if (!db) return null;

  const cap = Math.max(1, Math.trunc(perKind));
  const entities = [];
  let truncated = false;

  /** One table's rows, capped, with the cap recorded rather than hidden. */
  const take = (table, query, toEntity) => {
    const total = sql(`SELECT COUNT(*) as n FROM ${table}`).get()?.n ?? 0;
    if (total > cap) truncated = true;
    for (const row of sql(query).all(cap)) entities.push(toEntity(row));
  };

  take(
    'arkg_components',
    'SELECT id, display_name, source_file FROM arkg_components ORDER BY frequency DESC, id LIMIT ?',
    (row) => ({
      kind: 'component',
      id: row.id,
      name: row.display_name,
      // The path is secondary text rather than a name: a component in
      // `src/checkout/Total.tsx` is worth finding for "checkout", and it is a
      // weaker answer than one actually called `Checkout`.
      ...(row.source_file ? { text: row.source_file } : {}),
    }),
  );

  take(
    'arkg_api_endpoints',
    'SELECT id, method, url_pattern FROM arkg_api_endpoints ORDER BY frequency DESC, id LIMIT ?',
    (row) => ({ kind: 'endpoint', id: row.id, name: `${row.method} ${row.url_pattern}` }),
  );

  take(
    'arkg_source_files',
    'SELECT id, path FROM arkg_source_files ORDER BY frequency DESC, id LIMIT ?',
    (row) => ({ kind: 'file', id: row.id, name: row.path }),
  );

  take(
    'arkg_named_flows',
    // Recency, not frequency: a flow is one recording and is observed once, so
    // there is no count to order by. See this function's header.
    'SELECT id, name, host FROM arkg_named_flows ORDER BY last_observed_at DESC, id LIMIT ?',
    (row) => ({
      kind: 'flow',
      id: row.id,
      name: row.name,
      ...(row.host ? { text: row.host } : {}),
    }),
  );

  take(
    'arkg_state_stores',
    'SELECT id, kind, label FROM arkg_state_stores ORDER BY frequency DESC, id LIMIT ?',
    (row) => ({
      kind: 'store',
      id: row.id,
      name: row.label ? `${row.kind} ${row.label}` : row.kind,
    }),
  );

  take(
    'arkg_state_keys',
    'SELECT id, key_name, store_kind, store_label FROM arkg_state_keys ORDER BY frequency DESC, id LIMIT ?',
    (row) => ({
      kind: 'stateKey',
      id: row.id,
      name: row.key_name,
      text: row.store_label ? `${row.store_kind} ${row.store_label}` : row.store_kind,
    }),
  );

  return { entities, truncated, perKind: cap };
}

/** The node types the navigator's entity kinds correspond to in `arkg_edges`. */
const NAVIGATOR_NODE_TYPE = {
  component: 'component',
  endpoint: 'api_endpoint',
  file: 'source_file',
  flow: 'named_flow',
  store: 'state_store',
  stateKey: 'state_key',
};

/**
 * What one matched entity is connected to, one hop out.
 *
 * This is the half that makes `explain_feature` worth more than a grep. The
 * match is lexical and reaches only things that carry the word; the edges reach
 * the endpoint a component calls, the file it was written in and the store it
 * subscribes to — none of which need ever have carried the word at all.
 *
 * Both directions, because an edge's direction is about the relationship and
 * not about which end the reader started from: a component's `calls` edges
 * point out of it, and the `maps_to` edge that names its file points out too,
 * while a search that landed on the *file* wants the same edge read backwards.
 */
export function getNeighbours(kind, id, limit = 12) {
  if (!db) return [];
  const nodeType = NAVIGATOR_NODE_TYPE[kind];
  if (!nodeType) return [];

  const rows = sql(
    `SELECT type, from_node_type, from_node_id, to_node_type, to_node_id, frequency, failure_rate
       FROM arkg_edges
      WHERE (from_node_type = ? AND from_node_id = ?) OR (to_node_type = ? AND to_node_id = ?)
      ORDER BY frequency DESC
      LIMIT ?`,
  ).all(nodeType, id, nodeType, id, Math.max(1, Math.trunc(limit)));

  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const outward = row.from_node_type === nodeType && row.from_node_id === id;
    const otherType = outward ? row.to_node_type : row.from_node_type;
    const otherId = outward ? row.to_node_id : row.from_node_id;
    const key = `${row.type}|${otherType}|${otherId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      edge: row.type,
      direction: outward ? 'out' : 'in',
      nodeType: otherType,
      id: otherId,
      label: nodeLabel(otherType, otherId),
      frequency: row.frequency,
      failureRate: row.failure_rate,
    });
  }
  return out;
}

/** What one node is called, or its id when the node is gone. */
function nodeLabel(nodeType, id) {
  const row = (() => {
    switch (nodeType) {
      case 'component':
        return sql('SELECT display_name AS label FROM arkg_components WHERE id = ?').get(id);
      case 'api_endpoint':
        return sql(
          "SELECT method || ' ' || url_pattern AS label FROM arkg_api_endpoints WHERE id = ?",
        ).get(id);
      case 'source_file':
        return sql('SELECT path AS label FROM arkg_source_files WHERE id = ?').get(id);
      case 'named_flow':
        return sql('SELECT name AS label FROM arkg_named_flows WHERE id = ?').get(id);
      case 'state_store':
        return sql(
          "SELECT COALESCE(kind || ' ' || label, kind) AS label FROM arkg_state_stores WHERE id = ?",
        ).get(id);
      case 'state_key':
        return sql('SELECT key_name AS label FROM arkg_state_keys WHERE id = ?').get(id);
      case 'git_commit':
        return sql(
          "SELECT short_sha || ' ' || subject AS label FROM arkg_git_commits WHERE id = ?",
        ).get(id);
      case 'service':
        return sql('SELECT name AS label FROM arkg_services WHERE id = ?').get(id);
      // Qualified by the service, because an operation name is only unique
      // inside one: two services both with a `GET /health` are two rows, and an
      // answer naming them both `GET /health` is unreadable.
      case 'operation':
        return sql(
          "SELECT service_name || ' ' || name AS label FROM arkg_operations WHERE id = ?",
        ).get(id);
      default:
        return null;
    }
  })();
  // An edge whose other end was pruned. Named by its id rather than dropped:
  // the edge was observed, and an answer that quietly loses it is smaller
  // without being more accurate.
  return row?.label ?? id;
}

/**
 * What the graph knows about one thing that failed, in the shape a diagnosis
 * reads.
 *
 * A projection and nothing more — `getComponent` and the endpoint table already
 * hold all of it. It exists so that `core/diagnose` can be handed two numbers
 * and a name without knowing there is a database, which is what keeps the one
 * judgement in that module (is this failure new, or is it what this thing
 * always does?) testable against a fixture.
 *
 * `null` is a real answer and the caller reports it as one: a thing the graph
 * has never seen is not a thing with a failure rate of zero, and the difference
 * between those two is the whole point of asking.
 */
export function getFailureHistory(kind, key) {
  if (!db) return null;

  if (kind === 'endpoint') {
    // `key` is `METHOD url` as a recording spells it; the graph keys endpoints
    // by a pattern with the query string stripped and identifier-shaped
    // segments collapsed, so it is hashed the same way it was written.
    const cut = String(key).indexOf(' ');
    if (cut === -1) return null;
    const method = key.slice(0, cut);
    const url = key.slice(cut + 1);
    const row = sql('SELECT * FROM arkg_api_endpoints WHERE id = ?').get(endpointId(method, url));
    if (!row) return null;
    return {
      kind: 'endpoint',
      id: row.id,
      label: `${row.method} ${row.url_pattern}`,
      observations: row.frequency ?? 0,
      failureRate: row.failure_rate ?? 0,
    };
  }

  // A component id from a recording, resolved through the alias table — an id
  // that was merged away is still in every flow that carried it.
  const row = sql('SELECT * FROM arkg_components WHERE id = ?').get(canonicalId(key));
  if (!row) return null;
  return {
    kind: 'component',
    id: row.id,
    label: row.display_name,
    observations: row.frequency ?? 0,
    failureRate: row.failure_rate ?? 0,
  };
}

export function getAppArchitecture() {
  if (!db) return null;

  const count = (table) => sql(`SELECT COUNT(*) as n FROM ${table}`).get()?.n ?? 0;
  const totalFlows = count('arkg_named_flows');
  const totalComponents = count('arkg_components');
  const totalEndpoints = count('arkg_api_endpoints');
  /*
   * Services count towards "this graph holds something".
   *
   * Without them a database fed only by an exporter — spans arriving for
   * recordings nobody has sent yet, which is the ordinary order — answers
   * `null`, and every caller renders that as "no graph". The three counts above
   * are all things a *person* did; this is the one thing the graph can learn
   * without anybody doing anything, so leaving it out of the test made the one
   * state Tier 2 introduced indistinguishable from an empty install.
   */
  const totalServices = count('arkg_services');
  if (totalFlows === 0 && totalComponents === 0 && totalEndpoints === 0 && totalServices === 0) {
    return null;
  }

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

// ── Backend traces, read back ─────────────────────────────────────────────────

/** One operation row in the shape every answer here hands out. */
const operationOut = (row) => ({
  id: row.id,
  service: row.service_name,
  name: row.name,
  kind: row.kind,
  sourceFile: row.source_file,
  sourceLine: row.source_line,
  frequency: row.frequency,
  failureRate: row.failure_rate,
  timingP50Ms: row.timing_p50_ms,
  timingP95Ms: row.timing_p95_ms,
  gitSha: row.git_sha,
  firstObservedAt: row.first_observed_at,
  lastObservedAt: row.last_observed_at,
});

/**
 * Every service the graph has seen, busiest first.
 *
 * `operationCount` rides along because it is the one number a caller listing
 * services always wants next and cannot get from the row — a service with one
 * operation and a service with sixty read identically otherwise — and because
 * the alternative is a query per row from whoever is rendering the list. It is
 * not stored: `frequency` is an observation count and this is a `COUNT(*)` over
 * a table, and a stored copy of a derivable number is a copy that goes stale.
 */
export function getServices() {
  if (!db) return [];
  return sql(`
    SELECT s.*, (SELECT COUNT(*) FROM arkg_operations o WHERE o.service_id = s.id) AS operation_count
      FROM arkg_services s
     ORDER BY s.frequency DESC, s.name ASC
  `).all().map((row) => ({
    id: row.id,
    name: row.name,
    version: row.version,
    environment: row.environment,
    frequency: row.frequency,
    operationCount: row.operation_count,
    gitSha: row.git_sha,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
  }));
}

/**
 * The operations of one service, by `service.name` rather than by node id.
 *
 * The name is what a caller has: it came off a span, out of `getServices`, or
 * out of a question somebody typed, and requiring the hash first would make
 * every reader do a lookup to ask a question they already had the key for.
 */
export function getOperationsForService(name) {
  if (!db) return [];
  return sql(`
    SELECT * FROM arkg_operations WHERE service_name = ?
    ORDER BY frequency DESC, name ASC
  `).all(name).map(operationOut);
}

/**
 * The backend work one recorded request reaches, nearest first.
 *
 * This is the FE → BE → DB chain read back out: `depth` 1 is what answered the
 * request, and everything deeper was caused by that rather than by the browser
 * — which is why only the root operations carry an edge from the endpoint at
 * all, and why the query below has to walk instead of joining once.
 *
 * Breadth-first, so a caller taking the first few gets the layer nearest the
 * request rather than one arbitrary branch followed to its leaf. `seen` and
 * `limit` bound the walk: an edge table is shared mutable state that anything
 * reaching the span endpoint can add to, and an unbounded traversal in a server
 * handling a request is the failure `buildSpanTree` guards the same way.
 *
 * An id with no row is walked through and not reported — a pruned operation is
 * still evidence that the chain continues past it.
 */
export function getBackendForEndpoint(method, url, limit = 50) {
  if (!db) return [];
  const start = endpointId(String(method ?? 'GET'), String(url ?? ''));
  const next = sql(`
    SELECT to_node_id AS id FROM arkg_edges
     WHERE type = 'calls' AND from_node_type = ? AND from_node_id = ? AND to_node_type = 'operation'
     ORDER BY frequency DESC, id ASC
  `);
  const row = sql('SELECT * FROM arkg_operations WHERE id = ?');

  const cap = Math.max(1, Math.trunc(limit));
  const seen = new Set();
  const out = [];
  const queue = next.all('api_endpoint', start).map((edge) => ({ id: edge.id, depth: 1 }));

  while (queue.length && out.length < cap) {
    const { id, depth } = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const found = row.get(id);
    if (found) out.push({ ...operationOut(found), depth });
    for (const edge of next.all('operation', id)) {
      if (!seen.has(edge.id)) queue.push({ id: edge.id, depth: depth + 1 });
    }
  }
  return out;
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
    const commitIds = ids('arkg_git_commits');
    const serviceIds = ids('arkg_services');
    const operationIds = ids('arkg_operations');

    deleteEdgesFor('component', compIds);
    deleteEdgesFor('api_endpoint', epIds);
    deleteEdgesFor('source_file', fileIds);
    deleteEdgesFor('state_store', storeIds);
    // A commit node outlives nothing else here: its edges point at source files
    // that are pruned on their own schedule, and a changed_in edge left behind
    // by a pruned commit would name a node that is gone.
    deleteEdgesFor('git_commit', commitIds);
    /*
     * The backend nodes age out on the same schedule as everything else, and
     * they are the ones that most need to.
     *
     * Every other node here is created by somebody recording, so the graph
     * grows at the rate a person works. These are created by a span arriving on
     * an endpoint nothing on this machine controls the cadence of — a busy
     * backend exporting under trace ids DevFlow minted can add operations
     * faster than any recording ever will. A retention policy that reached
     * every node kind except the two fed from off the machine would be pointing
     * the wrong way round.
     *
     * The operation edges go first for `git_commit`'s reason: a `calls` edge
     * from a pruned endpoint to a live operation names a node that is gone, and
     * `getBackendForEndpoint` walks exactly those edges.
     */
    deleteEdgesFor('operation', operationIds);
    deleteEdgesFor('service', serviceIds);

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
    deleteNodes('arkg_git_commits', commitIds);
    deleteNodes('arkg_operations', operationIds);
    deleteNodes('arkg_services', serviceIds);

    sql('DELETE FROM arkg_named_flows WHERE last_observed_at < ?').run(cutoff);

    /*
     * The per-fact ledger goes with them.
     *
     * It exists so that one recording's trace, arriving across several
     * deliveries, counts once — so a row is only meaningful while the node it
     * deduplicates against is still here. Left behind, it grows without bound
     * and, worse, would suppress the re-counting of an operation that had been
     * pruned and then observed again.
     */
    sql('DELETE FROM arkg_trace_observations WHERE observed_at < ?').run(cutoff);

    // The count is components and endpoints, as it has always been: it is
    // reported to a reader as how much of the graph went stale, and adding two
    // node types to it would move a number nobody changed the retention of.
    return compIds.length + epIds.length;
  })();
}
