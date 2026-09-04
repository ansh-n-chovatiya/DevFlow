#!/usr/bin/env node
/**
 * DevFlow MCP server — recorded browser flows, as tools Claude can call.
 *
 * LOCAL (default): stdio MCP, plus an HTTP receiver on 127.0.0.1:7734 that the
 * Chrome extension POSTs recordings to.
 *
 *   npx devflow-mcp-server install
 *
 * which is `claude mcp add devflow --scope user -- npx -y devflow-mcp-server` with
 * the scope no longer something a person can leave off. See `install.js`.
 *
 * REMOTE: SSE MCP and the receiver on $PORT, for a hosted deployment.
 *
 *   MCP_MODE=remote node server.js
 *
 * Flows are written to ~/.devflow/flows, not next to this file: under npx the
 * package lives in a cache directory that gets cleared without warning, which
 * would take every recording with it. DEVFLOW_DIR overrides the location.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
/*
 * The renderer, the body compaction and the source formatting all come from
 * `src/core/`, bundled here by `npm run build:mcp`. This file used to carry its
 * own smaller copy of each; see `src/core/mcp-bundle.ts` for what that cost.
 */
import {
  buildCausalGraph,
  callFailed,
  causesOf,
  buildArchitecture,
  choosePair,
  commitCaveats,
  compactBody,
  DEFAULTS,
  describeCommit,
  describeStamp,
  describeTrace,
  diagnose,
  effectsOf,
  exportToMarkdown,
  fieldFor,
  findFeature,
  flowCommit,
  flowHost,
  generatePlaywrightTest,
  flowRendering,
  formatSource,
  sourceProvenance,
  MACHINE_KEYS,
  describeProductionError,
  flowA11y,
  renderA11y,
  parseSentryDelivery,
  planActions,
  planReplay,
  projectRelative,
  rankCandidates,
  readRun,
  renderArchitecture,
  renderComponents,
  renderBlastRadius,
  renderDeployDiff,
  renderForensics,
  renderStep,
  resolve as resolveSettings,
  shaMatches,
  shortSha,
  matchSourceFile,
  isShaPrefix,
  joinTrace,
  joinableSha,
  projectTrace,
  snippet,
  stepFailed,
  suspectFiles,
  traceValue,
  tracedCallsOf,
  urlPath,
  valueOfStep,
} from './core.js';

/*
 * The CLI verbs, before anything else in this file happens.
 *
 * Everything below makes a directory, reads a config file and binds a port, all
 * at the top level, because that is what a server started by an MCP client
 * should do the moment it is started. `npx devflow-mcp-server install` should do none
 * of it: it is a person at a terminal registering the server, not Claude Code
 * launching it, and a setup command that leaves a listener behind is a setup
 * command with a side effect nobody asked for.
 *
 * So the fork is here, above the first `const` that reads the environment, and
 * `install.js` is imported only on the path that needs it. An argument that is
 * not a verb prints the usage rather than starting a server that would then sit
 * on a stdio transport nobody is speaking: a typo should say so, not hang.
 */
if (process.argv.length > 2) {
  /*
   * `regression` is the one verb that is asynchronous — it spawns a browser —
   * so the dispatch awaits. `run` returns a number for every other verb and
   * awaiting a number is a number, so nothing else changes shape.
   */
  if (process.argv[2] === 'regression') {
    const { regressionCommand } = await import('./regression-cli.js');
    process.exit(await regressionCommand(process.argv.slice(3)));
  }
  const { run } = await import('./install.js');
  process.exit(run(process.argv[2], process.argv.slice(3)));
}

const { version: VERSION } = createRequire(import.meta.url)('./package.json');
const REMOTE = process.env.MCP_MODE === 'remote';
const HOME = process.env.DEVFLOW_DIR
  ? path.resolve(process.env.DEVFLOW_DIR)
  : path.join(os.homedir(), '.devflow');
const FLOWS_DIR = path.join(HOME, 'flows');
/*
 * The knowledge graph sits beside the flows rather than inside one, because
 * what it holds is what every recording *together* says about an application —
 * which components are hot, which endpoints fail, which files keep coming up.
 * A per-flow file could not hold that, and a flow evicted by the retention
 * sweep would take its share of the answer with it.
 */
const ARKG_DB = path.join(HOME, 'arkg.db');

/*
 * The held spans, in their own database rather than a table in `arkg.db`.
 *
 * They are not graph data. A span is one event that happened once, and what
 * reaches the graph is the *operation* it was an observation of — so this file
 * is a waiting room with a retention policy, and giving it its own file means
 * deleting it costs nothing the accumulated graph knows. It is also the only
 * store on this machine fed from off it, which is a second reason not to put it
 * in the same file as everything DevFlow has learned.
 */
const SPAN_DB = path.join(HOME, 'spans.db');
// The port is `mcp.port`, and it is settled below, once the settings layer that
// decides it exists — see `HTTP_PORT`.

/** The highest `FLOW_SCHEMA_VERSION` this server knows how to read. */
/*
 * Tier 3 — deliberately not configurable. A wire contract
 * between two packages that ship separately. A user-set version is a user-set
 * lie: this server would then read fields by a shape the extension never wrote.
 */
const SUPPORTED_SCHEMA = 1;

/**
 * Cap on a POSTed flow.
 *
 * The receiver listens on loopback and any page the user visits can reach it,
 * so the body is read into memory before anything has vouched for it. 500
 * screenshots at the extension's own limit come to well under this.
 *
 * Tier 3 — deliberately not configurable. It is the only
 * thing bounding the unauthenticated POST that carries a flow. `POST /config`
 * has its own, smaller ceiling below.
 */
const MAX_BODY_BYTES = 512 * 1024 * 1024;

/**
 * Cap on a POSTed settings file.
 *
 * `POST /config` is on the same loopback port as the receiver and reachable by
 * the same callers, so it needs the same kind of ceiling — and a far smaller
 * one, because it is not carrying screenshots. The whole field table serialised
 * with every key set is a few kilobytes; this is that with three orders of
 * magnitude of room.
 *
 * Tier 3 — deliberately not configurable, for the same
 * reason `MAX_BODY_BYTES` is not. It is one of the two things bounding an
 * unauthenticated POST, and a bound a POST can raise is not a bound. It would
 * also be self-defeating in a way the flow cap is not: this endpoint writes the
 * very file the value would be read from.
 */
const MAX_CONFIG_BYTES = 64 * 1024;

/**
 * Cap on a POSTed component pick.
 *
 * `POST /arkg/ingest-component` carries a name, a path, a line and a flag. It
 * gets its own ceiling for the same reason the other two have one — the body is
 * read into memory on an unauthenticated loopback port, before anything has
 * vouched for it — and a small one, because nothing legitimate sent there is
 * large.
 *
 * Tier 3 — deliberately not configurable, exactly as `MAX_BODY_BYTES` and
 * `MAX_CONFIG_BYTES` are not: a bound the POST can raise is not a bound.
 */
const MAX_PICK_BYTES = 64 * 1024;

/*
 * The ceiling on one architecture reading. Larger than a pick's, because a
 * reading of a real app is a few hundred components with their source paths, and
 * smaller than a flow's by three orders of magnitude, because it carries no
 * screenshot, no body and no value from the page at all.
 *
 * Not configurable, for the reason none of the others is: a bound the POST can
 * raise is not a bound.
 */
const MAX_ARCHITECTURE_BYTES = 512 * 1024;

/**
 * The living architecture readings, in memory and nowhere else.
 *
 * ## Why this is not on disk, unlike every other thing this server is sent
 *
 * A flow is a record: somebody made it deliberately, it is worth keeping, and it
 * is still worth reading next week. A reading of what is mounted is the opposite
 * kind of fact — it is true of one page at one moment, it is superseded by the
 * next navigation, and its whole value is its freshness. Writing it to
 * `~/.devflow` would create a file whose only possible use is to answer a
 * question wrongly: a reader who restarts the server tomorrow and is handed
 * yesterday's map has been told about a page that is not open.
 *
 * So a restart loses these, and that is correct rather than a limitation. It
 * also means this feature adds no retention ceiling, no sweep and no line in the
 * config — the three things every other thing the server stores needed.
 *
 * Keyed by URL and capped, so a developer with two tabs open gets both and a
 * long session does not accumulate one entry per route they visited. Eviction is
 * oldest-first by reading time, not by insertion: re-reading a page moves it to
 * the front, which is what makes the cap describe "the pages recently looked at"
 * rather than "the pages first looked at".
 */
const MAX_ARCHITECTURE_READINGS = 8;
const architectureReadings = new Map();

/** Keep the most recent readings, newest first, and drop the rest. */
function rememberArchitecture(snapshot) {
  architectureReadings.set(snapshot.url, snapshot);
  if (architectureReadings.size <= MAX_ARCHITECTURE_READINGS) return;
  const ordered = [...architectureReadings.entries()].sort((a, b) => b[1].takenAt - a[1].takenAt);
  architectureReadings.clear();
  for (const [url, reading] of ordered.slice(0, MAX_ARCHITECTURE_READINGS)) {
    architectureReadings.set(url, reading);
  }
}

/*
 * The ceiling on one span delivery, larger than a pick's because a batching
 * exporter legitimately sends hundreds of spans at once and a stack trace on an
 * exception event is not small. Read into memory before anything has vouched
 * for it, which is the whole reason there is a number here at all.
 */
const MAX_SPAN_BYTES = 4 * 1024 * 1024;

/**
 * The ceiling on one relayed crash report.
 *
 * Far below `MAX_SPAN_BYTES`, because the two are different shapes: a span
 * delivery is a batch and a crash report is one issue. A payload larger than
 * this is a relay forwarding something other than what this reads, and
 * accepting a megabyte of it into memory to find that out is the wrong trade
 * on an endpoint that any local process can reach.
 */
const MAX_WEBHOOK_BYTES = 256 * 1024;

/**
 * How long an observation stays in the knowledge graph.
 *
 * The graph is the one store here that grows without anyone asking it to: every
 * flow and every pick adds rows, and nothing about a component nobody has
 * touched since April is evidence about the app as it is now. Ninety days is
 * generous on purpose — the anomaly baselines want months of history, not
 * weeks — and it is the only thing keeping a year-old refactor from showing up
 * as today's architecture.
 *
 * Not in the field table, and that is a gap rather than a decision. The key
 * belongs beside `mcp.maxFlows`, which is machine-wide for exactly this reason;
 * `docs/CONTRACTS.md` §3.6 enumerates the prefixes each settings concept owns
 * and is frozen, so it cannot be added without amending the contract. Until
 * then the number lives here with the environment as its only override — the
 * state the retention caps themselves were in before Phase 5, and the reason
 * this should not stay.
 */
const ARKG_RETENTION_ENV = Number(process.env.DEVFLOW_ARKG_RETENTION_DAYS);
const ARKG_RETENTION_DAYS =
  Number.isFinite(ARKG_RETENTION_ENV) && ARKG_RETENTION_ENV >= 1
    ? Math.round(ARKG_RETENTION_ENV)
    : 90;

/**
 * How long a directory with no readable `meta.json` is left alone.
 *
 * `meta.json` is written last, so its absence means either a save happening
 * right now or one that failed part way. Waiting an hour tells those apart
 * without a lock.
 *
 * Tier 3 — deliberately not configurable. Deletion safety:
 * shorten it and a save in progress becomes a directory this server deletes.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * How this server decides what a response looks like.
 *
 * The server's settings split in two,
 * because two kinds of setting behave differently across a machine boundary.
 *
 *   - **Per-flow rendering** — the response budget, the `raw` default, images
 *     per call, body length in tool output and the two walkthrough caps — is a
 *     property of the *recording*. It travels inside the flow, in the same
 *     `settings` stamp §6 already uses to say what a recording was made under,
 *     and is persisted in `flow.json`. There is no other channel: the Settings
 *     screen is in a browser and this is a Node process with no access to it.
 *   - **Machine-wide** — retention and the port — is a property of *this
 *     installation* and cannot sensibly be carried by one recording: a flow
 *     arriving from another browser profile, or read a month after it was made,
 *     has no business saying how much disk this machine keeps. That is
 *     `~/.devflow/config.json`, which `POST /config` writes and this file
 *     re-reads. The three keys are `machine: true` in the extension's field
 *     table, and that flag is the endpoint's whole allow-list.
 *
 * ### Precedence: environment variable > config.json > per-flow > default
 *
 * Read as "the layer that knows most about *this run* wins". An environment
 * variable is set by whoever launched the process, so it is the last word: a CI
 * job or a headless run must not be steered by whatever a browser once synced
 * into a flow it happens to be reading. `config.json` is this machine's standing
 * answer. The flow's own stamp is the user's answer, made in the extension,
 * travelling with the recording it was made for. The field table's default is
 * what is left.
 *
 * ### One validator, not two
 *
 * The chain is four sparse override objects merged and handed to `resolve()` —
 * *the extension's own* `resolve()`, bundled in through `core/mcp-bundle.ts`.
 * The plan's standing rule is that `resolve` is the only validator, and a second
 * one written here would clamp a hand-edited `config.json` by rules that drift
 * from the ones the Settings screen enforces. It also matters more here than
 * anywhere else: `flow.settings` arrives over an unauthenticated loopback POST
 * that any page the user visits can reach, so every number below is clamped to
 * the same range the form offers before anything acts on it.
 */

/** The settings file this installation may carry. Phase 5 writes it. */
const CONFIG_FILE = path.join(HOME, 'config.json');

/**
 * Environment variables, and the setting each one sets.
 *
 * A table rather than a derivation from the key, so renaming a setting cannot
 * silently move an environment variable somebody's launcher already sets.
 * `DEVFLOW_MAX_TOKENS` predates the mechanism and keeps its name.
 *
 * The last three are the machine-wide keys. They used to be read straight from
 * `process.env` further up this file, which is why `config.json` naming one had
 * to be announced and ignored; they come through the ordinary chain now, so a
 * variable still beats the file and the file finally reaches something.
 * `PORT` is not here: it belongs to remote mode, where the port is how MCP
 * itself is served and no settings layer may move it.
 */
const ENV_SETTINGS = {
  DEVFLOW_MAX_TOKENS: 'mcp.maxTokens',
  DEVFLOW_RAW: 'mcp.raw',
  DEVFLOW_MAX_IMAGES: 'mcp.maxImages',
  DEVFLOW_BODY_LIMIT: 'mcp.bodyLimit',
  DEVFLOW_MAX_RESPONSE_BODY: 'mcp.maxResponseBody',
  DEVFLOW_MAX_CONSOLE_ENTRIES: 'mcp.maxConsoleEntries',
  DEVFLOW_PORT: 'mcp.port',
  DEVFLOW_MAX_FLOWS: 'mcp.maxFlows',
  DEVFLOW_MAX_BYTES: 'mcp.maxFlowBytes',
};

/**
 * One environment string as the setting's own type, or `undefined` if it is not
 * a usable answer.
 *
 * Booleans are the reason this exists. `resolveField` is deliberately strict —
 * `'false'` is a string, and every truthiness test in JavaScript reads it as
 * `true`, which is the most expensive coercion available to a settings file. So
 * an environment variable is coerced *here*, where the value is known to be a
 * string because the operating system has no other type, and anything that is
 * not plainly one answer or the other is refused rather than guessed at.
 */
function coerceEnv(field, raw) {
  if (!field) return undefined;
  if (field.type === 'boolean') {
    if (/^(1|true|yes|on)$/i.test(raw)) return true;
    if (/^(0|false|no|off)$/i.test(raw)) return false;
    return undefined;
  }
  if (field.type === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return raw;
}

/**
 * The environment layer.
 *
 * A variable that cannot be read is logged and dropped, never silently ignored:
 * `DEVFLOW_RAW=maybe` producing the default while looking set is exactly the
 * "appears to work and quietly uses the compiled-in value" failure the whole
 * mechanism is built against, and stderr is the only surface this process has.
 * An out-of-range *number* is not dropped — `resolve` clamps it, and is logged
 * below for the same reason.
 */
function envOverrides() {
  const out = {};
  for (const [name, key] of Object.entries(ENV_SETTINGS)) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') continue;

    const value = coerceEnv(fieldFor(key), raw);
    if (value === undefined) {
      log(`ignoring ${name}=${raw} — not a value ${key} can take`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * The config-file layer.
 *
 * Read at startup, and again after `POST /config` writes it — so a setting
 * changed in the extension reaches the retention sweep without waiting for a
 * restart. A file edited by hand still takes effect when the server next
 * starts, which for a stdio MCP server is every session.
 *
 * Every failure reads as "no config": a missing file is the ordinary case, and
 * a malformed one is announced and then ignored rather than taking the server
 * down — the flows on disk are still readable, and a client that cannot start
 * this server gets no error message at all.
 */
async function readConfigFile() {
  let text;
  try {
    text = await fs.readFile(CONFIG_FILE, 'utf8');
  } catch {
    // The ordinary case, and not a problem: an installation that has never been
    // configured has no file, and is not to be told it has a broken one.
    return { ok: true, value: {} };
  }

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, problem: `${CONFIG_FILE} is not a settings object` };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, problem: `${CONFIG_FILE} is not valid JSON (${error.message})` };
  }
}

/** The file as settings, with every failure reading as "no config". */
async function readConfig() {
  const read = await readConfigFile();
  if (read.ok) return read.value;
  log(`${read.problem} — ignoring it`);
  return {};
}

/**
 * The two layers above the flow, and everything derived from them.
 *
 * `let` rather than `const` because `POST /config` re-reads the file it just
 * wrote. The alternative — take effect on the next restart — is what the whole
 * mechanism exists against: the user changes a retention cap, the extension
 * reports success, and the number that is actually enforced is the old one,
 * with nothing anywhere saying so.
 *
 * Env last, so env wins.
 */
let MACHINE_SETTINGS = {};
let MACHINE_RESOLVED = resolveSettings({});
/** What this installation renders under, before any flow has been opened. */
let MACHINE_RENDERING = flowRendering(MACHINE_RESOLVED);

/**
 * Take a config file as the machine's standing answer, and say what it changed.
 *
 * A clamp is announced for the same reason an unreadable environment variable
 * is: a number that quietly became a different number is what this is written
 * against. Only for keys this build knows — an unknown key belongs to a newer
 * DevFlow and is not this server's to complain about.
 */
function applyMachineSettings(config) {
  MACHINE_SETTINGS = { ...config, ...envOverrides() };
  MACHINE_RESOLVED = resolveSettings(MACHINE_SETTINGS);
  MACHINE_RENDERING = flowRendering(MACHINE_RESOLVED);

  for (const [key, wanted] of Object.entries(MACHINE_SETTINGS)) {
    if (!fieldFor(key)) continue;
    if (MACHINE_RESOLVED[key] !== wanted) {
      log(`${key}: ${wanted} is out of range — using ${MACHINE_RESOLVED[key]}`);
    }
  }
}

applyMachineSettings(await readConfig());

/**
 * The port this process listens on, decided once.
 *
 * `const`, alone among the machine-wide settings, and the exception is the
 * point: a socket is bound before any request can arrive and cannot be moved
 * under the connections already on it. So a later `POST /config` writes the new
 * port to the file, where the next start will read it, and says in its reply
 * that this process is still on the old one. Both sides then know the truth,
 * which is the only outcome worse than no port setting at all — one side
 * moving quietly — is ruled out by.
 *
 * Remote mode keeps `PORT`: there the port is how MCP itself is served, and a
 * value synced out of somebody's browser has no business moving it.
 */
const HTTP_PORT = REMOTE ? Number(process.env.PORT) || 8080 : MACHINE_RESOLVED['mcp.port'];

/**
 * How much recorded history to keep, oldest evicted first.
 *
 * Nothing here ever deleted anything, so the directory grew for as long as the
 * user kept recording — a normal day of twenty twenty-step sends adds tens of
 * megabytes, forever, with no way to prune from the extension. Two ceilings
 * rather than one because they fail differently: a few enormous flows blow the
 * disk budget while the count looks fine, and a great many tiny ones blow the
 * count while the bytes look fine.
 *
 * Deliberately generous. This is a runaway guard, not a retention policy —
 * losing a recording someone still wanted is the worse failure, so the caps sit
 * far above any plausible working set.
 *
 * Read through a function rather than captured in two constants, so a cap
 * lowered through `POST /config` governs the very next save. A sweep is never
 * run *because* the setting changed, though: eviction is deletion, and deleting
 * recordings as the immediate effect of a settings write — over an endpoint a
 * page can reach — is a much worse thing to be wrong about than a cap that
 * takes effect when the next flow arrives.
 */
function retention() {
  return {
    maxFlows: MACHINE_RESOLVED['mcp.maxFlows'],
    maxFlowBytes: MACHINE_RESOLVED['mcp.maxFlowBytes'],
  };
}

/**
 * The settings one flow is rendered under — the whole chain, in one expression.
 *
 * Spread order *is* the precedence rule: later wins, so the flow's own stamp is
 * overridden by this machine's config, which is overridden by the environment.
 * `resolve` fills in every key none of them carried and clamps every key they
 * did.
 *
 * ### What each of these decides
 *
 * `maxTokens` — what one tool response may weigh. Every MCP client caps tool
 * output and applies the cap by *truncating the string*: a 24-step recording
 * came to 93,000 tokens before compaction and still runs to tens of thousands
 * after it on a busy app, so the document arrived with its last steps missing,
 * its JSON block unterminated, and nothing anywhere saying a cut had happened.
 * The model then answers questions about a recording it has only part of,
 * confidently. So the server does the cutting, on a step boundary, and says so.
 *
 * `maxImages` — how many pictures one `get_flow_screenshots` call returns. A
 * recorded screenshot costs on the order of 1,500 tokens of vision budget, and
 * this tool is the fallback for readers that cannot open a file, not the way to
 * look at a flow. The paths are free; the pictures are not.
 *
 * `bodyLimit` — how much of a request or response body goes into the step JSON.
 * It matches the extension's own diagnostic limit and must not go below it: the
 * extension compacts every body before it sends one, and a *failed* call keeps
 * its body verbatim because that body is the diagnostic. Cutting shorter here
 * spends that budget and then throws half of it away, taking the tail of exactly
 * the stack traces `get_flow_errors` exists to surface. `get_flow_step` gets
 * four times as much: it carries one step rather than tens of them, and it is
 * reached because something already decided this is the step that matters.
 *
 * `raw` — whether a `get_flow` response carries the step JSON without being
 * asked. Off by default because it repeats what the walkthrough already says
 * and adds replay data that answers no question about what went wrong.
 *
 * `limits` — the body rules the sender already applied, and the walkthrough's
 * own two caps. The `network.*` half is normally the *flow's* answer: the
 * extension compacted the bodies on the way out under those rules, and
 * re-summarising a body the sender deliberately kept verbatim would undo the
 * setting from the far side of the wire.
 *
 * "Normally", not "always", and the difference is worth being exact about. The
 * two `network.*` keys sit in the same chain as everything else, so a
 * `config.json` or an environment that names one *does* override the flow. That
 * is §3's rule applied uniformly, and it is the right answer — "this machine
 * wants summaries" is a legitimate thing to say about every flow it reads. What
 * it cannot do is undo a compaction: a body already summarised at capture is
 * gone, and only `summarise: true` can be applied after the fact. `POST /config`
 * writes the three machine-wide keys and nothing else, so these two reach this
 * file by a hand edit or the environment, and by no other route.
 */
function renderingFor(flow) {
  const stamp = flow?.settings;
  const perFlow = stamp && typeof stamp === 'object' && !Array.isArray(stamp) ? stamp : {};
  return flowRendering(resolveSettings({ ...perFlow, ...MACHINE_SETTINGS }));
}

/** The step JSON's body limit, which is four times larger in `full` mode. */
const bodyLimitFor = (render, full) => (full ? render.bodyLimit * 4 : render.bodyLimit);

await fs.mkdir(FLOWS_DIR, { recursive: true });

function log(message) {
  process.stderr.write(`DevFlow: ${message}\n`);
}

/**
 * The knowledge graph, if this installation has one.
 *
 * Imported dynamically and opened inside a `try`, and both halves of that are
 * load-bearing. `arkg.js` is not in the npm package's `files` list and its
 * `better-sqlite3` is a compiled native addon, so there are two ordinary ways
 * for this module to be unavailable on a machine where everything else works:
 * the published tarball does not carry it, and a Node upgrade leaves the addon
 * built against the wrong ABI. A static `import` turns either into a server
 * that does not start at all — no flows, no tools, no `list_flows`, and a
 * Claude session that reports the MCP server as failed.
 *
 * That trade is never worth taking. The graph is additive intelligence: it
 * answers questions the recordings cannot, and every question the recordings
 * *can* answer is answered without it. So a missing, corrupt or unbuildable
 * database degrades to "no graph", is said once on stderr, and changes nothing
 * else about this process.
 */
let arkg = null;
try {
  arkg = await import('./arkg.js');
  arkg.openArkg(ARKG_DB);
  log(`knowledge graph at ${ARKG_DB} — keeping ${ARKG_RETENTION_DAYS} days`);
} catch (error) {
  arkg = null;
  log(`no knowledge graph (${error.message}) — flows and every other tool are unaffected`);
}

/**
 * The one way this file talks to the graph.
 *
 * A single guarded call site rather than a `try` at each of the six, because
 * "ARKG failure must never break the server" is only true if it is true
 * everywhere, and the way that invariant dies is one unguarded call added later
 * by somebody who did not know it was one. `fallback` is what the caller sees
 * when there is no graph and when the graph threw, which are the same thing to
 * everyone upstream.
 */
function arkgTry(what, run, fallback = null) {
  if (!arkg) return fallback;
  try {
    return run(arkg);
  } catch (error) {
    log(`knowledge graph: ${what} failed (${error.message})`);
    return fallback;
  }
}

// ── The checkout a recording is stamped from ────────────────────────────────

/*
 * `git.js`, on the same terms as the graph above it.
 *
 * It imports the built `core.js`, so an installation missing that artefact
 * loses the stamp and nothing else — the same degradation as a machine with no
 * `git` on its PATH, which is a state this has to survive anyway.
 */
let gitmod = null;
try {
  gitmod = await import('./git.js');
} catch (error) {
  gitmod = null;
  log(`no commit stamping (${error.message}) — flows and every other tool are unaffected`);
}

/** `arkgTry`'s promise, for a module whose every function is async. */
async function gitTry(what, run, fallback = null) {
  if (!gitmod) return fallback;
  try {
    return await run(gitmod);
  } catch (error) {
    log(`commit: ${what} failed (${error.message})`);
    return fallback;
  }
}

/*
 * `otel.js`, on the same terms as `git.js` above it.
 *
 * It holds the spans a backend exported and nothing else this server needs to
 * boot, so an installation without it loses Tier 2 and keeps every other tool —
 * the degradation `arkgTry` and `gitTry` were both written for.
 *
 * It is the one capability here that is **off unless the user turned it on**,
 * and the asymmetry with `DEVFLOW_GIT` is deliberate rather than an oversight.
 * `git` reads a repository this machine already owns, with a fixed argv. This
 * accepts a document from off the machine, written by a process DevFlow has
 * never met, and turns it into rows in the accumulated graph. Every other write
 * endpoint here is guarded by `extensionOrigin`, and this one *cannot* be: the
 * sender is the user's own backend or their collector, which has no extension
 * origin and never will. So the gate that is available is the user having asked
 * for it, and `DEVFLOW_OTEL=1` is that gate.
 */
let otelmod = null;
try {
  otelmod = await import('./otel.js');
  if (otelmod.OTEL_ENABLED) {
    otelmod.openSpanStore(SPAN_DB);
    log(`span ingest on — POST /v1/traces, OTLP/JSON, held at ${SPAN_DB}`);
  }
} catch (error) {
  otelmod = null;
  log(`no span ingest (${error.message}) — flows and every other tool are unaffected`);
}

/** `arkgTry` for the span store. Nothing about a span may fail a recording. */
function otelTry(what, run, fallback = null) {
  if (!otelmod || !otelmod.OTEL_ENABLED) return fallback;
  try {
    return run(otelmod);
  } catch (error) {
    log(`spans: ${what} failed (${error.message})`);
    return fallback;
  }
}

/**
 * What the span store can say about one recording, as `traceValue` wants it.
 *
 * The three states are not three wordings of one nothing: ingest being off is a
 * flag on this server, a recording with no traced call is a switch in the
 * extension, and spans that have not arrived are the user's exporter — and the
 * last of those is the one where DevFlow's side is *already* correct. The
 * distinction is `get_backend_trace`'s and it is kept here because it is the
 * same reader, who otherwise goes and changes a setting that was not the
 * problem. `tracedCalls` is left to the caller of this rather than counted
 * again inside it, so `unsearchedLayers` and this function cannot disagree.
 */
function backendReadingFor(flow) {
  if (!otelmod || !otelmod.OTEL_ENABLED) return { available: false, reason: 'ingest-off' };

  const calls = tracedCallsOf(flow);
  const spans =
    otelTry('read held spans', (o) => o.spansForTraces(calls.map((c) => c.traceId)), []) ?? [];
  const { joined, awaiting } = joinTrace({ calls, spans });
  return { available: true, joined, awaiting, tracedCalls: calls.length };
}

/**
 * How much of one span's line is worth printing.
 *
 * A span arrives from an endpoint that cannot be authenticated \u2014 the sender
 * is the user\u2019s own backend or their collector, which has no extension
 * origin and never will \u2014 so every string on it is untrusted text, and a
 * 200KB `db.query.text` would otherwise be one line of the answer. Generous
 * rather than tight, because a query is the one thing here somebody reads in
 * full, and cut where a reader can see the cut.
 */
const SPAN_LINE = 2000;

/**
 * One operation as the lines a reader can act on.
 *
 * Indentation rather than a table because the shape *is* the answer here: a
 * query three levels under the handler that answered the request is a different
 * fact from one the handler issued itself, and a flat list loses exactly that.
 *
 * Extracted from `flattenSpanLines` rather than copied beside it, because there
 * are now two tools that print a span \u2014 `get_backend_trace` prints a whole
 * trace, `get_value_provenance` prints the capped chain behind one call \u2014
 * and the second was otherwise going to be a second span renderer that
 * disagreed with the first about what a span looks like. It takes the flattened
 * shape both callers can supply, which is `core/provenance`'s `BackendHop`
 * almost exactly, rather than an `OtelSpan`: the provenance side never holds
 * the span, only what the pure module already read off it.
 *
 * Each line carries only what a reader can act on \u2014 where it ran, what it
 * was, how long it took, and whether it failed. The SQL is printed when the
 * instrumentation supplied it and is never invented; `db.query.text` is what
 * the user\u2019s own tracer chose to record, including whether it was
 * parameterised, and rewriting it here would show them a query their database
 * never saw. Cutting it at `cap` is not a rewrite: the cut says so, and the
 * count of what was cut goes with it.
 */
function spanLines(hop, indent, cap) {
  const pad = `${indent}${'  '.repeat(Math.max(0, Number(hop.depth) || 0))}`;
  const cut = (value) => truncate(String(value ?? ''), cap);

  const ms = `${Number(hop.durationMs ?? 0).toFixed(1)}ms`;
  const status = hop.status === null || hop.status === undefined ? '' : ` \u00b7 ${cut(hop.status)}`;
  const where = hop.file ? ` \u00b7 ${cut(hop.file)}${hop.line ? `:${cut(hop.line)}` : ''}` : '';
  const failed = hop.failed ? ' **FAILED**' : '';
  /*
   * `?? null` on the two newest fields, because a span read back out of the
   * store predates them: rows written by an earlier build carry no `query` and
   * no `stacktrace`, and this renderer is asked for them the moment the schema
   * grows. Absent is not empty and neither is an error.
   */
  const query = hop.query ?? null;
  /*
   * Which hop the value actually turned up in, said on the hop rather than in a
   * footnote. A chain of nine operations with no mark on any of them and a
   * sighting listed elsewhere leaves the reader to guess which one it was, and
   * the guess they make is "the query", which is the one this cannot promise.
   */
  const carried = hop.carried ? ' **carried the value**' : '';

  const lines = [
    `${pad}- \`${cut(hop.service)}\` ${cut(hop.name)} \u00b7 ${ms}${status}${where}${failed}${carried}`,
  ];
  /*
   * The query string, printed. A span name is a *route* \u2014 `GET /invoices/:id`
   * \u2014 so the id, the filter and the page number are nowhere on the line unless
   * this is, and a query string is where a value most often travels in plain
   * sight. The stacktrace deliberately is not printed: it is kilobytes of
   * frames whose first line repeats the message already below, and cutting it
   * to a first line buys nothing. Where it does matter is the *search*, not the
   * display \u2014 see the report; that decision is not this file's.
   */
  if (query) lines.push(`${pad}  \u21b3 ?${cut(String(query).replace(/^\?/, ''))}`);
  if (hop.statement) lines.push(`${pad}  \u21b3 \`${cut(hop.statement)}\``);
  if (hop.exceptionMessage) {
    lines.push(`${pad}  \u21b3 ${cut(hop.exceptionType ?? 'error')}: ${cut(hop.exceptionMessage)}`);
  } else if (hop.failed && hop.statusMessage) {
    lines.push(`${pad}  \u21b3 ${cut(hop.statusMessage)}`);
  }
  return lines;
}

/** One whole span tree as indented lines \u2014 `get_backend_trace`'s half of `spanLines`. */
function flattenSpanLines(roots) {
  const lines = [];
  const walk = (node) => {
    const span = node.span;
    lines.push(
      ...spanLines(
        {
          depth: node.depth,
          service: span.service,
          name: span.name,
          durationMs: span.durationMs,
          failed: span.failed,
          file: span.code?.file ?? null,
          line: span.code?.line ?? null,
          statement: span.db?.statement ?? null,
          status: span.http?.status ?? null,
          query: span.http?.query ?? null,
          exceptionType: span.exception?.type ?? null,
          exceptionMessage: span.exception?.message ?? null,
          statusMessage: span.statusMessage,
          carried: false,
        },
        '',
        SPAN_LINE,
      ),
    );
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return lines.join('\n');
}

/**
 * Cross a recording's trace ids against the spans already held, and write what
 * joins.
 *
 * Runs at flow ingest rather than at span ingest because that is the order the
 * two actually arrive in: a backend exports within seconds of the request and
 * the user presses Send when they are ready, so at span time there is usually
 * no recording to join to yet. Re-sending a recording is therefore how a trace
 * that arrived late gets joined at all — the same property `changed_in` has,
 * and for the same reason.
 */
function ingestSpansFor(flow, flowId, git) {
  const calls = tracedCallsOf(flow);
  if (!calls.length) return;

  const spans = otelTry('read held spans', (o) => o.spansForTraces(calls.map((c) => c.traceId)), []);
  if (!spans || !spans.length) return;

  const { joined } = joinTrace({ calls, spans });
  for (const join of joined) {
    arkgTry('trace ingest', (a) => a.ingestTrace(projectTrace(join), flowId, joinableSha(git)));
  }
}

/**
 * The directory a commit is read out of, or null when there is not one to speak
 * for.
 *
 * The same answer `get_source_snippet` reaches for, and null in the same case
 * and for a sharper reason: a remote deployment's working directory is a
 * container somebody built, and stamping a recording with *its* HEAD would
 * label every flow in the database with a commit that has nothing to do with
 * the caller's project. A wrong SHA is worse than no SHA everywhere in this
 * feature, and nowhere more than here.
 *
 * A function rather than a constant because `PROJECT_ROOT_ENV` is declared
 * beside the tool that needed it first, several hundred lines below.
 */
function gitRoot() {
  return REMOTE ? PROJECT_ROOT_ENV : (PROJECT_ROOT_ENV ?? process.cwd());
}

/** Said once, not once per recording: the answer does not change between flows. */
let loggedNoCommit = null;

/**
 * What commit to stamp the arriving recording with.
 *
 * The extension has no filesystem and no repository, so this is the only place
 * the answer can come from and the stamp is added here rather than carried on
 * the wire. What it means is narrower than "the build that was running" —
 * `core/git`'s header has the whole of that argument, and `commitCaveats` is
 * how every renderer says which of the two situations it is looking at.
 */
async function readStamp() {
  const root = gitRoot();
  const state = await gitTry('read checkout', (g) => g.readCheckout(root), {
    known: false,
    reason: 'failed',
  });

  if (state.known) {
    loggedNoCommit = null;
    return state.checkout;
  }

  if (loggedNoCommit !== state.reason) {
    loggedNoCommit = state.reason;
    log(`no commit stamp (${state.reason}) — recordings are saved without one`);
  }
  return null;
}

/** The stamp a flow stores, from a checkout. Null all the way through when there is none. */
const stampOf = (checkout) => (checkout ? flowCommit(checkout) : null);

/**
 * A commit's changed files, remembered.
 *
 * The list for a given SHA cannot change, and the alternative is a subprocess
 * on every recording made during one afternoon at one commit — which is what an
 * afternoon of recording is.
 */
const commitFiles = new Map();
const COMMIT_FILE_CACHE = 32;

/**
 * The commit node and its `changed_in` edges, after the flow that created the
 * source file nodes they point at.
 *
 * Runs for a dirty tree as well as a clean one, and that is not an oversight:
 * the commit is real and the files it changed are real whatever the working
 * tree has on top of them. It is only the `git_sha` *column* that a dirty tree
 * keeps out, because that column is a join key — see `core/git`.
 */
async function ingestCheckoutCommit(checkout) {
  if (!checkout || !arkg) return;

  const { sha } = checkout.commit;
  let files = commitFiles.get(sha);
  if (files === undefined) {
    files = (await gitTry('commit files', (g) => g.commitFiles(gitRoot(), sha), null)) ?? [];
    if (commitFiles.size >= COMMIT_FILE_CACHE) commitFiles.delete(commitFiles.keys().next().value);
    commitFiles.set(sha, files);
  }

  arkgTry('commit ingest', (a) => a.ingestCommit(checkout.commit, files, checkout.prefix));
}

// ── Flow shape ─────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

/** A directory name is a path segment, and `id` arrives over HTTP and from tool args. */
function flowDir(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return path.join(FLOWS_DIR, id);
}

/**
 * Write via a sibling temp file and rename, so a reader never sees half a file.
 *
 * `rename` is atomic within a filesystem, and the temp file is a sibling so it
 * is always on the same one.
 */
async function writeAtomic(file, contents) {
  const temp = `${file}.tmp`;
  try {
    await fs.writeFile(temp, contents, 'utf8');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function truncate(value, limit) {
  if (typeof value !== 'string') return value;
  return value.length <= limit ? value : `${value.slice(0, limit)}… [${value.length} chars total]`;
}

/**
 * One body, cut the way the reader needs it.
 *
 * `truncate` alone is a slice, and a slice of a large JSON array is the failure
 * this codebase refuses everywhere else: 4,096 characters of a four-hundred-row
 * response ends mid-object and reads as a complete answer with nine rows in it.
 * `compactBody` replaces it with the shape instead — field names and types, and
 * the size it stood in for — which is both smaller and true.
 *
 * The extension compacts before it sends, so for a current flow this is a no-op.
 * It is here for the two cases where nothing compacted: a recording made before
 * that existed, and a POST from something that is not the extension.
 *
 * `diagnostic` keeps a failed call's body verbatim, because on a failed call the
 * body is the error and a schema of it is the error with every word removed.
 * `truncate` still runs afterwards as the backstop that bounds the result.
 */
function compactCall(body, meta, diagnostic, limit, bodies) {
  if (!body) return body;
  const compacted = compactBody(body, { ...meta, diagnostic }, bodies) ?? body;
  return truncate(compacted, limit);
}

/** The truncation flags the capture recorded beside a body, if any. */
const bodyMeta = (call, prefix) => ({
  truncated: call[`${prefix}BodyTruncated`],
  bytes: call[`${prefix}BodyBytes`],
});

/** A request that never landed, or landed badly. */
function failedCalls(step) {
  return (step.networkCalls ?? []).filter((call) => call.status === null || call.status >= 400);
}

function consoleErrors(step) {
  return (step.consoleLogs ?? []).filter((entry) => entry.level === 'error');
}

function countFailures(steps) {
  return steps.filter((step) => consoleErrors(step).length > 0 || failedCalls(step).length > 0)
    .length;
}

/**
 * Only ever a file this server named itself.
 *
 * `screenshotFile` is minted in `saveFlow` and joined onto the flow's own
 * directory here. A POST that supplied its own would be choosing the path this
 * function returns — and `path.join` resolves `..` happily, so `flow.md`,
 * `get_flow`'s `screenshotPath` and `get_flow_screenshots` would between them
 * name, print and base64 any file the server can read. The id is already
 * validated by `flowDir`; this is the other half of the same rule.
 *
 * Tier 3 — deliberately not configurable. It is the
 * path-traversal guard on a loopback port any visited page can reach.
 */
const SCREENSHOT_FILE = /^step-\d{2,}\.(png|jpg)$/;

/**
 * The sentence to say instead of "nothing failed", when nothing failed only
 * because the failures were never sent.
 *
 * The send dialog defaults to leaving console and network data on the machine,
 * so a recording made specifically to capture a 500 arrives with no networkCalls
 * at all. `countFailures` then honestly reports zero, and this tool told the
 * caller the run was clean — the single most misleading answer it could give,
 * to the question it exists to answer.
 */
function withheld(flow) {
  const missing = (flow.omitted ?? []).filter((section) => section === 'network' || section === 'logs');
  if (!missing.length) return null;

  const names = missing.map((section) => (section === 'network' ? 'network calls' : 'console logs'));
  return (
    `"${flow.name}" was sent without its ${names.join(' or ')}, so this tool cannot tell whether anything failed — ` +
    'it is not reporting a clean run. Re-send the flow from the DevFlow extension with those switches on.'
  );
}

function screenshotPath(dir, step) {
  if (!step.screenshotFile || !SCREENSHOT_FILE.test(step.screenshotFile)) return null;
  return path.join(dir, 'screenshots', step.screenshotFile);
}

/**
 * The component a step happened in, if the flow says so.
 *
 * The extension writes the id down at export time (`element.react.owner`)
 * precisely so this does not have to re-derive it: choosing between the twelve
 * components a click sits inside takes four preference tiers, and a server that
 * guessed differently would contradict the same flow's own markdown.
 */
function stepComponent(flow, step) {
  const owner = step.element?.react?.owner;
  return owner ? (flow.react?.components?.[owner] ?? null) : null;
}

/**
 * The feature component that one sits inside, if the flow says so.
 *
 * Written down by the extension beside the owner, and for the same reason: on an
 * app with a shared UI kit the owner is `Button`, correctly, and this is the
 * `CheckoutButton` that makes the step mean something.
 */
function stepEnclosing(flow, step) {
  const within = step.element?.react?.within;
  return within ? (flow.react?.components?.[within] ?? null) : null;
}

/**
 * Where a component was written, as one string.
 *
 * NOTE: this is text and only ever text. `source` came off a web page — it is
 * whatever that page's source map claimed — so it is never joined to a
 * directory, never opened, and never used to name a file on this machine.
 * Screenshots are named by index for the same reason.
 */


/** The one table, listing each component in the order the steps meet it. */
function componentTable(flow) {
  const components = flow.react?.components;
  if (!components) return [];

  const seen = new Set();
  const rows = [];

  for (const step of flow.steps) {
    for (const id of step.element?.react?.chain ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);

      const component = components[id];
      if (!component) continue;
      rows.push(
        `| ${component.name} | ${formatSource(component) ?? '—'} | ${component.detail ?? ''} |`,
      );
    }
  }

  return rows;
}

/**
 * Where a step's image lives, as the markdown should reference it.
 *
 * Absolute, because whoever reads this is running in some other project's
 * directory and has its own file tools.
 */
const imageFor = (dir, step) => screenshotPath(dir, step);

/**
 * The path of the step before `i`, so `📍` marks a real page change.
 *
 * A window that starts at step 40 still has to know what step 39's URL was, or
 * it opens with a page-change marker for a page that did not change.
 */
const pathBefore = (flow, i) => (i > 0 ? urlPath(flow.steps[i - 1].url) : '');

/**
 * The lines above the steps: the flow's own facts.
 *
 * Kept here rather than taken from `exportToMarkdown`'s header because this one
 * carries `errorCount`, which is a fact the server computes and the extension
 * does not have at export time.
 */
function headerLines(flow) {
  return [
    `# ${flow.name}`,
    '',
    `**Recorded:** ${new Date(flow.timestamp).toLocaleString()}  `,
    `**Steps:** ${flow.steps.length}  `,
    flow.startUrl ? `**Start URL:** ${flow.startUrl}  ` : null,
    flow.errorCount ? `**Steps with failures:** ${flow.errorCount}  ` : null,
    '',
    '---',
    '',
  ].filter((line) => line !== null);
}

/**
 * The whole flow as markdown, for `flow.md` on disk.
 *
 * Rendered by `core/export/markdown.ts` — the same function that renders the
 * Markdown export the extension downloads, so the file in a flow's directory and
 * the walkthrough a tool returns cannot disagree about what was recorded.
 */
function generateMarkdown(flow, dir) {
  return exportToMarkdown(flow.steps, {
    title: flow.name,
    images: { kind: 'file', names: flow.steps.map((step) => imageFor(dir, step)) },
    react: flow.react,
    // The same lines the walkthrough header prints, from the same function —
    // see `describeStamp`. The file on disk and the tool response describe one
    // recording one way.
    settings: describeStamp(flow.settings),
    /*
     * And the commit, for the same reason one line up: the file in a flow's
     * directory and the walkthrough a tool returns describe one recording one
     * way. The extension's own export has no commit to print — it has no
     * repository — so this is absent there and the header simply says less.
     */
    ...(flow.git ? { commit: describeCommit(flow.git) } : {}),
    limits: renderingFor(flow).limits,
  });
}

/**
 * The whole failure of a recording in one sentence.
 *
 * `errorCount` says three steps broke. It does not say they all broke the same
 * way, which is the difference between three bugs and one — and one is what it
 * usually is. A reader who learns "3 steps failed, all POST /v1/orders → 500,
 * first at step 7, in CartButton (src/components/Cart.tsx:34)" has often
 * finished the investigation before opening anything.
 *
 * Costs about forty tokens and is computed from data already in hand.
 */
function failureSummary(flow) {
  const failing = failingSteps(flow);

  if (!failing.length) return null;

  const messages = new Set();
  for (const { step } of failing) {
    for (const entry of consoleErrors(step)) messages.add(truncate(entry.args.join(' '), 120));
  }

  const first = failing[0];
  const parts = [`${failing.length} of ${flow.steps.length} steps failed`];

  const ranked = failedShapes(failing);
  if (ranked.length === 1) {
    // "all" only when it is genuinely all of them — a summary that overstates
    // its own certainty is worse than one that lists two shapes.
    parts.push(`all ${ranked[0][0]}`);
  } else if (ranked.length > 1) {
    parts.push(`${ranked.length} distinct failures, commonest ${ranked[0][0]} (×${ranked[0][1]})`);
  }

  if (!ranked.length && messages.size === 1) parts.push(`console: ${[...messages][0]}`);
  else if (!ranked.length && messages.size > 1) parts.push(`${messages.size} distinct console errors`);

  parts.push(`first at step ${first.number}`);

  const component = stepComponent(flow, first.step);
  if (component) {
    const where = formatSource(component);
    parts.push(where ? `in ${component.name} (${where})` : `in ${component.name}`);
  }

  return `${parts.join(', ')}.`;
}

/**
 * How a step reads when two recordings are being lined up against each other.
 *
 * The action text, not the selector: a working run and a broken one are the same
 * journey through the app, and what makes step 4 "the same step" in both is that
 * the user clicked the same thing — not that the DOM handed out the same class
 * names on both occasions.
 */
const stepSignature = (step) => `${step.type}:${(step.action ?? '').trim()}`;

/** `METHOD /path` — an endpoint, with the query string and host taken off. */
const callSignature = (call) => `${call.method || 'GET'} ${urlPath(call.url) || call.url}`;

/**
 * What is different between a run that worked and one that did not.
 *
 * A working/broken pair is the strongest evidence a bug report can carry, and
 * until now the only way to use one was to read both recordings in full and hold
 * them side by side — two flows through `get_flow` being exactly the payload
 * this server spent its effort learning not to send.
 *
 * The comparison is deliberately shallow. It answers "what does the broken run
 * do that the working one does not", which is nearly always a call that changed
 * status, a call that only one of them makes, or an error only one of them logs.
 * It does not try to explain the difference — that is the reader's job, and they
 * now have a paragraph to do it from instead of two recordings.
 *
 * `labels` exists because `compare_flows_across_deploys` puts two *builds* in
 * these two positions rather than a working run and a broken one, and a report
 * that called the newer build "the broken run" would be asserting something
 * nobody observed. The defaults are the exact strings this printed before the
 * parameter existed, so every existing caller reads identically.
 */
const RUN_LABELS = { working: 'the working run', broken: 'the broken run' };

function compareFlows(working, broken, labels = RUN_LABELS) {
  const lines = [];

  // ── the journey ──
  const workingSteps = working.steps.map(stepSignature);
  const brokenSteps = broken.steps.map(stepSignature);
  const shared = workingSteps.filter((sig, i) => brokenSteps[i] === sig).length;

  lines.push(
    `**Steps:** ${working.steps.length} in "${working.name}", ${broken.steps.length} in "${broken.name}"` +
      `; the first ${shared} match.`,
  );

  if (shared < Math.min(workingSteps.length, brokenSteps.length)) {
    // The first step that is not the same step in both runs. Often the whole
    // answer: the runs diverge because the app put a different thing on screen.
    lines.push(
      `**Diverges at step ${shared + 1}:** "${brokenSteps[shared] ?? '(broken run ends)'}" ` +
        `where ${labels.working} has "${workingSteps[shared] ?? '(working run ends)'}".`,
    );
  }

  // ── endpoints ──
  const statuses = (flow) => {
    const map = new Map();
    for (const step of flow.steps) {
      for (const call of step.networkCalls ?? []) {
        const key = callSignature(call);
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(call.status ?? 'no response');
      }
    }
    return map;
  };

  const before = statuses(working);
  const after = statuses(broken);

  const changed = [];
  const onlyBroken = [];
  for (const [key, codes] of after) {
    const was = before.get(key);
    if (!was) {
      onlyBroken.push(key);
      continue;
    }
    const from = [...was].join('/');
    const to = [...codes].join('/');
    if (from !== to) changed.push(`${key}: ${from} → ${to}`);
  }
  const onlyWorking = [...before.keys()].filter((key) => !after.has(key));

  if (changed.length) lines.push('', '**Same endpoint, different answer:**', ...changed.map((c) => `- ${c}`));
  if (onlyBroken.length)
    lines.push('', `**Only ${labels.broken} calls:**`, ...onlyBroken.map((c) => `- ${c}`));
  if (onlyWorking.length)
    lines.push('', `**Only ${labels.working} calls:**`, ...onlyWorking.map((c) => `- ${c}`));

  // ── console ──
  const messages = (flow) =>
    new Set(flow.steps.flatMap((step) => consoleErrors(step).map((e) => truncate(e.args.join(' '), 200))));

  const workingErrors = messages(working);
  const newErrors = [...messages(broken)].filter((message) => !workingErrors.has(message));
  if (newErrors.length) {
    lines.push('', `**Errors only ${labels.broken} logs:**`, ...newErrors.map((m) => `- ${m}`));
  }

  // ── where to look ──
  const firstBad = broken.steps.find(
    (step) => consoleErrors(step).length > 0 || failedCalls(step).length > 0,
  );
  const component = firstBad ? stepComponent(broken, firstBad) : null;
  if (component) {
    const where = formatSource(component);
    lines.push('', `**First failure is in** ${component.name}${where ? ` — ${where}` : ''}.`);
  }

  if (!changed.length && !onlyBroken.length && !newErrors.length) {
    lines.push(
      '',
      'No network or console difference between the two. Whatever went wrong left no ' +
        `evidence in either — compare the screenshots, or record ${labels.broken} again with ` +
        'network and console switched on.',
    );
  }

  return lines.join('\n');
}

/** Sections the extension can leave out of a send, in the order it names them. */
const OMITTABLE = ['images', 'network', 'logs', 'react'];

async function saveFlow(flow, git = null) {
  const dir = flowDir(flow.id);
  if (!dir) throw new Error(`Invalid flow id: ${flow.id}`);

  const omitted = Array.isArray(flow.omitted)
    ? OMITTABLE.filter((section) => flow.omitted.includes(section))
    : [];

  const screenshotsDir = path.join(dir, 'screenshots');
  await fs.mkdir(screenshotsDir, { recursive: true });

  // Images come off the steps and onto disk: a step's JSON is read into a
  // context window, and a base64 JPEG in the middle of it is pure waste.
  const staged = flow.steps.map((step, i) => {
    // `screenshotFile` is discarded with the images: it is this server's own
    // field, and a payload that arrives carrying one is not describing a
    // picture it sent — it is naming a path for `screenshotPath` to read back.
    const { screenshot, screenshotOriginal, screenshotFile: _claimed, ...rest } = step;
    // The annotated image, which carries a highlight around the element that
    // was clicked. The clean original is the fallback, not the preference —
    // knowing *which* button was pressed is most of a screenshot's value here.
    const dataUrl = screenshot || screenshotOriginal;
    if (!dataUrl || !dataUrl.startsWith('data:')) return { rest, pending: null };

    const ext = dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
    const screenshotFile = `step-${pad2(i + 1)}.${ext}`;
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    // Resolves to the name only if the bytes actually landed. A step labelled
    // with a file that is not on disk sends every later reader after it: the
    // markdown prints the path, `get_flow` returns it as `screenshotPath`, and
    // `get_flow_screenshots` skips it and answers with nothing at all — no
    // image, no error, no explanation.
    const pending = fs
      .writeFile(path.join(screenshotsDir, screenshotFile), Buffer.from(base64, 'base64'))
      .then(() => screenshotFile)
      .catch((error) => {
        log(`screenshot write failed for step ${i + 1}: ${error.message}`);
        return null;
      });
    return { rest, pending };
  });

  const stepsClean = await Promise.all(
    staged.map(async ({ rest, pending }) => {
      const screenshotFile = pending && (await pending);
      return screenshotFile ? { ...rest, screenshotFile } : rest;
    }),
  );

  const meta = {
    id: flow.id,
    name: flow.name,
    timestamp: flow.timestamp,
    stepCount: flow.steps.length,
    startUrl: flow.startUrl || flow.steps[0]?.url || null,
    // In the index so a caller can tell which recording is the broken one
    // without opening every flow.
    errorCount: countFailures(flow.steps),
    /*
     * How many things went wrong, as against how many steps had something go
     * wrong on them.
     *
     * `errorCount` counts steps, and always has — one step with six 500s and one
     * step with a single warning both read as 1, which is the difference between
     * a page that is failing constantly and a page that hiccupped. Renaming it
     * would break every `meta.json` already on disk and the wire format with it,
     * so the honest count is added beside it rather than swapped in. Absent on
     * flows saved before this, which is why nothing may assume it is there.
     */
    failureCount: flow.steps.reduce(
      (total, step) => total + consoleErrors(step).length + failedCalls(step).length,
      0,
    ),
    // What the sender chose not to hand over. Without this the server cannot
    // tell a recording where nothing failed from one whose console and network
    // data was never sent — and it reported both as "nothing failed", which is
    // the wrong answer to give someone debugging a failure.
    ...(omitted.length ? { omitted } : {}),
    /*
     * The settings the flow was made under — §6 of the configuration plan.
     *
     * Kept verbatim, and not validated against anything here: it is a sparse
     * set of the *sender's* overrides, and a server that dropped a key it did
     * not recognise would silently unlabel a flow recorded by a newer DevFlow
     * than itself, which `npx -y devflow-mcp-server` makes an ordinary situation
     * rather than a corner case. `describeStamp` prints what it can name and
     * prints the rest raw.
     *
     * In `meta.json` as well as `flow.json` because `list_flows` reads only the
     * index, and "recorded with screenshots off" is exactly the kind of thing a
     * caller wants before choosing which recording to open.
     */
    ...(flow.settings && typeof flow.settings === 'object' && !Array.isArray(flow.settings)
      ? { settings: flow.settings }
      : {}),
    /*
     * The commit the checkout was at when this arrived — see `core/git` for
     * what that claim is and is not.
     *
     * Added here rather than taken off `flow`, because the extension has no
     * repository to have known it from: a payload arriving with a `git` field
     * would be a page describing a checkout it cannot see, and this line
     * discards it by not reading it.
     *
     * Absent entirely when there is no commit, which is how a machine with no
     * git, a directory that is not a repository, and every recording made
     * before any of this existed all read — one shape, not three.
     *
     * In `meta.json` as well as `flow.json` because `list_flows` reads only the
     * index, and choosing the two recordings to compare across a deploy is
     * exactly a question asked of a list.
     */
    ...(git ? { git } : {}),
    schemaVersion: flow.schemaVersion ?? 1,
  };

  /*
   * Additive, and absent entirely when the page was not React — which is also
   * how every flow recorded before this existed reads. `state` is here on the
   * same terms, and so is `renders`: it is what tells `get_step_detail` apart
   * "renders were never sampled" from "nothing re-rendered", so a flow that
   * loses it here is answered for as a quiet app rather than an unread one.
   *
   * All three are listed by name rather than spread from `flow`, so a field the
   * sender invents cannot land in `flow.json` and be answered for. The cost of
   * that is the failure this line already had once: `state` was read by
   * `get_state_patch` and written by nobody, so every real recording arrived
   * with its stores intact and lost them here, and only a fixture that had
   * never been through this function could tell you otherwise. A reader added
   * without its line here is the same bug again — which is why the render part
   * is tested through a POST and not from a fixture written onto disk.
   */
  const data = {
    ...meta,
    steps: stepsClean,
    ...(flow.react ? { react: flow.react } : {}),
    ...(flow.state ? { state: flow.state } : {}),
    ...(flow.renders ? { renders: flow.renders } : {}),
    /*
     * The other three framework tables, on `react`'s terms exactly.
     *
     * These are the paragraph above's warning coming true rather than an
     * illustration of it: `stepParts` was taught to render them, this line was
     * not written, and every real recording arrived with its Vue components and
     * lost them here. A fixture written straight onto disk passed the whole
     * time. It was caught by driving the built extension against a real Vue
     * application and asking the server what it saw, which is the only place
     * the two halves meet.
     */
    ...(flow.vue ? { vue: flow.vue } : {}),
    ...(flow.svelte ? { svelte: flow.svelte } : {}),
    ...(flow.rsc ? { rsc: flow.rsc } : {}),
  };

  // Awaited, not fired and forgotten: the POST response tells the extension the
  // flow is readable, and a tool call can arrive immediately after it.
  //
  // Written to one side and renamed into place, because `writeFile` truncates
  // first: a disk that fills — or a re-send interrupted half way — used to
  // leave `flow.json` cut off mid-object where a complete one had been, and
  // `meta.json` still listed it. `list_flows` showed the flow, `get_flow` threw
  // in `JSON.parse` and answered "not found", pointing straight back at the
  // list that had just offered it. `meta.json` goes last for the same reason:
  // it is the file that makes a flow visible, so nothing is listed before it is
  // readable.
  await Promise.all([
    writeAtomic(path.join(dir, 'flow.json'), JSON.stringify(data, null, 2)),
    writeAtomic(path.join(dir, 'flow.md'), generateMarkdown(data, dir)),
  ]);
  await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta));

  return meta;
}

async function listAllFlows() {
  const entries = await fs.readdir(FLOWS_DIR, { withFileTypes: true }).catch(() => []);
  const metas = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          return JSON.parse(await fs.readFile(path.join(FLOWS_DIR, entry.name, 'meta.json'), 'utf8'));
        } catch {
          return null;
        }
      }),
  );
  return metas.filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * A flow that exists and cannot be read, as distinct from one that is missing.
 *
 * Every tool catches around `readFlow` and answers `notFound`, which for a flow
 * the reader can see in `list_flows` is a lie that sends them looking for a
 * recording they already have.
 */
class UnsupportedFlow extends Error {}

async function readFlow(id) {
  const dir = flowDir(id);
  if (!dir) throw new Error(`Invalid flow id: ${id}`);

  /*
   * `flow.md` is not read back.
   *
   * It is still written — it is the artifact a human opens in the flow's own
   * directory — but the walkthrough a tool returns is rendered from the JSON at
   * the moment it is asked for, because it may be a *window* onto the recording
   * rather than all of it. Reading a whole document off disk to serve nine steps
   * of it is the cost this file spent the rest of its effort removing.
   */
  const jsonRaw = await fs.readFile(path.join(dir, 'flow.json'), 'utf8');
  const json = JSON.parse(jsonRaw);

  /*
   * The version is checked on the way out as well as on the way in.
   *
   * The receiver refuses a POST it is too old to understand, which covers the
   * flow arriving — and covers nothing about the flow already on disk. The
   * directory outlives any one server: `npx -y devflow-mcp-server` resolves to
   * whatever npm has cached, a second checkout can run an older build against
   * the same `~/.devflow`, and a downgrade is one `npm install` away. In every
   * one of those an older server reads a newer flow, finds the fields it knows,
   * and answers questions about it with confidence — which is the one failure
   * this file spends the rest of its length refusing.
   */
  if (Number(json.schemaVersion ?? 1) > SUPPORTED_SCHEMA) {
    throw new UnsupportedFlow(
      `"${json.name ?? id}" was recorded in format v${json.schemaVersion}, and devflow-mcp-server ` +
        `${VERSION} understands up to v${SUPPORTED_SCHEMA}. Reading it would mean guessing at ` +
        `fields this build does not know. Update the server: npx -y devflow-mcp-server@latest`,
    );
  }

  return { dir, json };
}

/** Bytes on disk under one flow directory. */
async function dirBytes(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirBytes(full);
    } else {
      const stat = await fs.stat(full).catch(() => null);
      if (stat) total += stat.size;
    }
  }
  return total;
}

/**
 * Delete the oldest flows until the store is back inside its ceilings.
 *
 * Ordered by when the flow was *recorded*, which is what "oldest" means to the
 * person who made it — not by when it was last sent. That does mean re-sending
 * an old recording stores something that is immediately the oldest thing there,
 * which is exactly why `keepId` exists: whatever this save just wrote is never
 * a candidate, however old the recording behind it is.
 *
 * Runs after the save rather than before it, so a flow is never evicted to make
 * room for one that then fails to write.
 */
async function enforceRetention(keepId) {
  const names = await fs
    .readdir(FLOWS_DIR, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    .catch(() => []);

  const flows = [];
  const evicted = [];

  for (const name of names) {
    const dir = path.join(FLOWS_DIR, name);
    let meta = null;
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    } catch {
      // No readable meta: a save in flight, or one that died part way. Only the
      // second is safe to touch, and only age can tell them apart.
      if (name === keepId) continue;
      const stat = await fs.stat(dir).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > ORPHAN_GRACE_MS) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        evicted.push({ id: name, reason: 'unreadable' });
      }
      continue;
    }

    if (name === keepId) continue;
    flows.push({ id: name, dir, at: Number(meta.timestamp) || 0, bytes: await dirBytes(dir) });
  }

  // Newest first, so what falls off the end of the list is the oldest.
  flows.sort((a, b) => b.at - a.at);

  const keptBytes = keepId ? await dirBytes(path.join(FLOWS_DIR, keepId)) : 0;
  let count = keepId ? 1 : 0;
  let bytes = keptBytes;

  // Read here rather than at import, so a cap changed through `POST /config`
  // governs this sweep and not the one after the next restart.
  const { maxFlows, maxFlowBytes } = retention();

  for (const flow of flows) {
    count += 1;
    bytes += flow.bytes;
    if (count <= maxFlows && bytes <= maxFlowBytes) continue;

    await fs.rm(flow.dir, { recursive: true, force: true }).catch(() => {});
    evicted.push({ id: flow.id, reason: count > maxFlows ? 'count' : 'size' });
    count -= 1;
    bytes -= flow.bytes;
  }

  // Said out loud rather than done quietly: a store that silently drops the
  // oldest recording reads as one that lost it.
  for (const gone of evicted) log(`evicted "${gone.id}" (${gone.reason})`);

  /*
   * The graph ages out on the same sweep, and deliberately not on a timer of
   * its own. A second schedule is a second thing to be wrong about — one that
   * fires in a process nobody is talking to, deletes rows while a read is being
   * rendered, and keeps a stdio server that should be idle awake. This sweep
   * already runs exactly when there is new evidence to age the old against, and
   * a graph nothing is being added to has nothing worth pruning.
   */
  const pruned = arkgTry('prune', (a) => a.pruneOldObservations(ARKG_RETENTION_DAYS), 0);
  if (pruned) log(`knowledge graph: pruned ${pruned} node(s) older than ${ARKG_RETENTION_DAYS} days`);

  /*
   * And the waiting room, on the same sweep for the same reason — plus one of
   * its own. This is the only store here fed from off the machine, so it is the
   * only one whose growth is not paced by how much the user records. The cap in
   * `otel.js` is what actually bounds it; this is the sweep that collects what
   * the cap has already made unreachable.
   */
  const dropped = otelTry('prune spans', (o) => o.pruneSpanStore(), { removed: 0 });
  if (dropped?.removed) log(`spans: dropped ${dropped.removed} held span(s)`);

  return evicted.map((gone) => gone.id);
}

// ── HTTP receiver (extension → server, and SSE MCP when remote) ────────────

const sseTransports = {};

/**
 * Whether a write may come from this caller.
 *
 * Any page the user happens to visit can reach a loopback port, and CORS does
 * not stop the request being *made* — only the reply being read. A page that
 * posts here could overwrite a real recording with one it wrote itself, and
 * everything downstream then presents it to the reader as their own. Extension
 * origins only; a request with no `Origin` at all is a local tool like curl,
 * which is not a page and cannot be driven by a visited site.
 */
function extensionOrigin(req) {
  const origin = req.headers.origin;
  return !origin || /^(chrome|moz)-extension:\/\//.test(origin);
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'devflow-mcp',
        version: VERSION,
        mode: REMOTE ? 'remote' : 'local',
        flowsDir: FLOWS_DIR,
      }),
    );
    return;
  }

  if (REMOTE && req.method === 'GET' && req.url === '/mcp') {
    const transport = new SSEServerTransport('/mcp/message', res);
    sseTransports[transport.sessionId] = transport;
    res.on('close', () => delete sseTransports[transport.sessionId]);
    await mcpServer.connect(transport);
    return;
  }

  if (REMOTE && req.method === 'POST' && req.url?.startsWith('/mcp/message')) {
    const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
    const transport = sseTransports[sessionId];
    if (!transport) {
      res.writeHead(404);
      res.end();
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }

  /*
   * Deleting a flow in the extension has to reach the disk.
   *
   * `deleteFlow` cleared `chrome.storage` and never contacted the server, so a
   * recording the user deleted — perhaps *because* they noticed it captured a
   * session token in a response body — stayed in `~/.devflow/flows` and was
   * still handed to Claude by the very next `list_flows`. The row vanished and
   * the extension reported success, which is the worst version of not deleting
   * something.
   */
  if (req.method === 'DELETE' && req.url?.startsWith('/flows/')) {
    if (!extensionOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Flows may only be deleted by the DevFlow extension.' }));
      return;
    }

    const id = decodeURIComponent(req.url.slice('/flows/'.length));
    const dir = flowDir(id);
    if (!dir) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid flow id: ${id}` }));
      return;
    }

    try {
      // `force` so deleting a flow the server never received is a success, not
      // an error: the extension is the one saying it should be gone, and it has
      // no way to know whether this flow was ever sent.
      await fs.rm(dir, { recursive: true, force: true });
      log(`deleted "${id}"`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id }));
    } catch (error) {
      log(`error deleting flow: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  /*
   * The machine-wide settings channel — §3's second one, and the only path
   * `mcp.port`, `mcp.maxFlows` and `mcp.maxFlowBytes` have.
   *
   * The other MCP settings travel inside a flow, because each of them describes
   * one document a reader is about to be handed. These three describe the
   * installation: which port this process binds, and how much of this machine's
   * disk the recordings may take. A flow arriving from another browser profile,
   * or read a month after it was made, cannot sensibly carry an answer to them —
   * so they arrive here, and are kept in a file rather than in a recording.
   *
   * ## What bounds it
   *
   * This is a new unauthenticated endpoint on a loopback port that any page the
   * user visits can reach, so it gets the same treatment the receiver already
   * has, plus the two limits that are specific to writing a file.
   *
   *   - **Same caller rule.** `extensionOrigin`, exactly as `POST /flows` and
   *     `DELETE /flows/:id`. A visited page's `fetch` always carries an `Origin`,
   *     including a `no-cors` one, and no page can forge an extension origin —
   *     which is what makes the check worth anything. It is the same guard that
   *     already stands in front of a far more destructive endpoint.
   *   - **Its own ceiling.** `MAX_CONFIG_BYTES`, three orders of magnitude below
   *     the flow cap, because a settings file is a few kilobytes and the body is
   *     read into memory before anything has vouched for it.
   *   - **One path, and no part of it comes from the request.** `CONFIG_FILE` is
   *     a module constant built from `HOME` at startup. Nothing in the body
   *     participates in it — not a key, not a value, not a header — so there is
   *     no traversal to guard against rather than a guard to get right. That is
   *     deliberate and it is the whole answer: the `SCREENSHOT_FILE` regex
   *     exists because a *flow* names files this server then opens, and the
   *     lesson taken from it here is not to accept a name at all.
   *   - **Three keys.** The body is filtered to the fields the extension's own
   *     table marks `machine: true`. Everything else in it is reported back and
   *     dropped — those settings already have a channel, and promoting one to
   *     machine-wide would silently overrule every recording this machine reads,
   *     including flows from browsers that never asked. It also means the worst
   *     a caller who gets past the origin check can do is name a port for the
   *     next restart and move two retention caps, both of which are clamped to
   *     the range the Settings screen offers, by the Settings screen's own
   *     `resolve`.
   *
   * ## What it writes
   *
   * The body is the *whole* machine-wide half of the user's overrides, sparse:
   * a key that is absent is a key they have reset, and it is removed from the
   * file rather than left at whatever was sent last. Every other key already in
   * the file is preserved untouched — including keys this build has never heard
   * of, per §5, and including the `mcp.*` rendering keys somebody may have set
   * by hand.
   *
   * A file that cannot be parsed is not overwritten. The server is already
   * ignoring it and saying so on stderr; replacing it here would throw away
   * text a person wrote, to fix a problem they can see and this cannot.
   */
  if (req.method === 'POST' && req.url === '/config') {
    // Remote mode listens on 0.0.0.0, where "no Origin" is a stranger rather
    // than a local curl — and a deployment's port and disk budget are the
    // launcher's business anyway. Refused before the body is read.
    if (REMOTE) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'This server is running in remote mode. Machine-wide settings there come from ' +
            'the environment it was launched with (DEVFLOW_PORT, DEVFLOW_MAX_FLOWS, DEVFLOW_MAX_BYTES).',
        }),
      );
      return;
    }

    if (!extensionOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Settings may only be posted by the DevFlow extension.' }));
      return;
    }

    try {
      let body = '';
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_CONFIG_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `A settings file may not exceed ${MAX_CONFIG_BYTES} bytes.`,
            }),
          );
          req.destroy();
          return;
        }
        body += chunk;
      }

      let sent;
      try {
        sent = JSON.parse(body);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Not valid JSON: ${error.message}` }));
        return;
      }

      if (!sent || typeof sent !== 'object' || Array.isArray(sent)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected a settings object of flat dotted keys.' }));
        return;
      }

      const existing = await readConfigFile();
      if (!existing.ok) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `${existing.problem}. Fix it or remove it, and this will write it again.`,
          }),
        );
        return;
      }

      // Null-prototype, because the keys being copied through came out of a
      // file: `__proto__` is an own property on a parsed object and a plain
      // assignment of it to an ordinary object would reach the prototype
      // setter instead of the file.
      const next = Object.create(null);
      for (const [key, value] of Object.entries(existing.value)) {
        if (!MACHINE_KEYS.includes(key)) next[key] = value;
      }

      const applied = {};
      const ignored = [];
      for (const [key, value] of Object.entries(sent)) {
        if (!MACHINE_KEYS.includes(key)) {
          ignored.push(key);
          continue;
        }
        next[key] = value;
        applied[key] = value;
      }

      await writeAtomic(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
      applyMachineSettings(await readConfig());

      // What the file now says, and what this process is actually doing about
      // it — which are two different things for exactly one setting.
      const effective = {};
      for (const key of MACHINE_KEYS) effective[key] = MACHINE_RESOLVED[key];

      /*
       * A setting that was stored and will nonetheless never be used, because
       * the environment names it too and the environment is the last word.
       *
       * Reported for the same reason a clamp is announced: the write succeeded,
       * the file says what the user asked for, and the value in force is
       * somebody else's. Without this the Settings screen would report success
       * and be wrong in the one way this mechanism exists to prevent — and the
       * user would have no way to find out, because the variable is set on a
       * process they did not start.
       */
      const fromEnv = envOverrides();
      const overridden = Object.keys(applied)
        .filter((key) => Object.hasOwn(fromEnv, key))
        .map((key) => ({
          key,
          by: Object.keys(ENV_SETTINGS).find((name) => ENV_SETTINGS[name] === key),
          using: MACHINE_RESOLVED[key],
        }));

      const restart =
        MACHINE_RESOLVED['mcp.port'] === HTTP_PORT
          ? null
          : `This server is listening on ${HTTP_PORT} and cannot move a socket it has already bound. ` +
            `It will use ${MACHINE_RESOLVED['mcp.port']} when it next starts.`;

      const named = Object.keys(applied);
      log(
        `config.json written — ${named.length ? named.join(', ') : 'no machine-wide settings'}` +
          `${ignored.length ? ` (ignored ${ignored.join(', ')})` : ''}`,
      );
      if (restart) log(restart);

      for (const beaten of overridden) {
        log(`${beaten.key} is set in this server's environment (${beaten.by}), which wins — using ${beaten.using}`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, file: CONFIG_FILE, applied, effective, ignored, overridden, restart }),
      );
    } catch (error) {
      log(`error writing config: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/flows') {
    if (!extensionOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Flows may only be posted by the DevFlow extension.' }));
      return;
    }

    try {
      let body = '';
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        // Read before anything has vouched for it, so it needs its own ceiling:
        // an unbounded concatenation is a page away from exhausting the heap of
        // the process the user's Claude session depends on.
        if (bytes > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Flow too large.' }));
          req.destroy();
          return;
        }
        body += chunk;
      }
      const flow = JSON.parse(body);

      if (!flow.id || !Array.isArray(flow.steps)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields: id, steps' }));
        return;
      }

      // The version is the only thing that tells this server which shape it has
      // been handed, and the two sides ship separately — so a server older than
      // the extension must say so rather than store a flow it will misread and
      // then answer questions about with confidence.
      if (Number(flow.schemaVersion ?? 1) > SUPPORTED_SCHEMA) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error:
              `This flow uses format v${flow.schemaVersion}, and devflow-mcp-server ${VERSION} understands ` +
              `up to v${SUPPORTED_SCHEMA}. Update the server: npx -y devflow-mcp-server@latest`,
          }),
        );
        return;
      }

      /*
       * Read before the save so both halves of the ingest see one reading, and
       * not once each: a recording that landed in `flow.json` at one commit and
       * in the graph at another would be two answers to one question, and the
       * window is real — `git status` on a large repository is not instant.
       */
      const checkout = await readStamp();
      const git = stampOf(checkout);

      const meta = await saveFlow(flow, git);
      log(
        `saved "${meta.name}" — ${meta.stepCount} steps, ${meta.errorCount} with failures` +
          (git ? ` at ${git.short}${git.dirty ? ' (dirty)' : ''}` : ''),
      );

      /*
       * Into the graph here rather than from the extension, and that is the
       * whole reason there is no `/arkg/ingest` endpoint beside this one: the
       * flow is already in this process, already parsed, already vouched for by
       * the two checks above. A second POST carrying the same megabytes would
       * be a second chance to disagree about what was recorded.
       *
       * It cannot fail the send. The recording is on disk and readable, which
       * is the contract this endpoint answers for; an index over it that did not
       * get built is a worse answer to a later question, not a lost recording,
       * and an extension told the save failed would retry and store a second
       * copy.
       */
      const accumulated = arkgTry('flow ingest', (a) => a.ingestFlow(flow, git), false);

      /*
       * After the flow, and gated on the same answer.
       *
       * After, because `changed_in` joins a commit to a source file node and the
       * flow is what creates those. Gated, because a re-send of an unchanged
       * recording writes no `git_sha` — see `ingestFlow` — and a commit node
       * filed for a stamp nobody wrote is a commit the graph claims to have
       * observed something at and did not.
       *
       * Guarded like every other graph call and for the same reason: a commit
       * node that did not get written is a worse answer to a later question,
       * not a lost recording.
       */
      if (accumulated) await ingestCheckoutCommit(checkout);

      /*
       * And the backend half, gated on the same answer and after the flow for
       * the same reason `changed_in` is: the `calls` edge this draws lands on
       * the `api_endpoint` node `ingestFlow` has just created, and an edge is
       * only admissible when both its ends are already nodes the graph keys.
       */
      if (accumulated) ingestSpansFor(flow, meta.id, git);

      // Never allowed to fail the save: the flow is already on disk and readable,
      // and telling the extension otherwise would have it offer a retry that
      // stores a second copy.
      const evicted = await enforceRetention(meta.id).catch((error) => {
        log(`retention sweep failed: ${error.message}`);
        return [];
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          id: meta.id,
          name: meta.name,
          ...(evicted.length ? { evicted } : {}),
        }),
      );
    } catch (error) {
      log(`error saving flow: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  /*
   * Spans, from the far side of a request DevFlow watched leave the browser.
   *
   * `/v1/traces` is OTLP/HTTP's own path, so an exporter is configured by
   * pointing it here and changing nothing else about how it is written.
   *
   * ## Why this one is not behind `extensionOrigin`, and what is there instead
   *
   * Every other write on this port is, and the guard works because the sender
   * is the extension. This sender is the user's backend — a collector, or an
   * SDK inside their own service — which has no extension origin and cannot be
   * given one. The guard is not weakened here; it is unavailable, and pretending
   * otherwise would be a check that reads like a boundary and is not.
   *
   * What is available is three things, and they are the whole of it:
   *
   *   - **The user asked for this.** `DEVFLOW_OTEL=1`, off otherwise, which is
   *     the opposite default from `DEVFLOW_GIT` for the reason `otel.js`'s
   *     header gives.
   *   - **A trace id is 128 random bits.** A span can only ever attach itself
   *     to a recording that carries its trace id, so forging a join means
   *     guessing one. What is reachable without guessing is filling the store,
   *     and the store is capped.
   *   - **Nothing here is executed, resolved or spawned.** The body is JSON,
   *     every field is read by name in `core/otel`, and no string in it names a
   *     file this server opens.
   *
   * The response shape is OTLP's `ExportTraceServiceResponse`, because an
   * exporter parses the reply and retries on a shape it does not recognise.
   */
  /*
   * A production crash, relayed here.
   *
   * ## Sentry cannot reach this port, and the design says so rather than
   * pretending otherwise
   *
   * This server binds to loopback. Sentry's servers can no more POST to it than
   * to any other machine behind a router, so this is not a direct integration:
   * it accepts a delivery somebody *relayed* (smee.io, an ngrok tunnel, a small
   * forwarder) or *replayed* (an exported event, curled in). That is the fourth
   * time a roadmap signature has assumed a caller could address something it
   * cannot, and it is recorded in the roadmap as a habit rather than as an
   * incident.
   *
   * ## Off unless asked for, and for a stronger reason than the span receiver
   *
   * DEVFLOW_WEBHOOKS=1, the shape DEVFLOW_OTEL uses. The argument is sharper
   * here: a span is the user's own backend describing its own work, while this
   * is a payload holding somebody else's *users'* data. Nothing is ingested by
   * default and what is ingested is a narrow allow-list -- see
   * `core/telemetry`, which reads the shape of the failure and its filenames
   * and reads no user, request, cookie, breadcrumb, context or exception value
   * at all.
   *
   * ## The guards are the receiver's own
   *
   * `extensionOrigin` as every other write here, so a page the browser has open
   * cannot post a crash into the graph; its own byte ceiling, because the body
   * is read into memory before anything has vouched for it; and the payload is
   * never handed on as it arrived -- every field is read out by key.
   */
  if (req.method === 'POST' && req.url === '/webhooks/sentry') {
    if (process.env.DEVFLOW_WEBHOOKS !== '1') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'Production error ingest is off. Start the DevFlow MCP server with DEVFLOW_WEBHOOKS=1 to ' +
            'accept relayed crash reports.',
        }),
      );
      return;
    }
    if (!extensionOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'This endpoint is not reachable from a web page.' }));
      return;
    }

    try {
      let body = '';
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_WEBHOOK_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `A crash delivery may not exceed ${MAX_WEBHOOK_BYTES} bytes.` }));
          req.destroy();
          return;
        }
        body += chunk;
      }

      const parsed = parseSentryDelivery(body);
      if (!parsed.ok) {
        /*
         * The reason travels. A relay that is working and a relay that is
         * misconfigured both produce "nothing arrived in the graph", and the
         * only thing that tells them apart is this sentence.
         */
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: parsed.detail, reason: parsed.reason }));
        return;
      }

      const edges = arkgTry('production error', (graph) => graph.ingestProductionError(parsed.error), 0) ?? 0;
      log(`production error ${parsed.error.id} (${parsed.error.type}), ${edges} file edge(s)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: parsed.error.id, files: edges }));
    } catch (error) {
      log(`error receiving crash: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/traces') {
    if (!otelmod || !otelmod.OTEL_ENABLED) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'Span ingest is off. Start the DevFlow MCP server with DEVFLOW_OTEL=1 to accept OTLP traces.',
        }),
      );
      return;
    }

    try {
      let body = '';
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_SPAN_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: `A span delivery may not exceed ${MAX_SPAN_BYTES} bytes.` }),
          );
          req.destroy();
          return;
        }
        body += chunk;
      }

      const answer = otelTry(
        'ingest delivery',
        (o) => o.handleOtlpPost(body, req.headers['content-type'] ?? ''),
        { status: 503, body: { error: 'Span ingest is unavailable.' } },
      );
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    } catch (error) {
      log(`error receiving spans: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  /*
   * One component pick, on its way into the graph.
   *
   * The panel resolves a component the moment somebody clicks one, and that is
   * evidence no flow will ever carry: most picks are made while reading code,
   * not while recording. Without this the graph knows only the components that
   * happened to appear in a recording somebody pressed Send on.
   *
   * ## What bounds it
   *
   * Another unauthenticated write on a loopback port that any page the user has
   * open can reach, so it gets the receiver's guards — the same ones, for the
   * same reasons, not by imitation:
   *
   *   - **Same caller rule.** `extensionOrigin`, as `POST /flows`, `POST
   *     /config` and `DELETE /flows/:id`. A visited page's `fetch` always
   *     carries an `Origin`, including a `no-cors` one, and no page can forge an
   *     extension origin.
   *   - **Its own ceiling.** `MAX_PICK_BYTES`, because the body is read into
   *     memory before anything has vouched for it.
   *   - **Four fields, taken by name.** The body is not handed on as it
   *     arrived. `name` is required and everything else is read out of it one
   *     key at a time, so a caller cannot reach a column this endpoint has no
   *     business writing — and cannot key a row itself. `id` is dropped on
   *     purpose, and it is not the extension withholding one: the id a flow
   *     carries is a hash of the compiled function source, which lives in the
   *     page and is never sent here. A pick is identified the only way a pick
   *     can be — by its name and the file it was found in — and the graph joins
   *     that onto the node a flow made, or makes a provisional one for a flow
   *     to adopt later. Letting the sender name the node would only put a third
   *     identity beside those two.
   *
   * Nothing in the body names a file this server opens — the path travels as a
   * string into a column and is never resolved — so there is no traversal to
   * guard against rather than a guard to get right.
   */
  if (req.method === 'POST' && req.url === '/arkg/ingest-component') {
    if (!extensionOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'Component picks may only be posted by the DevFlow extension.' }),
      );
      return;
    }

    try {
      let body = '';
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_PICK_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: `A component pick may not exceed ${MAX_PICK_BYTES} bytes.` }),
          );
          req.destroy();
          return;
        }
        body += chunk;
      }

      let sent;
      try {
        sent = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'A component pick must be a JSON object.' }));
        return;
      }

      /*
       * A name, or nothing. The graph keys a picked component by its name and
       * the file it was found in; a body with no name would accumulate every
       * anonymous observation onto one node and skew every frequency beside it.
       */
      const name = typeof sent?.name === 'string' ? sent.name.trim() : '';
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: name' }));
        return;
      }

      const pick = {
        name: name.slice(0, 256),
        sourceFile: typeof sent.sourceFile === 'string' ? sent.sourceFile.slice(0, 1024) : null,
        sourceLine: Number.isInteger(sent.sourceLine) && sent.sourceLine > 0 ? sent.sourceLine : null,
        failed: sent.failed === true,
        // Only a plausible duration: this feeds a percentile, and one absurd
        // sample moves a p95 the anomaly detector then reports as a spike.
        ...(Number.isFinite(sent.timingMs) && sent.timingMs >= 0 && sent.timingMs <= 600_000
          ? { timingMs: sent.timingMs }
          : {}),
      };

      // 200 whether or not the graph took it, and `stored` says which. A pick
      // this server could not record is not a pick that failed: nobody is
      // waiting on it, and an extension told otherwise would retry a write that
      // has no reason to succeed the second time.
      // A pick is an observation like any other, so it carries the commit like
      // any other. `readCheckout` memoises for five seconds precisely because
      // this path runs once per click.
      const checkout = await readStamp();

      const stored = arkgTry('component ingest', (a) => {
        a.ingestComponentPick(pick, stampOf(checkout));
        return true;
      }) === true;

      // Unconditional here, unlike the flow path, because a pick always writes
      // its row and therefore always writes a stamp — and every `git_sha` in
      // the graph must have a commit node to point at.
      if (stored) await ingestCheckoutCommit(checkout);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stored }));
    } catch (error) {
      log(`error ingesting component pick: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  /*
   * `POST /architecture` — one reading of what is mounted on an open page.
   * Work Stream 3.3.
   *
   * Guarded and bounded exactly as its neighbours are:
   *
   *   - **Same caller rule.** `extensionOrigin`, as `POST /flows`, `POST
   *     /config` and `POST /arkg/ingest-component`. The port is loopback and
   *     unauthenticated, so this is what keeps a page the browser happens to
   *     have open from writing a map of an application it made up.
   *   - **Its own ceiling.** `MAX_ARCHITECTURE_BYTES`, because the body is read
   *     into memory before anything has vouched for it.
   *
   * What it does *not* do is write to the graph, and that is the decision worth
   * naming. Every other ingest here accumulates: a pick raises a frequency, a
   * flow adds edges. A reading must not, because it is a census of one moment
   * rather than an observation of behaviour, and folding it into the ARKG would
   * inflate exactly the numbers the graph exists to keep honest — a component
   * mounted on a page nobody interacted with would count as often "seen" as one
   * somebody exercised, and `get_anomalies` reads those counts.
   */
  if (req.method === 'POST' && req.url === '/architecture') {
    if (!extensionOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'Architecture readings may only be posted by the DevFlow extension.' }),
      );
      return;
    }

    try {
      let body = '';
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_ARCHITECTURE_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `An architecture reading may not exceed ${MAX_ARCHITECTURE_BYTES} bytes.`,
            }),
          );
          req.destroy();
          return;
        }
        body += chunk;
      }

      let sent;
      try {
        sent = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'An architecture reading must be a JSON object.' }));
        return;
      }

      /*
       * A URL and a time, or nothing.
       *
       * Both are load-bearing rather than descriptive. Without the URL there is
       * nothing to key the reading on and nothing to tell a reader which page
       * they are looking at; without `takenAt` there is no age, and a map with
       * no age is this feature's one way of being actively misleading — it would
       * present some past moment as the present.
       */
      const url = typeof sent?.url === 'string' ? sent.url.trim() : '';
      if (!url) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: url' }));
        return;
      }
      if (!Number.isFinite(sent?.takenAt)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Missing required field: takenAt. A reading with no age cannot be rendered honestly.',
          }),
        );
        return;
      }

      /*
       * Rebuilt through `buildArchitecture` rather than stored as it arrived.
       *
       * The extension already ran it, so this looks redundant and is not: the
       * body came off an unauthenticated loopback port, and running the same
       * pure builder over it is what guarantees the shape the renderer is about
       * to walk — every component named, every context subscribed to by
       * somebody, both lists ordered and capped. Trusting the sender's arrays
       * would mean the renderer is the first code to meet whatever was posted.
       */
      const snapshot = buildArchitecture(
        {
          url: url.slice(0, 2048),
          title: typeof sent.title === 'string' ? sent.title.slice(0, 200) : '',
          ...(typeof sent.reactVersion === 'string' ? { reactVersion: sent.reactVersion.slice(0, 32) } : {}),
          roots: Number.isInteger(sent.roots) && sent.roots >= 0 ? sent.roots : 0,
          capped: sent.capped === true,
          instances: Array.isArray(sent.components)
            ? sent.components.flatMap((component) =>
                // Back out of the collapse the sender already did, so one
                // builder produces every snapshot this server renders. An
                // instance count is the only thing that has to be reinstated;
                // everything else is per-component already.
                Array.from({ length: Math.min(Math.max(1, component?.instances ?? 1), 10_000) }, () => ({
                  id: String(component?.id ?? '').slice(0, 128),
                  name: String(component?.name ?? '').slice(0, 128),
                  depth: Number.isInteger(component?.depth) && component.depth >= 0 ? component.depth : 0,
                  ...(typeof component?.sourceFile === 'string'
                    ? { sourceFile: component.sourceFile.slice(0, 1024) }
                    : {}),
                  ...(Number.isInteger(component?.sourceLine) && component.sourceLine > 0
                    ? { sourceLine: component.sourceLine }
                    : {}),
                  contextIds: Array.isArray(component?.reads)
                    ? component.reads.slice(0, 64).map((id) => String(id).slice(0, 64))
                    : [],
                })),
              )
            : [],
          contexts: Array.isArray(sent.contexts)
            ? sent.contexts.slice(0, 64).map((context) => ({
                id: String(context?.id ?? '').slice(0, 64),
                label: String(context?.label ?? 'Context').slice(0, 60),
                kind: String(context?.kind ?? 'context').slice(0, 32),
              }))
            : [],
        },
        sent.takenAt,
      );

      rememberArchitecture(snapshot);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, components: snapshot.components.length }));
    } catch (error) {
      log(`error ingesting architecture reading: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

/*
 * Installed at user scope, this server runs once per Claude session — so opening
 * a second project means a second process reaching for the same port. The state
 * that matters is FLOWS_DIR, not the process: whichever instance owns the port
 * receives flows, and every instance reads what it writes. So losing the race is
 * survivable, and only the process that wins listens.
 *
 * Remote mode has no such luxury — the port is how MCP itself is served there.
 */
httpServer.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && !REMOTE) {
    log(`port ${HTTP_PORT} already taken — another session is receiving. Serving from ${FLOWS_DIR}.`);
    return;
  }
  log(`HTTP server error: ${error.message}`);
  process.exit(1);
});

httpServer.listen(HTTP_PORT, REMOTE ? '0.0.0.0' : '127.0.0.1', () => {
  log(`listening on ${HTTP_PORT} (${REMOTE ? 'remote/SSE' : 'local/stdio'}) — flows in ${FLOWS_DIR}`);
});

// ── The drill-down tools ───────────────────────────────────────────────────

/*
 * `get_flow_summary`, `get_step_detail` and `get_source_snippet` are one
 * gesture in three sizes: is this the recording, which part of that step, what
 * does that line actually say. Everything above them answers a question about a
 * flow; the first of these answers whether there is a question worth asking,
 * and it is only useful if asking it of the wrong flow costs nothing.
 */

/**
 * A string cut to fit a column, rather than cut and annotated.
 *
 * `truncate` appends how many characters it removed, which is what a body wants
 * and the opposite of what a label wants: a 50-character label cut to 46 comes
 * back at 66 and takes the column it was cut to fit with it.
 */
const ellipsis = (value, max) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);

/** The ceiling `get_flow_summary` is named after, in estimated tokens. */
const SUMMARY_TOKENS = 400;

/** Steps that logged a console error or a failed request, with their numbers. */
function failingSteps(flow) {
  return flow.steps
    .map((step, i) => ({ step, number: i + 1 }))
    .filter(({ step }) => consoleErrors(step).length > 0 || failedCalls(step).length > 0);
}

/** `METHOD /path → status`, counted, commonest first. What broke, by shape. */
function failedShapes(failing) {
  const shapes = new Map();
  for (const { step } of failing) {
    for (const call of failedCalls(step)) {
      const key = `${call.method || 'GET'} ${urlPath(call.url) || call.url} → ${call.status ?? 'no response'}`;
      shapes.set(key, (shapes.get(key) ?? 0) + 1);
    }
  }
  return [...shapes.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * A flow in under 400 tokens: what it was, whether it broke, what to open next.
 *
 * The budget is a ceiling, not a target, and it is kept by dropping whole facts
 * rather than by cutting the text — a summary that ends mid-sentence is exactly
 * the silent truncation the rest of this file exists to refuse. So each optional
 * line is added only if the *finished* response still fits with it, which is
 * measured rather than estimated a piece at a time.
 *
 * Three things are never dropped: what the flow is, the verdict on it, and the
 * call to make next. A triage summary that says a recording broke without saying
 * how to look at the break has cost a call to save nothing.
 */
function flowSummary(flow) {
  const id = String(flow.id ?? '').slice(0, 128);
  const failing = failingSteps(flow);
  const host = flowHost(flow.steps);
  const total = flow.steps.length;

  const header =
    `${ellipsis(String(flow.name ?? ''), 80)} — ${id}\n` +
    `${day(flow.timestamp)} · ${total} step${total === 1 ? '' : 's'}${host ? ` · ${host}` : ''}`;

  const next = failing.length
    ? `Next: get_flow_errors({"id":"${id}"}) for the failures themselves · ` +
      `get_source_snippet({"id":"${id}","step":${failing[0].number}}) for the code behind the first one · ` +
      `get_flow({"id":"${id}"}) for the whole recording.`
    : `Next: get_flow({"id":"${id}"}) for the walkthrough · ` +
      `get_step_detail({"id":"${id}","step":1}) for one step, one part at a time.`;

  /*
   * Priced before anything optional is considered, because the verdict is the
   * one line whose length this function does not control: `failureSummary`
   * grows with the number of distinct failures, and `withheld` is a paragraph.
   */
  const reserved = estimateTokens(`${header}\n\n\n\n\n\n${next}`);

  /*
   * The withheld sentence outranks the failure count, and by some distance. A
   * recording sent without its network data has no failed calls to find, so
   * "nothing failed" is true of what arrived and false about what happened —
   * the most misleading answer this server can give, to the question this tool
   * exists to answer.
   */
  const verdict = truncate(
    withheld(flow) ??
      failureSummary(flow) ??
      'Nothing failed: no step logged a console error or a failed request.',
    Math.max(200, (SUMMARY_TOKENS - reserved - 8) * 4),
  );

  const optional = [];

  if (failing.length) {
    const shown = failing.slice(0, 12).map((entry) => entry.number);
    optional.push(
      `Steps that failed: ${shown.join(', ')}` +
        (failing.length > shown.length ? ` (+${failing.length - shown.length} more)` : ''),
    );
  }

  const ranked = failedShapes(failing);
  if (ranked.length) {
    const shown = ranked.slice(0, 3);
    optional.push(
      `Failed calls: ${shown.map(([shape, count]) => `${shape} ×${count}`).join(' · ')}` +
        (ranked.length > shown.length ? ` (+${ranked.length - shown.length} more)` : ''),
    );
  }

  /*
   * The components behind the failures first, then the rest of the journey. A
   * name and a file is what turns "something broke" into somewhere to look, and
   * on a flow that failed the component behind step 40 is worth more than the
   * component behind step 1.
   */
  const components = flow.react?.components ?? {};
  const seen = [];
  const add = (componentId) => {
    const component = componentId ? components[componentId] : null;
    if (!component || seen.some((other) => other.name === component.name)) return;
    seen.push(component);
  };
  for (const { step } of failing) {
    add(step.element?.react?.owner);
    add(step.element?.react?.within);
  }
  for (const step of flow.steps) add(step.element?.react?.owner);

  if (seen.length) {
    const shown = seen.slice(0, 5);
    optional.push(
      `Components: ${shown
        .map((component) => {
          const where = formatSource(component);
          return where ? `${component.name} ${where}` : component.name;
        })
        .join(' · ')}` + (seen.length > shown.length ? ` (+${seen.length - shown.length} more)` : ''),
    );
  }

  /*
   * Last, and it earns being last. The settings stamp is the longest line here
   * on a flow recorded with several switches moved, and it is the only one the
   * reader can get elsewhere for nothing — `get_flow`'s header repeats it. A
   * component and its file cannot be got anywhere cheaper, so on a recording
   * where only one of the two fits, this is the one that goes.
   */
  /*
   * Whether the accessibility audit ran, and only when it did.
   *
   * Deliberately silent when it did not, which is the default — a summary that
   * announced "accessibility was not audited" on every flow would be a line
   * nobody reads by the third recording, and `get_step_detail`'s a11y part is
   * where somebody who asked the question is told. When it *did* run, the count
   * is worth the line: a recording that audited and found nothing is a real
   * result and is otherwise indistinguishable from one that never looked.
   */
  const audit = flowA11y(flow.steps ?? [], Boolean(flow.settings?.['recording.a11y']));
  if (audit.read) {
    const violations = (flow.steps ?? []).reduce(
      (total, step) => total + (Array.isArray(step.a11y?.findings) ? step.a11y.findings.length : 0),
      0,
    );
    optional.push(
      violations
        ? `Accessibility: ${violations} violation${violations === 1 ? '' : 's'} across the recording` +
            `${audit.capped ? ', and at least one walk was capped' : ''} — get_step_detail part "a11y".`
        : `Accessibility: audited, nothing found${audit.capped ? ' in what was reached — a walk was capped' : ''}.`,
    );
  }

  const stamp = describeStamp(flow.settings);
  if (stamp.length) optional.push(`Recorded with non-default settings: ${stamp.join(' · ')}`);

  const assemble = (lines) =>
    [header, '', verdict, ...(lines.length ? ['', ...lines] : []), '', next].join('\n');

  // Each line gets first refusal in priority order, and a line that does not fit
  // does not stop a cheaper one behind it from fitting.
  const kept = [];
  for (const line of optional) {
    if (estimateTokens(assemble([...kept, line])) <= SUMMARY_TOKENS) kept.push(line);
  }

  return assemble(kept);
}

/**
 * The parts of a step, in the order `get_step_detail` lists them.
 *
 * `get_flow_step` returns all of it at once and is the right call when the step
 * is already known to be the answer. This split exists for the move before that
 * one: a step with three hundred network calls costs thousands of tokens to
 * look at whole, and the question is usually "what did it log", which is thirty.
 *
 * A part added later goes on the end. The order is what the index prints and
 * what the sections come back in, so moving an existing part renumbers a list
 * readers have already learned, to buy nothing.
 */
const STEP_PARTS = ['component', 'network', 'console', 'element', 'dom', 'screenshot', 'render', 'a11y'];

/**
 * How much of one changed value is worth printing before it stops being
 * evidence.
 *
 * Smaller than `STATE_VALUE_CHARS` because two of these share a line and
 * because the job is different: a patch operation is meant to be applicable and
 * this is meant to be read. Over the cap the value is replaced by a sketch of
 * its shape rather than sliced, for the reason `renderOp` gives — a value cut
 * mid-JSON reads as a whole value that is simply wrong.
 */
const RENDER_VALUE_CHARS = 120;

/** One side of one change: the value, its shape, or the fact that it has neither. */
function renderChangeSide(change, side) {
  if (!(side in change)) return null;

  const value = change[side];
  const encoded = JSON.stringify(value);
  // `undefined` does not encode, and a prop that went from a value to
  // `undefined` is one of the more common answers here.
  if (encoded === undefined) return String(value);
  return encoded.length <= RENDER_VALUE_CHARS ? encoded : `‹${sketchValue(value)}›`;
}

/**
 * One folded group of DOM mutations, on one line.
 *
 * `in` for a structural or text change and `on` for an attribute, because the
 * selector means two different things: a node was added *inside* that element,
 * and an attribute was written *on* it. Getting that wrong reads as a node
 * having been added to the button rather than to the list the button opened.
 *
 * Every field is treated as untrusted: a flow arrives over loopback from a page
 * the browser visited, and a `where` that is not a string is a reply that
 * crashes rather than one that says less.
 */
function domChangeLine(change, limit) {
  const kind = typeof change.kind === 'string' ? change.kind : 'changed';
  const where = typeof change.where === 'string' && change.where ? change.where : '(unknown)';
  const what = typeof change.what === 'string' && change.what ? change.what : '';
  const count = Number.isInteger(change.count) && change.count > 1 ? ` ×${change.count}` : '';
  const preposition = kind === 'attribute' ? 'on' : 'in';
  return `${kind}${count} ${preposition} ${truncate(where, limit)}${what ? `: ${truncate(what, limit)}` : ''}`;
}

/** `itemCount: 3 → 4`, or why there is no arrow. */
function renderChangeLine(entry) {
  /*
   * Anything that is not an object is read as a change with no sides, not
   * skipped and not trusted. Flows arrive over an unauthenticated loopback POST
   * from whatever page the browser is on, and `'before' in "nope"` is a
   * TypeError that takes the whole tool call down to save one line of output.
   */
  const change = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const key = typeof change.key === 'string' && change.key ? change.key : '(unnamed)';
  const before = renderChangeSide(change, 'before');
  const after = renderChangeSide(change, 'after');

  /*
   * Neither side is absent by accident: the contract says both are dropped when
   * the value was too large or too circular to snapshot at all. Printing
   * `undefined → undefined` for that would be a claim about the app made out of
   * a gap in the recording.
   */
  if (before === null && after === null) {
    return `${key}: changed — neither value could be sampled, too large or too circular`;
  }

  return `${key}: ${before ?? 'not sampled'} → ${after ?? 'not sampled'}`;
}

/**
 * Each part of one step, rendered once, with a one-line description of itself.
 *
 * Both halves come from here so the index cannot advertise a part differently
 * from the way the part reads when it is asked for, and so the cost quoted in
 * the index is the cost of the text the next call actually returns.
 */
function stepParts(flow, dir, step, render) {
  const origin = flowOrigin(flow);
  /*
   * An offset from the first step, signed. A network call can be captured a
   * moment *before* the step it is attributed to — the click is timestamped
   * when it is handled, the request when it left — so the delta is genuinely
   * negative sometimes, and `+-815ms` is not a time anybody can read.
   */
  const at = (timestamp) => {
    if (typeof origin !== 'number' || typeof timestamp !== 'number') return '';
    const delta = timestamp - origin;
    return ` ${delta < 0 ? '' : '+'}${delta}ms`;
  };

  const parts = {};

  // ── component ──
  {
    const owner = stepComponent(flow, step);
    const within = stepEnclosing(flow, step);
    const lines = [];

    if (owner) {
      const where = formatSource(owner);
      // The provenance only when it is the plugin's — see `sourceProvenance`.
      // A model reading this has to be able to see that an answer came out of a
      // build step in the application rather than out of DevFlow.
      const how = sourceProvenance(owner);
      lines.push(
        `${owner.name}${where ? `  ${where}` : ''}${how ? `  (${how})` : ''}` +
          `${owner.dependency ? '  (node_modules)' : ''}`,
      );
      if (owner.detail) lines.push(`  ${owner.detail}`);
      if (within) {
        const outer = formatSource(within);
        lines.push(`within ${within.name}${outer ? `  ${outer}` : ''}`);
      }
      const chain = step.element?.react?.chain ?? [];
      if (chain.length > 1) {
        const names = chain
          .map((componentId) => flow.react?.components?.[componentId]?.name)
          .filter(Boolean);
        if (names.length > 1) lines.push(`chain, outermost first: ${names.join(' › ')}`);
      }
    }

    /*
     * The other frameworks, read the same way and rendered by the same helper.
     *
     * `formatSource` takes a `ComponentSource`, and that is exactly what the
     * extension stores for a Vue, Svelte or RSC component — the conversion
     * happens once, in `core/locate/resolution.ts`, so nothing here needs a
     * second renderer or any knowledge of which runtime it is looking at. That
     * reuse is the whole reason the adapters were made to produce
     * `ComponentSource` rather than a shape of their own.
     *
     * No `within`: `stepEnclosing` is React's owner rule, and nothing
     * equivalent has been measured for these three. Printing one anyway would
     * be a confident attribution nobody checked.
     */
    for (const ref of step.element?.frameworks ?? []) {
      const table = flow[ref.framework]?.components ?? {};
      const named = (ref.chain ?? []).map((id) => table[id]).filter(Boolean);
      if (named.length === 0) continue;

      const [innermost] = named.slice(-1);
      const where = formatSource(innermost);
      lines.push(
        `${ref.framework}: ${innermost.name}${where ? `  ${where}` : ''}`,
      );
      if (innermost.detail) lines.push(`  ${innermost.detail}`);
      if (named.length > 1) {
        lines.push(
          `${ref.framework} chain, outermost first: ${named.map((c) => c.name).join(' › ')}`,
        );
      }
    }

    const otherFrameworks = (step.element?.frameworks ?? [])
      .map((ref) => ref.framework)
      .filter((name) => (flow[name]?.components ?? null) !== null);

    parts.component = {
      have: owner
        ? `${owner.name}${within ? ` within ${within.name}` : ''}`
        : otherFrameworks.length
          ? `no React component; read by ${otherFrameworks.join(', ')}`
          : flow.react?.detected
            ? 'no component attributed to this step'
            : 'this flow carries no React data',
      lines,
    };
  }

  // ── network ──
  {
    const calls = step.networkCalls ?? [];
    const failed = failedCalls(step);
    const lines = [];

    for (const call of calls) {
      const diagnostic = callFailed(call);
      /*
       * The trace id, on the call line, whether or not the call failed.
       *
       * A reader who asked for `network` on one step has already narrowed to
       * the place a trace id is worth its 32 characters — this is the drilled-in
       * view, not the walkthrough, so the budget argument that keeps it off a
       * healthy call in `core/export/markdown.ts` does not apply here. It is
       * absent on nearly every call, so the line is unchanged for nearly every
       * recording.
       *
       * `trace <id>` and nothing more: `describeTrace`'s full sentence lives in
       * `src/core/trace/index.ts`, which this package cannot reach — the MCP
       * bundle (`src/core/mcp-bundle.ts`) does not export it. Copying the
       * sentence here would be a second copy to drift; the short form is its
       * own opening words.
       */
      lines.push(
        `${call.method || 'GET'} ${call.url} → ${call.status ?? 'no response'} ` +
          `(${call.durationMs || 0}ms)${at(call.timestamp)}` +
          (call.traceId ? ` — trace ${call.traceId}` : ''),
      );
      const request = compactCall(
        call.requestBody,
        bodyMeta(call, 'request'),
        diagnostic,
        render.bodyLimit,
        render.limits,
      );
      const response = compactCall(
        call.responseBody,
        bodyMeta(call, 'response'),
        diagnostic,
        render.bodyLimit,
        render.limits,
      );
      if (request) lines.push(`  request:  ${request}`);
      if (response) lines.push(`  response: ${response}`);
    }

    parts.network = {
      have: calls.length
        ? `${calls.length} call${calls.length === 1 ? '' : 's'}${failed.length ? `, ${failed.length} failed` : ''}`
        : 'no network calls',
      lines,
    };
  }

  // ── console ──
  {
    const entries = step.consoleLogs ?? [];
    const cap = render.limits.consoleEntries;
    const shown = Number.isFinite(cap) && cap > 0 ? entries.slice(0, cap) : entries;
    const lines = shown.map(
      (entry) => `[${entry.level}]${at(entry.timestamp)} ${truncate(entry.args.join(' '), render.bodyLimit)}`,
    );
    if (entries.length > shown.length) {
      lines.push(`… ${entries.length - shown.length} more entries, above this flow's console cap`);
    }

    const errors = entries.filter((entry) => entry.level === 'error').length;
    parts.console = {
      // Every level, unlike the walkthrough: a reader who names this part is
      // asking what the page said, and a debug line is often what says it.
      have: entries.length
        ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}`
        : 'no console output',
      lines,
    };
  }

  // ── element ──
  {
    const element = step.element;
    const lines = [];
    if (element) {
      lines.push(`<${element.tag}>${element.role ? `  role=${element.role}` : ''}${element.type ? `  type=${element.type}` : ''}`);
      if (element.label) lines.push(`label: ${element.label}`);
      if (element.text) lines.push(`text: ${element.text}`);
      if (element.ariaLabel) lines.push(`aria-label: ${element.ariaLabel}`);
      lines.push(`selector: ${element.cssSelector}`);
      if (element.xpath) lines.push(`xpath: ${element.xpath}`);
      if (element.boundingBox) {
        const box = element.boundingBox;
        lines.push(`box: ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}`);
      }
      if (step.value !== undefined) lines.push(`value: ${truncate(String(step.value), render.bodyLimit)}`);
    }
    parts.element = {
      have: element ? element.cssSelector : 'this step has no element — it is a navigation or a note',
      lines,
    };
  }

  // ── dom ──
  {
    /*
     * Two observations of one step, in one part, because a reader asking what
     * the page did is asking one question.
     *
     * They are not two views of one fact and neither implies the other. The
     * delta is the *text* of the region around the element that was touched,
     * read twice; the changes are the *structure* of the whole document, folded
     * over the same window. A click that opens a banner in the page header has
     * nothing in the first and one line in the second, and a button whose label
     * became "Saving…" has the reverse.
     */
    const delta = step.domDelta;
    const shape =
      step.domChanges && typeof step.domChanges === 'object' && !Array.isArray(step.domChanges)
        ? step.domChanges
        : null;
    const changes = Array.isArray(shape?.changes)
      ? shape.changes.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      : [];
    const capped = shape?.capped === true;
    const more = Number.isInteger(shape?.more) && shape.more > 0 ? shape.more : 0;

    const lines = [];

    if (delta) {
      lines.push(`text before: ${truncate(delta.before, render.bodyLimit)}`);
      lines.push(`text after:  ${truncate(delta.after, render.bodyLimit)}`);
    }

    if (changes.length) {
      if (lines.length) lines.push('');
      for (const change of changes) lines.push(domChangeLine(change, render.bodyLimit));
    }

    if (more) {
      lines.push(
        `… ${more} more change${more === 1 ? '' : 's'} were observed and did not fit this ` +
          "flow's per-step budget. The budget is spent on structural changes first, then " +
          'text, then attributes, so what is missing is the least of what was seen.',
      );
    }

    /*
     * The cap is a statement about the observer and not about the page, and it
     * is said last so it qualifies everything above it. A step that lists three
     * changes under this listed three changes *before the observer stopped*.
     */
    if (capped) {
      lines.push(
        'The observer stopped early on this step — it reached "recording.domMutationCap" ' +
          'and disconnected — so anything that changed after that point was never seen. ' +
          'This is not a claim that nothing else changed.',
      );
    }

    if (!delta && !changes.length && !capped) {
      /*
       * "Nothing changed" and "nobody was looking" are different facts and the
       * step cannot tell them apart, so the reply names both rather than
       * letting the quieter one pass as the louder.
       */
      lines.push(
        'No change was recorded on this step. Either nothing in the page changed, or the ' +
          'text delta and the mutation observer were switched off when this flow was ' +
          'recorded — the header of get_flow says which settings were non-default.',
      );
    }

    /*
     * Shorter when there are two of them, because the index prints this in a
     * fixed-width column and truncates. The half that gets cut is the second,
     * which is the half that says this part holds more than one thing — so a
     * reader deciding whether to spend on it would be deciding against the
     * cheaper of the two answers without knowing the other was there.
     */
    const said = [];
    if (delta) said.push(changes.length ? 'a text change' : 'a text change around the element');
    if (changes.length) {
      said.push(`${changes.length} change${changes.length === 1 ? '' : 's'} in the page`);
    }
    if (!said.length && capped) said.push('nothing seen before the observer stopped');

    parts.dom = {
      have: said.length ? said.join(', ') : 'no DOM change recorded',
      lines,
    };
  }

  // ── screenshot ──
  {
    const file = screenshotPath(dir, step);
    parts.screenshot = {
      have: file ? path.basename(file) : (step.screenshotOmitted ?? 'no screenshot'),
      lines: file
        ? [file, 'Read that file directly — get_flow_screenshots is only for a reader that cannot.']
        : step.screenshotOmitted
          ? [step.screenshotOmitted]
          : [],
    };
  }

  // ── render ──
  {
    /*
     * The same three nothings `get_state_patch` is organised around, one part
     * further in. "Renders were never sampled", "the walk stopped short of the
     * whole tree" and "nothing re-rendered" arrive as the same empty list, and
     * the reader who cannot tell them apart takes the last one — which is the
     * only one of the three that is a statement about the application.
     *
     * Everything printed here is sampled from two readings of the fiber tree,
     * so it knows *which* components re-rendered and can never know how many
     * times any of them did. No line below counts renders, and the summary
     * counts components on purpose.
     */
    const capture = flow.renders;
    const shape = capture && typeof capture === 'object' && !Array.isArray(capture) ? capture : null;
    const note = shape && typeof shape.note === 'string' && shape.note ? shape.note : '';
    const noted = note ? [`The recording's own note: ${note}`] : [];
    const turnOn =
      'Switch "recording.renders" on in the extension\'s settings and record the journey again.';
    // Only the entries that are entries, for the reason `renderChangeLine`
    // gives: a `null` in this array would answer a question with a crash.
    const entries = (Array.isArray(step.renders) ? step.renders : []).filter(
      (entry) => entry && typeof entry === 'object' && !Array.isArray(entry),
    );

    if (!shape) {
      parts.render = {
        have: 'this recording carries no render data',
        lines: [
          'This flow was recorded by a build that did not sample renders at all, so this is the ' +
            'absence of data and not the absence of re-rendering. Nothing was looked at.',
          ...noted,
        ],
      };
    } else if (shape.read !== true) {
      parts.render = {
        have: 'render capture was off for this recording',
        lines: [
          'Render capture was switched off when this flow was recorded, or the page had no React ' +
            'and no fiber root to walk, so no component was compared at any point in it. This is ' +
            `the absence of data and not the absence of re-rendering. ${turnOn}`,
          ...noted,
        ],
      };
    } else if (!entries.length) {
      /*
       * The cap changes what an empty list means, so it changes the sentence.
       * Past the cap components were never compared, and "nothing re-rendered"
       * would be answering for a part of the tree nobody read.
       */
      parts.render = shape.capped === true
        ? {
            have: 'nothing re-rendered up to the walk\'s cap',
            lines: [
              'The walk hit its fiber cap on this recording ' +
                '("recording.renderNodeCap"), so components past it were never compared. No ' +
                'component re-rendered among the ones that were — which is a statement about the ' +
                'cap as much as about the app, and raising it is what turns this into an answer.',
              ...noted,
            ],
          }
        : {
            have: 'no component re-rendered',
            lines: [
              'Renders were sampled on this step and no component re-rendered. The comparison is ' +
                'two readings of the fiber tree, one when the interaction was dispatched and one ' +
                'after the app settled, so a component that re-rendered and settled back to the ' +
                'props it started with reads from here as one that did not render.',
              ...noted,
            ],
          };
    } else {
      const wasted = entries.filter((entry) => entry.wasted === true).length;
      const lines = [
        `${entries.length} component${entries.length === 1 ? '' : 's'} re-rendered across this step. ` +
          'Sampled from two readings of the fiber tree, so this says which components re-rendered ' +
          'and nothing about how often any of them did.',
      ];
      if (shape.capped === true) {
        lines.push(
          'The walk hit its fiber cap on this recording, so this is what was compared and not ' +
            'everything that re-rendered.',
        );
      }
      if (wasted) {
        lines.push(
          '"wasted" marks a component that re-rendered while nothing it was seen to depend on ' +
            'changed value — usually a parent handing down a fresh object holding the values it ' +
            'had already given.',
        );
      }

      for (const entry of entries) {
        const id = typeof entry.component === 'string' ? entry.component : '';
        const component = id ? flow.react?.components?.[id] : null;
        // The id rather than nothing when the flow does not list the component:
        // it is still the key every other tool here takes.
        const name = component?.name || id || 'an unnamed component';
        const where = component ? formatSource(component) : null;

        lines.push(
          `${name}${where ? `  ${where}` : ''}${entry.wasted === true ? '  — wasted' : ''}`,
        );
        for (const kind of ['props', 'hooks', 'contexts']) {
          const changes = Array.isArray(entry[kind]) ? entry[kind] : [];
          for (const change of changes) lines.push(`  ${kind.padEnd(9)}${renderChangeLine(change)}`);
        }
        /*
         * The changes the per-component cap kept back.
         *
         * Without this the list above reads as the whole of what changed, and a
         * component handed forty changed props looks like one handed eight —
         * which is the difference between a prop worth chasing and a parent
         * re-rendering wholesale. The recording counts them; showing eight and
         * letting a reader assume that was all of them is the silent half of a
         * budget.
         */
        const more = Number(entry.moreChanges);
        if (Number.isFinite(more) && more > 0) {
          lines.push(
            `  and ${more} more change${more === 1 ? '' : 's'} on this component, past ` +
              'the per-component budget ("recording.renderMaxChanges")',
          );
        }
        /*
         * Said per component and not once at the top: a cut value is why *this*
         * component's list is short, and the contract already refuses to call a
         * bounded component wasted for the same reason.
         */
        if (entry.bounded === true) {
          lines.push(
            '  bounded  a value was cut at a snapshot cap, so a change below the cut reads as no change',
          );
        }
      }

      parts.render = {
        have:
          `${entries.length} component${entries.length === 1 ? '' : 's'} re-rendered` +
          (wasted ? `, ${wasted} wasted` : ''),
        lines,
      };
    }
  }

  // ── a11y ──
  //
  // Always present, like every other part, because the index prices all of
  // them and a missing key is a crash rather than an empty row — which is
  // precisely how this first shipped and what `tests/mcp-step-detail.test.ts`
  // caught. The `have` sentence carries the distinction that matters most in
  // this part and in no other: "audited and clean" and "never looked at" are
  // different answers, and only the recording's own settings can tell them
  // apart, so the row says which one it is rather than printing a reassuring
  // blank.
  {
    const audit = step.a11y;
    const findings = Array.isArray(audit?.findings) ? audit.findings : [];
    const enabled = Boolean(flow.settings?.['recording.a11y']);

    if (!enabled) {
      parts.a11y = {
        have: 'not audited — the accessibility audit was off for this recording',
        lines: [
          'Accessibility was not audited while this flow was recorded. “Audit accessibility while ' +
            'recording” is off by default, so this says nothing about whether the page has ' +
            'violations — only that nobody looked.',
        ],
      };
    } else if (!findings.length && !audit?.note) {
      parts.a11y = {
        have: 'audited, nothing found',
        lines: ['The page as this step left it was audited and no violation was found in what was checked.'],
      };
    } else {
      /*
       * `core/a11y`'s renderer, not a second one here.
       *
       * This had its own copy of the grouping for exactly one commit, which is
       * the two-markdown-renderers mistake `src/core/mcp-bundle.ts` exists
       * because of: two renderers over one shape drift, and the one a *model*
       * reads is always the weaker of the two. What this side genuinely owns is
       * `where` — turning a component id into the name and file the recording
       * knows — because `core/` has no flow to resolve one against.
       */
      const renderable = findings.map((finding) => {
        const component =
          typeof finding.component === 'string' ? flow.react?.components?.[finding.component] : null;
        const source = component ? formatSource(component) : null;
        return {
          ...finding,
          ...(component ? { where: `in ${component.name}${source ? ` ${source}` : ''}` } : {}),
        };
      });

      const lines = renderA11y(renderable, audit?.note).split('\n');

      parts.a11y = {
        have: findings.length
          ? `${findings.length} accessibility violation${findings.length === 1 ? '' : 's'}`
          : 'nothing found, and something limited the audit',
        lines,
      };
    }
  }

  return parts;
}

/**
 * How much of the project root a source path may name, and where that root is.
 *
 * A component's `source` came off a web page — it is whatever that page's source
 * map claimed, and any page the browser visits can POST a flow to this server on
 * loopback. Everywhere else in this file that string is printed and never
 * opened. This tool is the one place it names a file, so it names one only
 * underneath a single directory, and only after `realpath` has been asked
 * whether a symlink leaves it.
 *
 * Claude Code launches this server with the project it is working in as the
 * working directory, which is the right answer for nearly every installation.
 * `DEVFLOW_PROJECT_ROOT` is for the ones where it is not, and it is an
 * environment variable rather than a `config.json` key on purpose: `POST /config`
 * is reachable by any page the browser visits, and a page that could move this
 * would be choosing which directory the next snippet is read out of.
 */
const PROJECT_ROOT_ENV = process.env.DEVFLOW_PROJECT_ROOT
  ? path.resolve(process.env.DEVFLOW_PROJECT_ROOT)
  : null;

/** Nothing this big is a source file, and reading it would be the whole point of not doing so. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** Lines either side of the target. Twelve is a function; a hundred is a file. */
const SNIPPET_RADIUS = 12;
const MAX_SNIPPET_RADIUS = 100;

/** `target` is somewhere strictly beneath `root` — not `root` itself, not beside it. */
function contained(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * One untrusted source path, resolved to a readable file under the project root.
 *
 * Returns a reason rather than throwing, because each of these is a different
 * thing to tell the reader and only one of them is "no such file": a path that
 * escapes the root is a recording made against another checkout, and a root that
 * does not exist is a misconfigured server.
 */
async function resolveSource(root, candidate) {
  const rootReal = await fs.realpath(root).catch(() => null);
  if (!rootReal) return { reason: 'no-root' };

  // `path.resolve` lets an absolute candidate win outright, which is exactly why
  // containment is judged on the result rather than on what was written.
  const target = path.resolve(rootReal, candidate);
  if (target === rootReal) return { reason: 'not-a-file', root: rootReal, what: 'the project root itself' };

  /*
   * Canonicalised before it is judged, and judged once.
   *
   * Both halves of that matter. Symlinks are the reason containment cannot be
   * decided on the written path — a link inside the root pointing out of it
   * passes any string comparison. But the root was canonicalised too, and
   * checking the written path *as well* refuses a candidate that is the same
   * file by another name: a source map that recorded `/tmp/app/src/X.tsx` under
   * a root that canonicalises to `/private/tmp/app` is the same file on every
   * macOS, and a second, weaker test that runs first can only ever refuse
   * something the real test would allow.
   */
  const real = await fs.realpath(target).catch(() => null);
  if (!real) {
    /*
     * Nothing to canonicalise, so the written path is all there is to judge —
     * and the two answers are not interchangeable. A path that climbs out of
     * the root is refused as an escape even when nothing is there, because the
     * reader's next move differs: one of them is "point me at the right root",
     * the other is "this checkout is not what was recorded".
     */
    return contained(rootReal, target)
      ? { reason: 'missing', root: rootReal, tried: target }
      : { reason: 'outside', root: rootReal };
  }
  if (!contained(rootReal, real)) return { reason: 'outside', root: rootReal };

  const stat = await fs.stat(real).catch(() => null);
  if (!stat) return { reason: 'missing', root: rootReal, tried: target };
  if (!stat.isFile()) return { reason: 'not-a-file', root: rootReal, what: 'a directory' };
  if (stat.size > MAX_SOURCE_BYTES) return { reason: 'too-big', root: rootReal, bytes: stat.size };

  return { file: real, root: rootReal };
}

// ── Replay ─────────────────────────────────────────────────────────────────

/*
 * `replay_flow`, and the one reading it must never produce.
 *
 * A replay answers "does this journey still work". A repair loop asks it after
 * a change and acts on the answer, so the failure that matters is not a replay
 * that fails — it is a replay that *did not happen* being reported as one that
 * passed. A runner that crashed before it loaded a spec prints a stack trace on
 * stdout and exits non-zero; a runner that matched no files prints a valid
 * report of nothing. Both are silence, and neither is a pass.
 *
 * `core/replay`'s `readRun` separates them and this prints the separation:
 * four outcomes, each with its own sentence, and the runner's own stderr
 * carried through on the two that are about the runner rather than the app.
 */

/** What the recording itself said broke, so a replay can be compared with it. */
function recordedFailures(steps) {
  const out = [];
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object') return;
    if (stepFailed(step)) out.push(stepNumberOf(step, index));
  });
  return out;
}

function renderReplay(flow, steps, spec, run, root) {
  // Which stream to read, and what a killed run means, are `core/replay`'s —
  // decisions, and decisions go where they can be exercised without a spawn.
  const verdict = readRun(run);

  const recorded = recordedFailures(steps);
  const lines = [
    `Replay of "${flow.name}" — ${verdict.status}`,
    `Spec: ${spec}`,
    `Run in ${root} with your project’s own Playwright.`,
    '',
  ];

  if (verdict.status === 'passed') {
    lines.push(`The journey completed. ${verdict.ran} test${verdict.ran === 1 ? '' : 's'} ran and none failed.`);
    if (recorded.length) {
      /*
       * The verification half of the loop, and the only comparison this tool
       * makes. It is a weak claim on purpose: the replay runs against recorded
       * response mocks, so what it proves is that the journey through the
       * interface completes, not that the bug is gone from the server.
       */
      lines.push(
        '',
        `The recording itself failed at step${recorded.length === 1 ? '' : 's'} ${recorded.join(', ')}, and this ` +
          'replay did not. That is evidence the journey now completes — and it is evidence about the ' +
          'interface only: the replay answers with the responses the recording captured, so a fault ' +
          'that lives in the server is mocked out of this run by construction.',
      );
    }
  } else if (verdict.status === 'failed') {
    lines.push(`${verdict.failures.length} of ${verdict.ran} test${verdict.ran === 1 ? '' : 's'} failed:`);
    for (const failure of verdict.failures) {
      lines.push(
        '',
        `  ${failure.title}`,
        `      ${failure.message}${failure.step ? `  (step ${failure.step})` : ''}`,
      );
    }
    if (recorded.length) {
      lines.push(
        '',
        `The recording failed at step${recorded.length === 1 ? '' : 's'} ${recorded.join(', ')}. Compare that ` +
          'with the steps above: the same step is the bug reproduced, a different one is the replay ' +
          'breaking somewhere else, and a selector that did not resolve is neither.',
      );
    }
  } else if (verdict.status === 'no-tests') {
    lines.push(
      'The runner ran and matched no test at all, so nothing was replayed. This is not a pass. ' +
        'Playwright’s own config usually restricts `testDir`, and a spec written outside it is ' +
        `invisible to it — the spec is at ${spec}.`,
    );
  } else {
    lines.push(
      'The runner produced nothing this server could read, so **the state of the journey is unknown**. ' +
        'It is deliberately not reported as a pass or a failure: a runner that crashed before it loaded ' +
        'anything looks exactly like a suite with no failures if you only count failures.',
    );
    if (verdict.note) lines.push('', `What came back instead: ${truncate(verdict.note, 400)}`);
  }

  if (run.timedOut) {
    lines.push(
      '',
      'The run hit its timeout and was killed. A replay still going after that is usually waiting on ' +
        'something that is not coming — a dev server that is not up, or a login the recorded mocks ' +
        'do not cover.',
    );
  }

  const stderr = String(run.stderr ?? '').trim();
  if (stderr && verdict.status !== 'passed') {
    lines.push('', 'The runner’s own error output:', truncate(stderr, 1200));
  }

  lines.push(
    '',
    'The spec is the same one the extension’s Playwright export writes, so it can be edited, kept and ' +
      'run without this server. get_flow_errors is what the recording said broke.',
  );
  return lines.join('\n');
}

// ── Diagnosis ──────────────────────────────────────────────────────────────

/*
 * `diagnose_failure`, and the claim it is careful not to make.
 *
 * `get_causal_chain` says what evidence links two events. A diagnosis is the
 * temptation to go one step further and say which link is *the fault*, and
 * nothing in a recording supports that: `attributed` is temporal containment,
 * `followed` is ordering, and a reply that ranked them into a cause would be
 * inventing the one thing a reader most wants and least ought to be handed.
 *
 * So this assembles and does not conclude. What it adds that no single
 * recording can is the last line of each entry: whether the thing that failed
 * has failed before. "This endpoint has failed twice in a hundred and forty
 * observations" and "this endpoint fails six times in ten" send a reader to two
 * different places, and only the accumulated graph knows which one is true.
 */
function renderDiagnosis(flow, diagnoses, limit) {
  const lines = [
    `What broke in "${flow.name}"`,
    '',
    'Assembled, not concluded. Each entry is what the recording says went wrong, the component it ' +
      'happened in, the evidence the causal walk found — with the basis each link rests on — and what ' +
      'the accumulated graph knows about the thing that failed. Nothing here names a cause: the ' +
      'evidence is what there is to argue with.',
  ];

  if (!diagnoses.length) {
    lines.push(
      '',
      'Nothing in this recording failed: no step logged a console error and no request came back ' +
        'failed or 4xx/5xx. That is a fact about the recording — a bug that produces no error and no ' +
        'failed request is invisible to this tool, and get_flow is where the journey itself is.',
    );
    return lines.join('\n');
  }

  for (const entry of diagnoses) {
    lines.push('', `  step ${entry.step}  ${entry.kind}  ${truncate(entry.what, 300)}`);

    if (entry.component) {
      const where = entry.component.source
        ? `${entry.component.source}${entry.component.line ? `:${entry.component.line}` : ''}`
        : '';
      lines.push(`      in ${entry.component.name}${where ? `  ${where}` : ''}`);
    }

    // Named, never scored — `core/causal`'s rule, carried through unchanged.
    if (entry.evidence.length) {
      lines.push('      what led to it, nearest first:');
      for (const link of entry.evidence) {
        lines.push(`        ${link.ref}  ${truncate(link.label, 120)}`);
        lines.push(`            ${link.basis} — ${truncate(link.detail, 240)}`);
      }
    } else {
      lines.push(
        '      nothing in this recording links to it, which is ordinary — an error with no failed ' +
          'request before it and no log naming one has no evidence to walk.',
      );
    }

    /*
     * The line this tool exists for. `unknown` is printed as loudly as the
     * other two: "we have never seen this fail" and "we have not seen it
     * enough to say" are the two answers the whole feature separates, and a
     * reader handed the second as the first goes looking for a regression that
     * may not exist.
     */
    lines.push(
      `      standing: ${entry.standing} — ${truncate(entry.standingDetail, 300)}`,
    );
    if (entry.history) {
      lines.push(
        `      the graph knows it as ${truncate(entry.history.label, 120)} ` +
          `(${entry.history.observations} observation${entry.history.observations === 1 ? '' : 's'}, ` +
          `${Math.round(entry.history.failureRate * 100)}% failed)`,
      );
    }
  }

  if (diagnoses.length === limit) {
    lines.push(
      '',
      `Stopped at ${limit}, which is what was asked for. Raise "limit" if the recording has more.`,
    );
  }

  lines.push(
    '',
    'get_causal_chain walks any ref above in full, get_source_snippet opens any file named, ' +
      'get_component_history is the whole of what the graph knows about a component, and replay_flow ' +
      'runs the journey again once you have changed something.',
  );
  return lines.join('\n');
}

// ── Actions ────────────────────────────────────────────────────────────────

/*
 * `suggest_actions`, and the word it is careful not to earn.
 *
 * The roadmap calls this a *synthetic* action generator. What ships is not
 * synthesis: every action offered was performed by a person and recorded, and
 * the module behind it folds and filters rather than invents. The v3.2.0
 * version invented — it returned hardcoded buttons, and took an ARKG argument it
 * never read — so the honest version takes no graph argument at all (the graph
 * holds no selectors and no element text, so it cannot contribute an action)
 * and says on every answer that nothing in it is made up.
 *
 * That is worth stating as a strength rather than as an apology. A selector
 * DevFlow watched resolve is worth more than one guessed from a component's
 * name, and the value somebody actually typed into a field is worth more than
 * "test@example.com".
 */
function renderActions(plan, args, flowsRead, flowsUnread) {
  const scope = [];
  if (typeof args.url === 'string' && args.url) scope.push(args.url);
  if (typeof args.component === 'string' && args.component) scope.push(`in ${args.component}`);

  const lines = [
    scope.length ? `Actions recorded ${scope.join(' ')}` : 'Actions recorded across every flow',
    '',
    'Every action below was performed by a person and recorded. Nothing here is invented — DevFlow has ' +
      'no model of your application, so it offers what has been done rather than what might work, and a ' +
      'control nobody has ever touched is not here. The selector is the one the recorder chose and it ' +
      'resolved at least once.',
  ];

  if (!plan.actions.length) {
    lines.push('', 'No recorded action matches.');
    if (plan.skipped.length) {
      // Which is the whole reason the skips are counted: "this page has no
      // recorded actions" and "you filtered them all out" are different
      // answers, and an empty list says neither on its own.
      lines.push('', 'What was there and did not qualify:');
      for (const skip of plan.skipped) {
        lines.push(`  ${skip.count} step${skip.count === 1 ? '' : 's'}  ${skip.reason}`);
      }
    }
    lines.push(
      '',
      `Read from the ${flowsRead} most recent recording${flowsRead === 1 ? '' : 's'}. list_flows shows what else is on disk.`,
    );
    return lines.join('\n');
  }

  lines.push('', `${plan.actions.length} action${plan.actions.length === 1 ? '' : 's'}, most-recorded first:`);

  for (const action of plan.actions) {
    const value = typeof action.value === 'string' ? `  = ${JSON.stringify(truncate(action.value, 60))}` : '';
    lines.push(
      '',
      `  ${action.kind}  ${action.label || '(no label)'}`,
      `      ${action.selector}${value}`,
      `      seen ${action.seen}× in ${action.flows.join(', ')}  ·  ${action.url}`,
    );
    if (action.fragile) {
      // Carried through from the export compiler's own selector hierarchy: a
      // fragile selector is one that resolved on the page as it was, and a
      // replay is being told it may not resolve again.
      lines.push('      the recorder marked this selector fragile — it may not resolve on a changed page');
    }
  }

  if (plan.more) {
    lines.push('', `${plan.more} further action${plan.more === 1 ? '' : 's'} were not listed. Raise "limit".`);
  }

  if (plan.skipped.length) {
    lines.push('', 'Not offered:');
    for (const skip of plan.skipped) {
      lines.push(`  ${skip.count} step${skip.count === 1 ? '' : 's'}  ${skip.reason}`);
    }
  }

  lines.push(
    '',
    `Read from the ${flowsRead} most recent recording${flowsRead === 1 ? '' : 's'}` +
      `${flowsUnread > 0 ? `, leaving ${flowsUnread} older one${flowsUnread === 1 ? '' : 's'} unread — something done only in those is not above` : ''}.`,
  );
  return lines.join('\n');
}

// ── The navigator ──────────────────────────────────────────────────────────

/*
 * `explain_feature`, and the sentence it exists to keep saying.
 *
 * The v3.2.0 attempt at this item was stopword-matching substring filtering
 * presented as understanding. What replaced it is still lexical matching —
 * names and paths are what the graph holds, so names and paths are what can be
 * matched — and the difference is that it says so, in the tool description and
 * at the top of every answer, and that each match carries the *reason* it
 * matched rather than a score.
 *
 * The second half is what makes it worth having: every match is expanded one
 * hop through the graph's own edges, which reach the endpoint a component calls
 * and the file it was written in whether or not those ever carried the word.
 * The lexical match is the entry point; the graph is why the entry point is
 * worth something. A grep gives line hits and stops.
 */

/** What each basis means, in the words the reader needs to judge the match. */
const BASIS_REASON = {
  'name-exact': 'its name is exactly your words',
  'name-word': 'your word is one of the words in its name',
  'name-part': 'your word is inside its name, but not a word of it — the weakest match here',
  'text-word': 'your word is one of the words in its path or label',
  'text-part': 'your word is inside its path or label as a fragment',
};

const KIND_TITLES = {
  component: 'component',
  endpoint: 'endpoint',
  file: 'file',
  flow: 'recorded flow',
  store: 'store',
  stateKey: 'state key',
};

/** `renders`, `calls`, `maps_to` — read out in the direction it was found. */
function neighbourLine(neighbour) {
  const failure =
    typeof neighbour.failureRate === 'number' && neighbour.failureRate > 0
      ? `, ${Math.round(neighbour.failureRate * 100)}% failed`
      : '';
  const seen = Number.isFinite(neighbour.frequency) ? `seen ${neighbour.frequency}×${failure}` : '';
  return `      ${neighbour.direction === 'out' ? '→' : '←'} ${neighbour.edge}  ${neighbour.label}${seen ? `  (${seen})` : ''}`;
}

function renderFeature(description, query, neighbours, corpus) {
  const lines = [
    `What "${description}" points at`,
    '',
    'Matched by name. DevFlow does not know what your description means — it cut it into words and ' +
      'looked for those words in the names and paths the graph holds. A name that carries the word ' +
      'matches whether or not it is relevant, and a part of the app that uses different words is not ' +
      'here at all.',
  ];

  if (query.terms.length) {
    lines.push('', `Searched for: ${query.terms.join(', ')}`);
  }
  if (query.dropped.length) {
    /*
     * Reported, never hidden. "Your words narrowed nothing" and "this app has
     * nothing by that name" are different answers, and a dropped list is the
     * only thing that separates them for a caller who wrote a sentence of
     * ordinary English.
     */
    lines.push(
      `Ignored as too common to narrow anything: ${query.dropped.join(', ')}`,
    );
  }

  if (!query.terms.length) {
    lines.push(
      '',
      'Every word in that description is too common to search on, so nothing was looked for. Name the ' +
        'thing the way the code probably names it — a component, a route, a field on the screen.',
    );
    return lines.join('\n');
  }

  if (!query.matches.length) {
    lines.push(
      '',
      'Nothing in the graph carries those words.',
      'That is a statement about vocabulary, not about the application: a checkout implemented as ' +
        'PurchaseFlow and /api/orders answers to neither "checkout" nor "flow". Try a word you have ' +
        'seen in the code or in a URL, or call get_app_architecture for the names the graph does hold.',
    );
    return lines.join('\n');
  }

  lines.push('', `${query.matches.length} match${query.matches.length === 1 ? '' : 'es'}, strongest first:`);

  for (const match of query.matches) {
    const kind = KIND_TITLES[match.entity.kind] ?? match.entity.kind;
    lines.push(
      '',
      `  ${kind}  ${match.entity.name}`,
      `      ${match.basis} — ${BASIS_REASON[match.basis] ?? 'it carries your words'} (${match.terms.join(', ')})`,
    );
    if (match.entity.text) lines.push(`      ${match.entity.text}`);

    const linked = neighbours.get(`${match.entity.kind}:${match.entity.id}`) ?? [];
    if (linked.length) {
      // The half the word never had to reach. Labelled as observation, because
      // an edge in this graph is something a recording saw rather than
      // something the code declares.
      lines.push('      connected to, from what has been observed:');
      for (const neighbour of linked) lines.push(neighbourLine(neighbour));
    }
  }

  if (query.more) {
    lines.push(
      '',
      `${query.more} further match${query.more === 1 ? '' : 'es'} were not expanded. Raise "limit", or ` +
        'narrow the description.',
    );
  }

  if (corpus.truncated) {
    /*
     * A graph larger than the corpus cap. Said out loud because the alternative
     * is answering "nothing matched" about a component the graph holds and this
     * never looked at, which is the one wrong answer available here.
     */
    lines.push(
      '',
      `This graph holds more than ${corpus.perKind} of some kind of node, so the search covered the ` +
        `${corpus.perKind} most-observed of each — the most *recent* ${corpus.perKind}, for recorded ` +
        'flows, which have no observation count. Something rarely or long-ago seen may exist and not be above.',
    );
  }

  lines.push(
    '',
    'get_component_history opens any component named above, get_app_architecture is the whole graph, ' +
      'and list_flows finds the recordings behind it.',
  );
  return lines.join('\n');
}

// ── Provenance ─────────────────────────────────────────────────────────────

/*
 * `get_value_provenance`, and the sentence it must never stop saying.
 *
 * The mechanism is a search for one value across four independent observations
 * of one recording — the bodies the server sent, the writes the stores took,
 * the values components were handed, the text the page showed. It is not a
 * data-flow trace, and the gap between those two matters most exactly when the
 * answer looks best: four layers agreeing on `£42.00` is one value travelling,
 * and four layers agreeing on `2` is a coincidence four times over. So the
 * reply opens by saying what it did rather than closing with a caveat, and a
 * short value is called short where the reader cannot miss it.
 *
 * The layer order is the direction data flows through a React application, and
 * it is presentation only. Nothing here concludes that the response caused the
 * render. `get_causal_chain` makes causal claims, out of evidence about events.
 *
 * ## The fifth layer, and the two claims this renderer must keep apart
 *
 * `backend` is the spans the user's own service exported under the trace id
 * DevFlow put on the request. It is not a fifth observation of the recording,
 * and it produces two things of very different strength that a reader will
 * merge unless the reply refuses to:
 *
 *  - A **path** — `result.backend.paths` — is a *known attachment*. The call
 *    and its spans are joined by 128 bits DevFlow minted and the backend echoed,
 *    so which call a span belongs to is known rather than inferred. It is the
 *    only link in this whole reply that is not a comparison of two strings.
 *  - A **hit** with `layer: 'backend'` is a *sighting*, exactly as weak as the
 *    other four. A span carries no response body; what it can carry is a query's
 *    text, a request path, its own name and what an error said. `£42.00` in a
 *    `db.query.text` and `£42.00` in a response body are two sightings, not a
 *    lineage.
 *
 * So the sightings are printed with the other four layers, under the same
 * caveat, and the paths are printed in a section of their own that says what a
 * path is. A reply that let the strong link lend its authority to the weak
 * search would be claiming DevFlow traced the value into the database, which is
 * the one thing this tool has never been able to do.
 */

/** The step's own number, or its position, exactly as `stepParts` reckons it. */
function stepNumberOf(step, index) {
  return typeof step?.stepNumber === 'number' ? step.stepNumber : index + 1;
}

/** A component id resolved to the name it was written under, when the flow says. */
function componentLabel(flow, id) {
  const named = flow.react?.components?.[id];
  return named && typeof named.name === 'string' && named.name ? `${named.name} (${id})` : id;
}

/** One line of a provenance answer. A dozen of them is the whole reply. */
const PROVENANCE_LINE = 300;

const LAYER_TITLES = {
  // Worded as a sighting, not as a chain. What is under this heading is text
  // that appeared in a span; the chain is the section `backendSection` prints.
  backend: 'backend — what the server-side work carried',
  response: 'response — what the server sent',
  store: 'store — what the app wrote down',
  render: 'render — what a component was handed',
  dom: 'dom — what the page showed',
};

/**
 * The server-side work behind the calls the value was seen at.
 *
 * Its own section rather than more lines inside the backend *layer*, because
 * the two are different kinds of claim and the reply is worth nothing if a
 * reader merges them — see the header. Printed after the sightings because it
 * answers "behind which call?", and that question needs the call named first.
 *
 * `awaiting` is printed even when other calls did join, and never folded into
 * "no backend data". Three of a recording's four traced calls rendering as the
 * whole backend story is worse than none of them rendering at all: the reader
 * has a complete-looking chain and no reason to doubt it. It is suppressed only
 * when `unsearched` already carries the backend's own nothing, which says the
 * same thing at more length and in the right place.
 */
function backendSection(reading, explainedAsUnsearched) {
  const lines = [];

  if (reading.paths.length) {
    lines.push(
      '',
      'the server-side work behind the calls it was seen at',
      '  These spans are attached to the call by the trace id DevFlow put on the request and the ' +
        'backend echoed — 128 bits, so which call each one belongs to is known rather than guessed. ' +
        'That is the one link in this reply which is not a comparison of two strings. What was ' +
        'found inside a span is still a sighting on the same terms as everything above: a span ' +
        'carries no response body, only a query’s text, a path, its own name and what an error said.',
    );

    for (const path of reading.paths) {
      lines.push(
        '',
        `  step ${path.step}  ${truncate(String(path.where ?? ''), PROVENANCE_LINE)}`,
        `      trace ${truncate(String(path.traceId ?? ''), PROVENANCE_LINE)} · ` +
          `${truncate((path.services ?? []).join(', '), PROVENANCE_LINE)}`,
      );
      for (const hop of path.hops ?? []) lines.push(...spanLines(hop, '      ', PROVENANCE_LINE));
      /*
       * The count is the finding, not an apology for the cap. An N+1 query is
       * four hundred spans of one recorded click, and "and 380 more" is the
       * sentence somebody acts on — a chain cut to twelve with nothing said
       * about the rest reads as a handler that issued one query.
       */
      if (path.more) {
        lines.push(
          `      … ${path.more} more operation${path.more === 1 ? '' : 's'} under this trace, ` +
            'above what one answer prints. get_backend_trace has all of them.',
        );
      }
    }

    /*
     * A chain with no file on any hop, said as what it is.
     *
     * Measured rather than assumed: of the official Node auto-instrumentations
     * essentially none record `code.filepath` — not express, not http, not
     * knex, pg, mysql2, mongodb, redis or graphql — so the roadmap's
     * "invoice_controller.py:45" is what a *hand-instrumented* service gives
     * and is not the ordinary case. Left unsaid, a chain with no file reads as
     * "DevFlow could not find the handler", which sends a reader to look for a
     * fault in the recording. The true sentence sends them to their own
     * instrumentation, and is the only one of the two that helps.
     */
    const anyFile = reading.paths.some((path) => (path.hops ?? []).some((hop) => hop.file));
    if (!anyFile) {
      lines.push(
        '',
        '  No operation above names the file it was written in, and that is almost always the ' +
          'instrumentation rather than the recording: hardly any automatic Node instrumentation ' +
          'records code.filepath, so a chain is normally located by each operation’s own name and ' +
          'route. Instrument the handler by hand if you need its file and line here.',
      );
    }

    if (reading.more) {
      lines.push(
        '',
        `  … ${reading.more} more traced call${reading.more === 1 ? '' : 's'} the value was seen ` +
          'at, above what one answer prints.',
      );
    }
  }

  if (reading.awaiting && !explainedAsUnsearched) {
    const one = reading.awaiting === 1;
    lines.push(
      '',
      `${reading.awaiting} traced call${one ? '' : 's'} in this recording ${one ? 'has' : 'have'} ` +
        `no spans yet, so what is above is part of this recording’s server-side work and not all ` +
        `of it. The recording carried the ${one ? 'id' : 'ids'}, so the header went out and nothing ` +
        'has arrived under it — the backend is not exporting to this server, or it sampled the ' +
        'trace away, or the spans are still in a batch. Re-send this recording once they arrive ' +
        'and they will join.',
    );
  }

  return lines;
}

function renderProvenance(flow, result, from) {
  const lines = [
    `Where ${JSON.stringify(result.value)} came from — "${flow.name}"${from ? `, traced from ${from}` : ''}`,
    '',
    'DevFlow did not watch this value move. It looked for the same value in four independent ' +
      'observations of this recording and reports where it turned up, in the order data flows through ' +
      'an application. Two sightings in adjacent layers are two sightings and not a link.',
    /*
     * The fifth layer is introduced separately and deliberately. It is not a
     * fifth observation of the recording — it arrived from somewhere else
     * entirely — and folding it into the sentence above would quietly upgrade
     * the other four by association, which is the opposite of what that
     * sentence is for.
     */
    '',
    'A fifth layer is the spans the backend exported under the trace id DevFlow put on the ' +
      'request. Which call those belong to is known rather than inferred; finding this value ' +
      'written inside one of them is a sighting like any other.',
  ];

  if (result.collides) {
    /*
     * Said before the findings rather than after them. A reader who has already
     * read a four-layer answer has drawn the conclusion, and a caveat
     * underneath it arrives too late to be the thing that stops them.
     */
    lines.push(
      '',
      `${JSON.stringify(result.value)} is short enough that an equal string is as likely to be a ` +
        'coincidence as a sighting. Everything below may be unrelated. Trace something distinctive — ' +
        'an order number, a formatted price, a name — if you can see one beside it.',
    );
  }

  const byLayer = new Map();
  for (const hit of result.hits) {
    if (!byLayer.has(hit.layer)) byLayer.set(hit.layer, []);
    byLayer.get(hit.layer).push(hit);
  }

  if (!result.hits.length) {
    lines.push(
      '',
      'It was not found in any layer this recording carries.',
      'That is a fact about the recording as much as about the value: a flow captures what it was ' +
        'configured to capture, and the header of get_flow says which settings were non-default.',
    );
  }

  for (const [layer, hits] of byLayer) {
    lines.push('', LAYER_TITLES[layer] ?? layer);
    for (const hit of hits) {
      /*
       * Capped, like every other renderer in this file. `where` and `detail`
       * carry a URL, a JSON pointer built out of a body's own keys, a patch
       * path and a component's name — all of them text a recorded page chose,
       * arriving over loopback from any site the browser visited. A single
       * 200KB key would otherwise be one line of the answer.
       */
      const where = layer === 'render' ? renderWhere(flow, hit.where) : hit.where;
      lines.push(`  step ${hit.step}  ${truncate(String(where ?? ''), PROVENANCE_LINE)}`);
      lines.push(
        `      ${hit.match === 'exact' ? 'the whole value' : 'inside a longer value'} — ${truncate(String(hit.detail ?? ''), PROVENANCE_LINE)}`,
      );
    }
    const over = result.more?.[layer];
    if (over) {
      lines.push(
        `  … ${over} more sighting${over === 1 ? '' : 's'} in this layer, above what one answer prints.`,
      );
    }
  }

  const reading = result.backend ?? { paths: [], more: 0, awaiting: 0 };
  const backendUnsearched = result.unsearched.some((gap) => gap.layer === 'backend');
  lines.push(...backendSection(reading, backendUnsearched));

  if (result.unsearched.length) {
    /*
     * The half of this tool that stops it lying. "The value is not in a
     * response" and "this recording has no responses" are different answers,
     * they look identical as an absent layer, and a reader with no way to tell
     * takes the first — which is a claim about the server.
     */
    lines.push('', 'Not searched, because this recording carries nothing for it:');
    for (const gap of result.unsearched) lines.push(`  ${gap.layer}  ${gap.reason}`);
  }

  lines.push(
    '',
    'get_causal_chain links events by evidence about the events themselves; this links nothing. ' +
      'get_flow_step opens any step named above, and get_state_patch has the whole of any store write.' +
      (reading.paths.length
        ? ' get_backend_trace has the whole span tree for every traced call in this recording.'
        : ''),
  );
  return lines.join('\n');
}

/** A render hit's `where`, with the component id resolved to a name. */
function renderWhere(flow, where) {
  const cut = where.indexOf('  ');
  if (cut === -1) return componentLabel(flow, where);
  return `${componentLabel(flow, where.slice(0, cut))}${where.slice(cut)}`;
}

/**
 * The steps with a value worth asking about.
 *
 * Cheap, and it is what makes the expensive call right: the caller is looking
 * at a walkthrough or a screenshot, and what they need first is which of the
 * things on it this recording can actually speak to.
 *
 * It says nothing about which steps carried a traced call, and that is a
 * decision rather than an omission. A traced call is a property of a *call*, so
 * the annotation would land on the wrong rows — a step can carry four traced
 * calls and no text worth tracing, and would not be listed here at all — and
 * being honest about it would mean reading the span store, which is the cost
 * this listing exists to avoid, and wording the ingest-off / never-traced /
 * not-yet-arrived distinction in a fourth place. That distinction is the one
 * thing in this feature that must not fragment. The backend layer is announced
 * where announcements belong, in the tool's description.
 */
function renderProvenanceIndex(flow, steps) {
  const lines = [
    `Values this recording can trace — "${flow.name}"`,
    '',
    'Each step below showed or received text that get_value_provenance can look for across the ' +
      'recording. Call it with "step" to trace one of these, or with "value" for anything else you ' +
      'can see — a value in a screenshot, a number in a walkthrough.',
    '',
  ];

  let found = 0;
  steps.forEach((step, index) => {
    const value = valueOfStep(step);
    if (!value) return;
    found++;
    lines.push(`  step ${stepNumberOf(step, index)}  ${truncate(value, 80)}`);
  });

  if (!found) {
    lines.push(
      '  No step in this recording showed text to trace. Every step is a navigation, a note, or an ' +
        'element with no label and no content — pass a "value" you can see instead.',
    );
  }

  return lines.join('\n');
}

// ── State ──────────────────────────────────────────────────────────────────

/*
 * `get_state_patch` and the four different nothings behind it.
 *
 * DevFlow does not watch a store. It reads each one twice — once when the
 * interaction is dispatched and once `recording.stateSettleMs` later — and
 * diffs the two, having patched, wrapped and defined nothing on the page in
 * between. Everything this tool may claim follows from that: it knows the two
 * endpoints and nothing about the path between them, so a value that changed
 * and changed back is a value that did not change, and the tool has to say so
 * rather than let a reader infer a timeline it never had.
 *
 * The harder failure is the one that is not about accuracy at all. "State was
 * never captured", "no store was recognised", "this step moved nothing" and
 * "here is the patch" arrive as the same absence if the code is written the
 * obvious way, and a reader with no way to tell them apart picks the worst
 * reading — usually that the app did nothing, which is the one answer that
 * cannot be checked. So each of the four is a different response with a
 * different first sentence, and none of them is an empty list.
 */

/**
 * How much of one operation's value is worth printing before it stops being
 * evidence and starts being the response.
 *
 * A `replace` at `/` carries the whole store, and one of those is a bigger
 * document than every other tool here returns. Cutting the value mid-JSON is
 * the silent truncation this file exists to refuse, and dropping the operation
 * leaves a patch with a hole in it — so an over-large value is replaced by a
 * sketch of its shape under a *different key*, which no reader and no library
 * can mistake for the value itself.
 */
const STATE_VALUE_CHARS = 240;

/** `redux "cart" (#s1)` — a store in the words the recording stored it under. */
const storeName = (ref) =>
  `${ref.kind ?? 'store'}${ref.label ? ` "${ref.label}"` : ''} (#${ref.id})`;

/** What a value is, when what it is has to stand in for what it was. */
function sketchValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array of ${value.length}`;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const shown = keys.slice(0, 6);
    return (
      `object, ${keys.length} key${keys.length === 1 ? '' : 's'}` +
      (shown.length ? `: ${shown.join(', ')}${keys.length > shown.length ? ', …' : ''}` : '')
    );
  }
  if (typeof value === 'string') return `string of ${value.length} characters`;
  return typeof value;
}

/**
 * One operation, printed whole or printed as a shape.
 *
 * `valueOmitted` rather than a shortened `value`: an operation carrying a
 * truncated value is a valid-looking patch operation that writes the wrong
 * thing, which is worse than one that obviously cannot be applied. The key
 * names what happened to it, and `sketched` is what makes the response say so
 * out loud rather than leaving the reader to notice a key they were not
 * expecting.
 */
function renderOp(op) {
  const path = typeof op?.path === 'string' ? op.path : '';
  const kind = op?.op;

  if (kind === 'remove' || !(op && 'value' in op)) {
    return { text: JSON.stringify({ op: kind, path }), sketched: false };
  }

  const encoded = JSON.stringify(op.value);
  if (typeof encoded === 'string' && encoded.length <= STATE_VALUE_CHARS) {
    return { text: JSON.stringify({ op: kind, path, value: op.value }), sketched: false };
  }

  return {
    text: JSON.stringify({
      op: kind,
      path,
      valueOmitted: `${sketchValue(op.value)}, ${typeof encoded === 'string' ? encoded.length : 0} characters as JSON`,
    }),
    sketched: true,
  };
}

/** The caveat that outranks every number below it, said once per bounded store. */
const BOUNDED_NOTE =
  'Snapshot bounded: this store was cut at DevFlow\'s depth, width or string cap before the two ' +
  'samples were compared, so the patch describes the bounded view of it and not the store. ' +
  'Anything below the cut reads as unchanged whether it changed or not.';

/** What `collapsed` means, in the words it does not mean. */
const collapsedNote = (count) =>
  `${count} finer operation${count === 1 ? ' was' : 's were'} folded into coarser replaces to fit the ` +
  'operation budget. Nothing was dropped and the patch below still applies exactly — it is less ' +
  'specific about where inside those paths the change was, not missing any of it.';

/**
 * One store's movement across one step, cut on an operation boundary.
 *
 * `budget` is `Infinity` for every block but the first one on an over-budget
 * response, where it is the room left. A prefix of a patch does not reconstruct
 * the after state, so the line that reports the cut says that rather than
 * counting the loss and leaving the reader to assume the rest still applies.
 */
function stateBlock(entry, budget = Infinity) {
  const label = entry.ref
    ? storeName(entry.ref)
    : `#${entry.delta.store} — a store this recording does not list, so nothing is known about it`;
  const head = [`### step ${entry.number} · ${label} — ${entry.ops.length} operation${entry.ops.length === 1 ? '' : 's'}`];

  if (entry.delta.bounded === true) head.push(BOUNDED_NOTE);
  const collapsed = Number(entry.delta.collapsed);
  if (Number.isFinite(collapsed) && collapsed > 0) head.push(collapsedNote(collapsed));

  const rendered = entry.ops.map(renderOp);
  // Room for the two lines this function may still have to add about itself.
  let used = estimateTokens(head.join('\n')) + 80;
  const kept = [];
  for (const op of rendered) {
    const cost = estimateTokens(`  ${op.text},\n`);
    if (kept.length > 0 && used + cost > budget) break;
    kept.push(op);
    used += cost;
  }

  const sketched = kept.filter((op) => op.sketched).length;
  if (sketched) {
    head.push(
      `${sketched} of the operations below carr${sketched === 1 ? 'ies' : 'y'} a value larger than ` +
        `${STATE_VALUE_CHARS} characters, so ${sketched === 1 ? 'its' : 'their'} "value" is replaced by a ` +
        '"valueOmitted" sketch of what it was. Those operations are not applicable as printed.',
    );
  }

  const body = kept.map((op, i) => `  ${op.text}${i < kept.length - 1 ? ',' : ''}`);
  const dropped = rendered.length - kept.length;
  const tail = dropped
    ? [
        `… ${dropped} of ${rendered.length} operations omitted — this one store on this one step already ` +
          'fills the response budget. What is printed is a prefix of the patch and does not reconstruct ' +
          'the state the app ended the step in.',
      ]
    : [];

  return [...head, '[', ...body, ']', ...tail];
}

// ── MCP server (server → Claude) ───────────────────────────────────────────

const mcpServer = new Server({ name: 'devflow', version: VERSION }, { capabilities: { tools: {} } });

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_flows',
      description:
        'List recorded browser flows, newest first. Each entry has id, name, step count, start URL, errorCount — how many STEPS logged a console error or got a failed/4xx/5xx response — and failureCount, how many such failures there were in total. One step with six 500s is errorCount 1 and failureCount 6. A flow that failed also carries a one-line summary naming the commonest failure, the first step it happened on and the component behind it — often enough to skip straight to the file. Start here to find the recording to investigate.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_flow_errors',
      description:
        'Only the steps that failed in a flow: console errors, failed and 4xx/5xx network calls with their bodies, the element involved, and the screenshot path for each. Far smaller than get_flow — call this first when debugging something that broke. On a React app each failing step also carries the component it happened in and that component\'s source file and line — open that file directly rather than searching the repo.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Flow ID from list_flows' } },
        required: ['id'],
      },
    },
    {
      name: 'get_flow_step',
      description:
        'One step in detail: its element and selector, value, component and source file, every network call with bodies kept four times longer than any other tool keeps them, every console entry, and the screenshot path. Reach for this after get_flow_errors or get_flow names a step worth a closer look — it costs a fraction of re-reading the recording to see one thing.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows' },
          step: { type: 'number', description: 'Step number, 1-based, as the other tools report it' },
        },
        required: ['id', 'step'],
      },
    },
    {
      name: 'get_flow',
      description:
        'The full recording as a markdown walkthrough: what the user did, the component behind each step, the requests each one made and the errors it logged. Screenshots are referenced by absolute path — read those image files directly with your own file tools, one at a time, rather than calling get_flow_screenshots. Pass raw:true for the step JSON as well, which is replay data (xpath, bounding boxes, full selectors) rather than anything the walkthrough leaves out. On a React app it also carries the source file and line of the component behind each step, and the feature component that one is rendered inside: read those files instead of searching the repo for the component by name. A long recording is returned one page at a time; when it is, the response says so and names the "from" to call next. If you only need what broke, get_flow_errors is far smaller.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows' },
          from: {
            type: 'number',
            description:
              'First step to return, 1-based. Omit to start at the beginning; pass the number the previous response named to continue.',
          },
          raw: {
            type: 'boolean',
            description: `Also return the step JSON — selectors, xpath, bounding boxes, full network records. ${MACHINE_RENDERING.raw ? 'On by default here' : 'Off by default'}: it repeats what the walkthrough already says and adds replay data that answers no question about what went wrong. Pass it explicitly either way to override the default. Use get_flow_step for one step in detail.`,
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_flow_screenshots',
      description:
        `Screenshots as base64 images, for at most ${MACHINE_RENDERING.maxImages} steps per call (a recording made under a different "screenshots per MCP call" setting carries its own limit). Only use this when you cannot read files from disk — otherwise read the screenshotPath values from get_flow, which costs nothing until you open one. Omit "steps" to list what is available without transferring any image data.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows' },
          steps: {
            type: 'array',
            items: { type: 'number' },
            description: `Step numbers, 1-based. Omit to list available screenshots and their paths.`,
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'compare_flows',
      description:
        'Two recordings of the same journey, one that worked and one that did not, lined up against each other: where they stop doing the same thing, which endpoints answered differently, what only the broken run calls, and which errors only it logs. A working/broken pair is the strongest evidence there is, and this costs a fraction of reading both recordings.',
      inputSchema: {
        type: 'object',
        properties: {
          working: { type: 'string', description: 'Flow ID of the run that behaved correctly' },
          broken: { type: 'string', description: 'Flow ID of the run that did not' },
        },
        required: ['working', 'broken'],
      },
    },
    {
      name: 'compare_flows_across_deploys',
      description:
        'Two recordings of one flow made at two different commits, and what shipped between them. Returns the same runtime comparison compare_flows gives — where the runs diverge, which endpoints answered differently, which errors are new — and then the commits between the two builds, and which of the files they changed DevFlow has actually watched code run in. That last list is a shortlist to read first, not a cause. Pass a flow name (or the id of any one recording of it); with no commits named it compares the two most recent builds of that flow. Needs recordings made after commit stamping, which is the server reading the project it runs in.',
      inputSchema: {
        type: 'object',
        properties: {
          flow: {
            type: 'string',
            description: 'The flow to compare: its name as list_flows reports it, or the id of any one recording of it',
          },
          sha: {
            type: 'string',
            description: 'Commit of one of the two builds — at least 7 hex characters, either case. Omit both to compare the two most recent builds.',
          },
          otherSha: { type: 'string', description: 'Commit of the other build' },
        },
        required: ['flow'],
      },
    },
    {
      name: 'get_latest_flow',
      description:
        'The most recent recording, as get_flow would return it — including being paged when it is long. Shortcut for the common case of debugging what was just recorded.',
      inputSchema: {
        type: 'object',
        properties: {
          from: {
            type: 'number',
            description: 'First step to return, 1-based. Omit to start at the beginning.',
          },
          raw: { type: 'boolean', description: 'Also return the step JSON. See get_flow.' },
        },
      },
    },
    {
      name: 'get_flow_summary',
      description:
        'One recording in under 400 tokens: when it was made, how many steps, whether anything broke and what broke, the components behind it and the call to make next. The cheapest tool here and the one to start from once list_flows has named a flow — it costs about a fiftieth of get_flow, so asking it of the wrong recording costs nothing. Omit "id" for the most recent one.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Flow ID from list_flows. Omit for the most recent recording.',
          },
        },
      },
    },
    {
      name: 'get_step_detail',
      description:
        'One part of one step, rather than all of it. Omit "include" and it lists the parts this step has — its component, network calls, console output, element, text change, screenshot, and which components re-rendered — with what each would cost, so the next call asks for the one that answers the question. The "render" part answers "why did this render?": the components that re-rendered across the step and the props, state and contexts that changed value, marking the ones that re-rendered with nothing changed. It is sampled from two readings of the fiber tree, so it says which components re-rendered and never how many times, and it says which of "renders were never sampled", "the walk hit its cap" and "nothing re-rendered" it is. The "a11y" part is the accessibility audit of the page as the step left it: each violation with the WCAG success criterion it fails, what was actually measured, and the component it was found in. It appears only on a flow recorded with the audit switched on, which is not the default — so its absence means nothing was looked at, never that the page is clean. get_flow_step returns every part at once and is the right call when the step is already known to be the answer; this is for the move before that, on a step whose network alone runs to thousands of tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows' },
          step: { type: 'number', description: 'Step number, 1-based, as the other tools report it' },
          include: {
            type: 'array',
            items: { type: 'string', enum: STEP_PARTS },
            description: `Parts to return: ${STEP_PARTS.join(', ')}. Omit to list what this step has and what each part costs.`,
          },
        },
        required: ['id', 'step'],
      },
    },
    {
      name: 'get_source_snippet',
      description:
        'The lines around a component\'s source, read off this machine. Pass a flow id and a step to get the code behind the component that step happened in, or a file and a line directly. Saves the round trip of reading a path out of get_flow_errors and opening it yourself, and says plainly when the file named by the recording is not in the checkout — which is what a stale bundle looks like from here. Source files are read only from underneath the project root, which is the directory this server was started in unless DEVFLOW_PROJECT_ROOT says otherwise.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows. With "step" or "component".' },
          step: {
            type: 'number',
            description: 'Step number, 1-based. The source of the component this step happened in.',
          },
          component: {
            type: 'string',
            description: 'A component name in that flow, instead of a step. Use when a step names one you want to read.',
          },
          file: {
            type: 'string',
            description: 'A source path instead of a flow, relative to the project root. Absolute is accepted if it is inside it.',
          },
          line: { type: 'number', description: '1-based line to centre on. Defaults to the component\'s own line, or 1.' },
          radius: {
            type: 'number',
            description: `Lines either side of it. Default ${SNIPPET_RADIUS}, maximum ${MAX_SNIPPET_RADIUS}.`,
          },
          root: {
            type: 'string',
            description: 'Project root to read under, if it is not the directory this server was started in.',
          },
        },
      },
    },
    {
      name: 'get_state_patch',
      description:
        'What the app\'s own state did across one step, or a range of steps, as an RFC 6902 JSON Patch. ' +
        'DevFlow samples state, it does not watch it: each store is read once when the interaction is ' +
        'dispatched and once after the app settles, with nothing patched, wrapped or defined on the page ' +
        'in between — so a value that changed and changed back between those two reads shows no change at ' +
        'all, and nothing here says anything about the order things moved in within a step. Redux, ' +
        'Zustand, React Query and React context are the four kinds of store it recognises. The operations ' +
        'apply to the bounded snapshot DevFlow took of a store, not to the live store; within one store ' +
        'the per-step patches concatenate in step order and the concatenation is itself a valid patch, and ' +
        'across stores they do not, because each store is a separate document. Says which of "state was ' +
        'never captured", "no store was recognised" and "no store moved" it is, because those are three ' +
        'different answers and only the last is about the application.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows' },
          step: {
            type: 'number',
            description:
              'Step number, 1-based, as the other tools report it — one step. Use "from" and "to" for a range instead; passing both is refused.',
          },
          from: {
            type: 'number',
            description: 'First step of a range, 1-based, as get_flow uses it. Defaults to 1.',
          },
          to: {
            type: 'number',
            description: 'Last step of the range, 1-based and inclusive. Defaults to the last step of the flow.',
          },
          store: {
            type: 'string',
            description:
              'Only this store: an id from the roster this tool prints (the leading # is optional), or the label the page gave it. Omit for every store that moved.',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_causal_chain',
      description:
        'What led to one event in a recording — a console error, a network call, a state change — walked ' +
        'backwards to the interaction it came from. Each link says the evidence it rests on and how far ' +
        'that evidence goes, because a guessed edge presented as a known one is worse than no edge: ' +
        '"attributed" is temporal containment and nothing more (a background poll on a timer lands in the ' +
        'same place as a click\u2019s own request), "named" means the log line contains the request\u2019s own ' +
        'path, "echoed" means a value the response carried turned up in what the store was written with, ' +
        'and "followed" is ordering after a failed call and nothing else. The chain is derived from the ' +
        'recording each time it is asked for and is not stored, so it covers every flow on disk. Call it ' +
        'with a ref from get_flow_errors or from this tool\u2019s own output; omit "event" and it lists the ' +
        'events worth asking about.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows' },
          event: {
            type: 'string',
            description:
              'An event ref: "step:3", "net:3.1", "log:3.2", "state:3/redux:0/0". Omit to list the refs this recording has.',
          },
          depth: {
            type: 'number',
            description: 'How many links to walk back. Defaults to 8; honest chains are two or three long.',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_effects_of',
      description:
        'What followed from one event in a recording — the same graph as get_causal_chain, walked the other ' +
        'way. Given the click, it reaches the requests it made, the state those requests were echoed into ' +
        'and the errors that followed. Given a failing request, it reaches what the app then logged and ' +
        'wrote. Every link states its evidence, on the same four bases and with the same limits.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows' },
          event: {
            type: 'string',
            description:
              'An event ref: "step:3", "net:3.1", "log:3.2", "state:3/redux:0/0". Omit to list the refs this recording has.',
          },
          depth: { type: 'number', description: 'How many links to walk forward. Defaults to 8.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_value_provenance',
      description:
        'Where one value on the screen came from, across one recording: the response body that carried ' +
        'it, the store write that took it, the component that was handed it, the element that showed ' +
        'it — and the server-side work behind the call, where the backend exported spans for it. Read ' +
        'what it is before you read what it says — DevFlow did not watch the value move. Four of those ' +
        'five layers are independent observations of the one recording and this looks for the same value ' +
        'in all four, so a distinctive value found in three layers is overwhelmingly one value ' +
        'travelling, and a short one found in three layers is a coincidence three times over. The reply ' +
        'says which, and names any layer the recording never captured rather than letting it read as ' +
        '"not found there". The fifth layer is different in one direction only, and the reply keeps the ' +
        'halves apart. Which spans belong to a call is **known**: DevFlow minted a 128-bit trace id, put ' +
        'it on the request and the backend echoed it, so the chain from the call to the controller and ' +
        'the query it ran is an attachment rather than a guess — the one link here that is not a ' +
        'comparison of two strings. Finding the value **inside** one of those spans is only a sighting, ' +
        'as weak as the other four: a span carries no response body, only a query’s text, a request ' +
        'path, its own name and what an error said, so this value in a db.query.text and the same value ' +
        'in a response body are two sightings and not a lineage. Nothing here traced the value into a ' +
        'database, and a reply that reads that way is being read wrong. Give it a "value" to trace, or a ' +
        '"step" whose element text it should trace; with neither it lists the steps that have a value ' +
        'worth asking about.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows' },
          value: {
            type: 'string',
            description:
              'The text to trace, as it appears on screen — "£42.00", an order number, a name. Compared as text, so a number typed here finds a number the server sent.',
          },
          step: {
            type: 'number',
            description:
              'Trace what this step’s element said instead. Ignored when "value" is given. A recording has no node ids — an element is described, not addressed — so the value it showed is the handle that exists.',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'explain_feature',
      description:
        'Which parts of this application a description points at: the components, endpoints, source ' +
        'files, recorded flows and stores whose names carry your words, and — through the graph’s own ' +
        'edges — what each of those is connected to. Read how it works before you read what it says: the ' +
        'match is **lexical**. It lower-cases your description, cuts it into words, and looks for those ' +
        'words in names and paths. It does not know what checkout is. A component called Cart matches ' +
        '"cart" whether or not it has anything to do with a shopping cart, and a feature written as ' +
        'PurchaseFlow is not found by "checkout" at all — so silence here means your words did not ' +
        'overlap the code’s, never that the feature is absent. What makes it worth more than a grep is ' +
        'the second half: every match is expanded one hop through the accumulated graph, which reaches ' +
        'the endpoint a component calls and the file it was written in whether or not those carried the ' +
        'word. Each match says why it matched, in words rather than a score.',
      inputSchema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description:
              'What you are looking for, in your own words — "the checkout flow", "cart badge", "invoice totals". Common words are dropped and the reply says which.',
          },
          limit: {
            type: 'number',
            description: 'Matches to expand. Defaults to 8; the reply counts anything beyond it.',
          },
        },
        required: ['description'],
      },
    },
    {
      name: 'suggest_actions',
      description:
        'What can be done on a page, according to every recording DevFlow holds of it: the clicks and ' +
        'the fields, with the selector the recorder chose and the value that was actually typed, folded ' +
        'across flows so the action three recordings performed is one row saying three. Read what it is ' +
        'before you use it — **nothing here is invented.** Every action was performed by a person and ' +
        'recorded; DevFlow has no model of your application, so it offers what has been done rather than ' +
        'what might work, and a control nobody has ever touched is not below. That is the point rather ' +
        'than the limitation: for reproducing a bug, the things people actually do on a page are a ' +
        'better starting set than anything guessed, and they come with a selector that resolved at least ' +
        'once. Filter by "url", by "component", or by both.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description:
              'Only actions performed on this page. Compared on origin and path, so a query string does not split one page into several.',
          },
          component: {
            type: 'string',
            description:
              'Only actions inside this component — an id from get_app_architecture or from a flow’s component table.',
          },
          limit: { type: 'number', description: 'Actions to return. Defaults to 20.' },
        },
      },
    },
    {
      name: 'replay_flow',
      description:
        'Run a recorded journey again, in your project, with your Playwright — and say whether it still ' +
        'does what it did when it was recorded. This is the only tool here that **executes code on this ' +
        'machine**, so it is off until you switch it on with DEVFLOW_REPLAY=1 in this server’s ' +
        'environment; called while it is off, it says exactly that rather than failing quietly. It ' +
        'compiles the flow to the same spec the extension’s export produces, writes it under ' +
        '.devflow/replays/ in your project, and runs your own node_modules copy of Playwright — it will ' +
        'not install one. The reply distinguishes a replay that passed, one that failed, one where no ' +
        'test ran and one where the runner never produced a readable report, because a crashed runner ' +
        'reported as a pass is how a repair loop concludes a fix worked. When the recording itself ' +
        'carried failures, the reply says whether the replay reproduced them, which is the check to run ' +
        'after a change.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows' },
          timeoutMs: {
            type: 'number',
            description: 'How long the run may take. Defaults to 120000; a replay still going after that is waiting on something that is not coming.',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'diagnose_failure',
      description:
        'Everything one recording says about what broke in it, per failure: what the message was, the ' +
        'component the step was attributed to and the file it was written in, the causal evidence ' +
        'leading back to the interaction, and — the part no single recording can supply — whether the ' +
        'thing that failed has failed before. That last one is the point: an endpoint that has failed ' +
        'twice in a hundred and forty observations and failed here sends you somewhere completely ' +
        'different from one that fails six times in ten, and the accumulated graph is the only thing ' +
        'that can tell them apart. It names no cause. Every link carries the basis it rests on, "we ' +
        'have never seen this fail" and "we have not seen it enough to say" are different answers and ' +
        'the reply says which, and what the recording cannot decide is left undecided.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows. Omit for the most recent recording.' },
          limit: { type: 'number', description: 'Failures to diagnose. Defaults to 5.' },
        },
      },
    },
    {
      name: 'get_backend_trace',
      description:
        'What happened on the server for the requests in one recording \u2014 the span tree the ' +
        'user\u2019s own backend exported under the trace id DevFlow put on the request. This is the ' +
        'far side of a call the browser watched leave: which service answered, what it called, how ' +
        'long each step took and which one failed. Read what it needs before you read what it says. ' +
        'It is empty unless three things are true: trace headers were switched on while recording, ' +
        'the backend is exporting OTLP to this server, and this server was started with ' +
        'DEVFLOW_OTEL=1. The reply tells those apart \u2014 a call that was never traced, a traced ' +
        'call whose spans have not arrived, and a joined trace are three different situations with ' +
        'three different fixes, and it never reports the second as the first.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Flow ID from list_flows' },
          step: {
            type: 'number',
            description: 'Only the calls in this step. Omit for every traced call in the recording.',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_app_architecture',
      description:
        'What every recording and every component pick together say about this application: the components seen most often, the endpoints each of them calls, how often those fail, and how long they take. This is the accumulated graph, not one recording — read it before opening a flow, to know whether the thing that just broke is usually reliable. Names the id each component is keyed by, for get_component_history.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_component_history',
      description:
        'Everything observed about one component: where it was resolved to, how often it has been seen, how often it failed, and every recorded flow it appears in. Takes a name as it is written in the code, or an id from get_app_architecture. Use it to tell a component that is failing now from one that has always failed.',
      inputSchema: {
        type: 'object',
        properties: {
          componentId: {
            type: 'string',
            description: 'A component name, or an id from get_app_architecture (the leading # is optional).',
          },
          since: {
            type: 'number',
            description: 'Only flows observed after this Unix time in milliseconds. Omit for all history.',
          },
        },
        required: ['componentId'],
      },
    },
    {
      name: 'get_living_architecture',
      description:
        'What is mounted on the developer’s open page right now: the component tree as it currently stands, how many instances of each, and which React contexts each component reads. This is a reading with an age on it, not a feed — the extension takes it on demand from the DevTools panel, so it describes one page at one moment and says how long ago that was. Use it to see the shape of the screen in front of the developer; use get_app_architecture for what has been observed over time, with frequencies and failure rates.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description:
              'Which page, when readings are held for more than one. A substring is enough. Omit for the most recent.',
          },
        },
      },
    },
    {
      name: 'get_commit_candidates',
      description:
        'Which commits changed the file a component was written in, and — the part git cannot tell you — which of them landed after the last time DevFlow actually watched that component run. Use it when something is misbehaving and you want the shortlist of changes the runtime graph has never seen exercised. It names no cause: it compares dates, not behaviour, and says so on every answer. get_component_history is what the component has done; this is what happened to its code.',
      inputSchema: {
        type: 'object',
        properties: {
          componentId: {
            type: 'string',
            description: 'A component name, or an id from get_app_architecture (the leading # is optional).',
          },
          file: {
            type: 'string',
            description: 'A source file, instead of a component. Matched against the files the graph has observed.',
          },
          limit: {
            type: 'number',
            description: 'How many commits of history to walk. Default 200, maximum 1000.',
          },
        },
      },
    },
    {
      name: 'get_blast_radius',
      description:
        'What the runtime has observed depending on one source file: the components seen to have been written in it, how often each was exercised, how often each failed, and what each was seen calling and reading. Read it before changing a file, to know what the running application actually put through that code. It is observation and not static analysis — it does not find files that import this one, and a component never exercised while DevFlow was watching does not appear.',
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'A source file path as the graph holds it — get_app_architecture names them.',
          },
          lineStart: { type: 'number', description: 'Only components resolved to a line at or after this.' },
          lineEnd: { type: 'number', description: 'Only components resolved to a line at or before this.' },
        },
        required: ['file'],
      },
    },
    {
      name: 'get_anomalies',
      description:
        'Components and endpoints failing or slowing beyond their own history — the graph saying what has changed, rather than what is true. Needs 30 observations of an entity before it will call anything unusual about it, so it reports nothing on a young graph rather than guessing. Defaults to the last 24 hours.',
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'number',
            description: 'Look at observations after this Unix time in milliseconds. Defaults to the last 24 hours.',
          },
        },
      },
    },
  ],
}));

const text = (value) => ({ content: [{ type: 'text', text: value }] });
const failure = (value) => ({ content: [{ type: 'text', text: value }], isError: true });
const notFound = (id) => failure(`Flow "${id}" not found. Run list_flows to see what is available.`);

/**
 * Why a flow could not be read.
 *
 * A flow too new for this build is not a missing flow, and reporting it as one
 * sends the reader hunting for a recording that is sitting in `list_flows` in
 * front of them. `UnsupportedFlow` carries a message that says what to do; every
 * other failure is genuinely "no such flow".
 */
const readFailure = (error, id) =>
  error instanceof UnsupportedFlow ? failure(error.message) : notFound(id);

/*
 * The graph's own strings.
 *
 * Two different nothings, and telling a reader the wrong one wastes their next
 * move: an empty graph is fixed by sending a flow, and an absent one is not
 * fixed by anything they can do from the browser. The archive's version
 * answered both with "record and send a flow", which is advice that cannot work
 * on the machine where the database would not open.
 */
const NO_GRAPH =
  'This server has no knowledge graph: arkg.db could not be opened, and the reason was printed ' +
  'on stderr when the server started. Nothing else is affected — get_flow, get_flow_errors and ' +
  'get_flow_step answer from the recordings themselves.';

const EMPTY_GRAPH =
  'The knowledge graph is empty. It fills from two places, both of them the extension\'s: a flow ' +
  'is added when it is sent to this server, and a component is added when it is picked in the ' +
  'DevTools panel. Record a flow and press Send to Claude, then ask again.';

/** A failure rate worth printing, as a whole percent. Nothing, when nothing failed. */
const failPct = (rate) => (rate > 0 ? `  ${Math.round(rate * 100)}% fail` : '');

/**
 * The edges hanging off one component, grouped by what they mean.
 *
 * `getComponent` has always returned these and no tool has ever printed one, so
 * every edge the graph holds about a component — the endpoints it calls, the
 * stores it was observed reading — was reachable only by opening the database
 * by hand. A node type nobody can read is, from outside, a node type that was
 * never written, which makes the write and the renderer one deliverable.
 *
 * Bounded per group rather than overall, so a component that calls forty
 * endpoints cannot push its one `subscribes_to` edge off the end: the rare edge
 * is the one worth seeing.
 */
/**
 * The events worth asking a causal question about, and what each would answer.
 *
 * Not every event — a forty-step recording has hundreds, and a listing of all
 * of them is the tokens the drill-down exists to save. The ones here are the
 * ones a chain actually terminates at: the failures, and the steps. An event
 * with no link either way is left out entirely, because walking from it is a
 * call whose answer is already known to be "nothing".
 */
const CAUSAL_INDEX_LIMIT = 12;

function renderCausalIndex(json, graph, backwards) {
  const verb = backwards ? 'led to' : 'followed from';
  const lines = [
    `Causal events in "${json.name}" — ${graph.events.length} event${graph.events.length === 1 ? '' : 's'}, ` +
      `${graph.links.length} link${graph.links.length === 1 ? '' : 's'}.`,
  ];

  if (!graph.links.length) {
    lines.push(
      '',
      'No link was found in this recording. Every event is still attributed to its step — that is what ' +
        'get_flow_step shows — but nothing here named a request, echoed a response into a store, or ' +
        'followed a failed call, which are the three things this analysis looks for.',
    );
    return lines.join('\n');
  }

  const linked = new Set();
  for (const link of graph.links) {
    linked.add(link.from);
    linked.add(link.to);
  }

  // Failures first: an error is the event somebody is holding when they reach
  // for this tool, and a listing that opens with step 1 makes them scroll.
  const ranked = graph.events
    .filter((event) => linked.has(event.ref))
    .sort((a, b) => rankCausal(a) - rankCausal(b) || a.step - b.step);

  lines.push('', `Ask what ${verb} any of these:`);
  for (const event of ranked.slice(0, CAUSAL_INDEX_LIMIT)) {
    lines.push(`  ${event.ref}  ${event.label}`);
  }
  if (ranked.length > CAUSAL_INDEX_LIMIT) {
    lines.push(`  \u2026 and ${ranked.length - CAUSAL_INDEX_LIMIT} more events carrying a link`);
  }
  return lines.join('\n');
}

/** Console entries, then network, then state, then steps — worst news first. */
function rankCausal(event) {
  if (event.kind === 'console') return 0;
  if (event.kind === 'network') return 1;
  if (event.kind === 'state') return 2;
  return 3;
}

const EDGES_PER_GROUP = 6;

const EDGE_HEADINGS = {
  calls: 'Calls, most often first:',
  renders: 'Renders, most often first:',
  maps_to: 'Written in:',
  subscribes_to:
    'Reads these stores — observed, meaning this component\u2019s own fiber carried the dependency, not that it sits underneath the provider:',
  caused_by: 'Causally linked, with the evidence each link rests on:',
};

function renderEdges(lines, component) {
  const edges = Array.isArray(component.edges) ? component.edges : [];
  if (!edges.length) return;

  const groups = new Map();
  for (const edge of edges) {
    const list = groups.get(edge.type) ?? [];
    list.push(edge);
    groups.set(edge.type, list);
  }

  for (const [type, list] of groups) {
    // An unrecognised type still prints, under its own name. An edge written by
    // a newer graph than this renderer is data, and hiding it is how two halves
    // of one package quietly stop agreeing about what is known.
    lines.push('', EDGE_HEADINGS[type] ?? `${type}:`);
    const sorted = [...list].sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0));
    for (const edge of sorted.slice(0, EDGES_PER_GROUP)) {
      const outgoing = edge.from_node_type === 'component' && edge.from_node_id === component.id;
      const other = outgoing
        ? `${edge.to_node_type} ${edge.to_node_id}`
        : `${edge.from_node_type} ${edge.from_node_id}`;
      lines.push(
        `  ${outgoing ? '' : '← '}${other}  ${edge.frequency ?? 1}x${failPct(edge.failure_rate)}` +
          `${edge.basis ? `  ${edge.basis}` : ''}${edge.confidence ? ` (${edge.confidence} confidence)` : ''}`,
      );
    }
    if (sorted.length > EDGES_PER_GROUP) {
      lines.push(`  \u2026 and ${sorted.length - EDGES_PER_GROUP} more`);
    }
  }
}


/** A stored millisecond timestamp as a date. ISO, not a locale: this is read on a machine, by a model. */
const day = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'unknown');

/**
 * Rough token count. Four characters to a token is the usual estimate and is
 * close enough for a budget: the cost of being 20% wrong is one step more or
 * fewer on a page, and the cost of not counting at all is the response being
 * cut in half by the client with nothing to say so.
 */
const estimateTokens = (value) => Math.ceil(value.length / 4);


/**
 * Fields kept in `flow.json` for replay but not worth a token to a reader.
 *
 * `xpath` and `boundingBox` exist so a future playback feature has something to
 * drive from — nothing about *reasoning over* a recording is answered by either,
 * and they are on every step. `dpr` and `highlightBox` are the annotator's own
 * bookkeeping. They stay on disk; they do not go into a context window.
 */
function leanElement(element) {
  if (!element) return element;
  const { xpath: _xpath, boundingBox: _box, ...rest } = element;
  return rest;
}

/**
 * A step as it goes into the JSON block.
 *
 * Its stored fields, minus the replay-only ones, plus where its image is, with
 * every body cut to the flow's own `mcp.bodyLimit` and the clock expressed as a
 * delta.
 *
 * `full` keeps everything — that is `get_flow_step`, which exists precisely to
 * be asked for one step in its entirety after a cheaper call named it, and it
 * gets four times the body for the same reason.
 *
 * The extension compacts bodies before it sends them, so the compaction below
 * usually changes nothing. It is here for the two cases where nothing compacted
 * them: a flow recorded before that existed, and a POST from something that is
 * not the extension. `truncate` stamps what it removed, so a cut body cannot
 * read as a whole one.
 */
function stepJson(dir, step, origin, full = false, render = MACHINE_RENDERING) {
  // `dpr` and `highlightBox` go even in full mode: they are the annotator's
  // coordinate bookkeeping, and there is no question about a recording that
  // either one answers.
  const { dpr: _dpr, highlightBox: _highlight, ...rest } = step;
  const out = { ...rest };
  const bodyLimit = bodyLimitFor(render, full);
  const bodies = render.limits;

  out.screenshotPath = screenshotPath(dir, step);
  // In full mode the element keeps its xpath and box: someone asking for one
  // step this closely is often asking because the selector is the problem.
  if (!full && out.element) out.element = leanElement(out.element);

  /*
   * Absolute epoch milliseconds are repeated on every step and every call, and
   * answer a question nobody asks. What a debugger wants is "the 500 came 4.2
   * seconds after the click", which is what an offset from the first step gives
   * — in a fraction of the characters. The flow's own `timestamp` is still
   * absolute, so the offsets have something to be offsets from.
   */
  if (typeof origin === 'number' && typeof step.timestamp === 'number') {
    out.atMs = step.timestamp - origin;
    delete out.timestamp;
  }

  if (Array.isArray(step.networkCalls)) {
    out.networkCalls = step.networkCalls.map((call) => {
      // A call that failed keeps its body; one that worked is worth its shape.
      const diagnostic = callFailed(call);
      const next = {
        ...call,
        requestBody: compactCall(
          call.requestBody,
          bodyMeta(call, 'request'),
          diagnostic,
          bodyLimit,
          bodies,
        ),
        responseBody: compactCall(
          call.responseBody,
          bodyMeta(call, 'response'),
          diagnostic,
          bodyLimit,
          bodies,
        ),
      };
      if (typeof origin === 'number' && typeof call.timestamp === 'number') {
        next.atMs = call.timestamp - origin;
        delete next.timestamp;
      }
      return next;
    });
  }

  if (Array.isArray(step.consoleLogs)) {
    /*
     * Errors and warnings only, which is the rule the markdown has always
     * followed — `log` and `info` are the app talking to its own developer, and
     * a page that prints a render timing on every frame was filling the step
     * data with it. The JSON never applied the filter, so the two halves of one
     * response disagreed about what was worth reading.
     *
     * `full` keeps everything: `get_flow_step` is the tool for looking at one
     * step closely, and a debug line can be the thing that explains it.
     */
    const kept = full
      ? step.consoleLogs
      : step.consoleLogs.filter((entry) => entry.level === 'error' || entry.level === 'warn');

    out.consoleLogs = kept.map((entry) => {
      if (typeof origin !== 'number' || typeof entry.timestamp !== 'number') return entry;
      const { timestamp: _ts, ...withoutClock } = entry;
      return { ...withoutClock, atMs: entry.timestamp - origin };
    });

    // Dropped, but never silently — six entries reading as two is a different
    // story about the page from six.
    const dropped = step.consoleLogs.length - kept.length;
    if (dropped > 0) out.consoleLogsOmitted = `${dropped} log/info/debug entries not shown`;
  }

  return out;
}

/** When the recording started, for the offsets above. */
const flowOrigin = (flow) => flow.steps[0]?.timestamp ?? flow.timestamp;

/**
 * One step reduced until it fits, by dropping network calls from the end.
 *
 * Reached only when a single step exceeds the whole budget on its own — a step
 * that made hundreds of requests, or one whose bodies nothing ever compacted.
 * The alternative is what this file exists to prevent: a page the client
 * truncates mid-JSON without a word. Dropping from the end keeps the calls that
 * happened first, which are the ones the step's own failure usually follows
 * from, and the count of what went is written onto the step itself so the
 * omission travels with the data rather than only in the prose above it.
 *
 * Both halves are re-derived from the shrunk step, which is why this takes the
 * step and a `measure` rather than the finished JSON. Trimming the JSON alone
 * trimmed the half the default response throws away and left the walkthrough —
 * which carries the same calls at roughly 220 tokens each — to go out whole: a
 * step with three hundred requests cleared a 20,000-token budget threefold
 * while the page above it still announced a clean cut on a step boundary. That
 * is the silent client-side truncation the budget exists to refuse, reached by
 * the one path that had stopped being measured.
 */
function shrinkStep(step, measure, budget) {
  const calls = Array.isArray(step.networkCalls) ? step.networkCalls : [];
  const dropped = (kept) =>
    `${calls.length - kept} of ${calls.length} calls omitted — this step alone exceeded the response budget`;

  /*
   * Binary search, because cost is monotonic in the number of calls kept and
   * each probe now re-renders the markdown as well as the JSON. Walking down
   * from the top rendered a three-hundred-call step three hundred times to
   * answer a question nine probes answer.
   */
  let low = 0;
  let high = calls.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure({ ...step, networkCalls: calls.slice(0, mid) }, dropped(mid)).cost <= budget) low = mid;
    else high = mid - 1;
  }

  if (low > 0) return measure({ ...step, networkCalls: calls.slice(0, low) }, dropped(low));

  // Even with no calls at all it does not fit; the console output is what is
  // left to give up.
  return measure(
    { ...step, networkCalls: [], consoleLogs: [] },
    calls.length
      ? `all ${calls.length} calls and every console entry omitted — this step alone exceeded the response budget`
      : 'every console entry omitted — this step alone exceeded the response budget',
  );
}

/**
 * As many steps from `start` as the budget allows, each rendered once.
 *
 * The first step is always included, shrunk if it has to be: returning an empty
 * page would leave the caller with a `from` that never advances, which is a loop
 * rather than a limit — and returning it whole would blow the budget the page
 * exists to keep.
 */
function fitSteps(flow, dir, start, budget, raw, render) {
  const chosen = [];
  const origin = flowOrigin(flow);
  let used = 0;

  let prevPath = pathBefore(flow, start);

  for (let i = start; i < flow.steps.length; i++) {
    const step = flow.steps[i];

    /*
     * One candidate step, rendered and priced exactly as it would be sent.
     *
     * Both halves come from here so that neither can be measured in a form the
     * response does not use. `omitted`, when a shrink has dropped calls, is
     * stamped onto the markdown and the JSON alike — the walkthrough is what a
     * default response sends, and a step quietly missing two hundred of its
     * requests reads as a step that only made a few.
     *
     * The JSON is priced only when it is going to be sent. Charging for it in
     * the default mode — where it is built and thrown away — meant a walkthrough
     * page carried a third of the steps it had room for, and paged the reader
     * through a recording that would have fitted.
     */
    const measure = (candidate, omitted) => {
      const rendered = renderStep(
        candidate,
        i + 1,
        prevPath,
        imageFor(dir, candidate),
        {},
        flow.react?.components ?? {},
        render.limits,
      );
      const lines = omitted ? [...rendered.lines, `… ${omitted}`, ''] : rendered.lines;
      const md = lines.join('\n');
      const js = omitted
        ? { ...stepJson(dir, candidate, origin, false, render), omittedNetworkCalls: omitted }
        : stepJson(dir, candidate, origin, false, render);

      return {
        md,
        js,
        path: rendered.path,
        cost: estimateTokens(md) + (raw ? estimateTokens(JSON.stringify(js)) : 0),
      };
    };

    let fitted = measure(step);

    if (chosen.length === 0 && fitted.cost > budget) {
      fitted = shrinkStep(step, measure, budget);
    } else if (chosen.length > 0 && used + fitted.cost > budget) {
      break;
    }

    chosen.push({ md: fitted.md, js: fitted.js });
    used += fitted.cost;
    // Advanced only for a step that was kept, so the step after a cut is
    // compared against the last step the reader actually saw.
    prevPath = fitted.path;
  }

  return chosen;
}

/**
 * A flow, or as much of one as fits, with the cut stated rather than implied.
 *
 * `from` is a 1-based step number, so it reads the same as the step numbers in
 * the document and the ones `get_flow_errors` reports. The continuation line is
 * repeated at the top and the bottom: a model that starts reading at the
 * beginning and one that skips to the end of a long block must both find it.
 */
function flowPayload(dir, json, heading, from = 1, raw = undefined) {
  const total = json.steps.length;
  /*
   * The settings this flow is rendered under — the whole precedence chain, read
   * once per response rather than per step. It is a fact about the recording,
   * and re-deriving it three hundred times says nothing new.
   */
  const render = renderingFor(json);
  /*
   * `raw` is a *default*, so an explicit argument always wins.
   *
   * The tool takes a boolean and the setting decides what the absence of one
   * means. A caller that passes `raw:false` on a machine configured for raw is
   * asking for the walkthrough alone and gets it; only an omitted argument
   * falls through to the configuration.
   */
  const withData = typeof raw === 'boolean' ? raw : render.raw;

  const start = Math.min(Math.max(1, Math.trunc(Number(from) || 1)), Math.max(1, total)) - 1;

  /*
   * §6: a flow records the settings it was made under, and the walkthrough
   * header shows the non-default ones.
   *
   * Above the failure summary and below the step count, because it changes what
   * every line beneath it means: a reader who learns at the top that
   * screenshots were off does not spend the rest of the response deciding
   * whether this recording is broken. Absent for a flow recorded at the
   * defaults, which is almost all of them, so it costs nothing to have.
   */
  const settings = describeStamp(json.settings);

  /*
   * The commit, above the settings and for the stronger version of the same
   * argument: a moved switch changes how much of the recording was captured,
   * while which build it was made against changes what every step below is
   * evidence *of*. The caveats travel with it rather than being left for the
   * reader to remember — a stamp read as "the build that was running" when the
   * page came off staging is worse than no stamp at all.
   */
  const commit = json.git ? describeCommit(json.git) : null;
  const caveats = json.git ? commitCaveats(json.git, json.startUrl ?? null) : [];

  const header = [
    `# ${json.name}`,
    '',
    `**Recorded:** ${new Date(json.timestamp).toLocaleString()}  `,
    `**Steps:** ${total}  `,
    json.startUrl ? `**Start URL:** ${json.startUrl}  ` : null,
    commit ? `**Recorded at:** ${commit}  ` : null,
    ...caveats.map((sentence) => `> ${sentence}  `),
    settings.length ? `**Recorded with non-default settings:** ${settings.join(' · ')}  ` : null,
    json.errorCount ? `**Steps with failures:** ${json.errorCount}  ` : null,
    json.errorCount ? `**What broke:** ${failureSummary(json) ?? '—'}  ` : null,
    '',
    '---',
    '',
  ].filter((line) => line !== null);

  /*
   * The budget is for the response, not for the steps in it.
   *
   * Everything that is not a step — the heading, the flow's own metadata, the
   * React component table, the screenshots line, the continuation prose, the
   * JSON envelope — is priced first and taken off the top. Budgeting the steps
   * alone and adding the framing afterwards overshoots by exactly the size of
   * the framing, which on a React flow with a full component table is not a
   * rounding error.
   *
   * The table is priced at its *full* size even though only the page's own rows
   * are printed below, because which rows those are is not known until the page
   * has been fitted, and the page cannot be fitted until the budget is known.
   * Over-pricing costs a step at the margin; under-pricing costs the guarantee.
   */
  const framing =
    estimateTokens(
      [heading, ...header, ...(json.react ? renderComponents(json.react, json.steps) : [])].join('\n'),
    ) +
    // The flow's own fields wrap the step array, and only in raw mode.
    (withData ? estimateTokens(JSON.stringify({ ...json, steps: [] })) : 0) +
    estimateTokens(path.join(dir, 'screenshots')) +
    // Two copies of a continuation line that has not been written yet, plus the
    // fences and the "Step data" heading.
    120;

  const chosen = fitSteps(json, dir, start, Math.max(500, render.maxTokens - framing), withData, render);
  const last = start + chosen.length;
  const more = last < total;

  /*
   * The table covers the steps on *this page*. A source path for a component the
   * reader cannot see here is a path they cannot act on, and on a long flow the
   * full table is itself a budget item — the page that shows the component is
   * the page that should carry its file.
   */
  const table = json.react ? renderComponents(json.react, json.steps.slice(start, last)) : [];

  /*
   * Both directions, independently.
   *
   * A middle page used to say only that there was more ahead — so a reader who
   * arrived on page two knew to keep going and had nothing to tell them the
   * first hundred steps existed at all. Whether there is more ahead and whether
   * there is anything behind are two facts, and a page in the middle of a long
   * recording is exactly where both of them matter.
   */
  const range = `Steps ${start + 1}–${last} of ${total}.`;
  const ahead = more
    ? `This is not the whole recording — call get_flow({"id":"${json.id}","from":${last + 1}}) for the rest.`
    : null;
  const behind = start > 0 ? 'Earlier steps are at from:1.' : null;
  const next = ahead || behind ? [range, ahead, behind].filter(Boolean).join(' ') : null;

  const markdown = [
    ...(next ? [`> ${next}`, ''] : []),
    ...header,
    ...chosen.map((entry) => entry.md),
    ...table,
  ].join('\n');

  const shots = `Screenshots are in ${path.join(dir, 'screenshots')} — read them directly.`;

  /*
   * The walkthrough alone, unless the step data was asked for.
   *
   * The two blocks used to be returned together and they overlap almost
   * entirely: every step's url, action, selector, component and screenshot path
   * appeared in the markdown *and* in the JSON, and the reader paid for both.
   * What the JSON has that the markdown does not is replay material — xpath,
   * bounding boxes, full unstable selectors, raw headers — none of which answers
   * a question about what went wrong.
   *
   * So the default is the narrative, and `raw: true` is there for the caller
   * that genuinely wants the record. Named in the response rather than left to
   * the tool description, because the moment a reader wants it is the moment
   * they are looking at this text.
   */
  const content = [{ type: 'text', text: `${heading}\n\n${markdown}\n\n${shots}` }];

  if (withData) {
    content.push({
      type: 'text',
      // Not pretty-printed: indentation is roughly 7% of this block and no
      // reader of it needs the whitespace.
      text:
        `## Step data\n\n\`\`\`json\n${JSON.stringify({
          ...json,
          steps: chosen.map((entry) => entry.js),
        })}\n\`\`\`` + (next ? `\n\n${next}` : ''),
    });
  } else {
    content.push({
      type: 'text',
      text:
        'Step data (selectors, xpath, bounding boxes, full network records) was not included — ' +
        `call get_flow({"id":"${json.id}","raw":true}) if you need it, or get_flow_step for one step.` +
        (next ? `\n\n${next}` : ''),
    });
  }

  return { content };
}

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'list_flows': {
      const flows = await listAllFlows();
      if (!flows.length) {
        return text(
          `No flows recorded yet (looking in ${FLOWS_DIR}). Record one in the DevFlow Chrome extension and press Send — it will appear here.`,
        );
      }

      /*
       * The summary is read off each flow's own steps, which means opening
       * `flow.json` — so it is done only for the flows that have a failure to
       * summarise, and only up to `SUMMARISED`. A list of two hundred recordings
       * is a list, not an investigation.
       */
      const SUMMARISED = 10;
      let budget = SUMMARISED;
      const detailed = await Promise.all(
        flows.map(async (meta) => {
          if (!meta.errorCount || budget <= 0) return meta;
          budget -= 1;
          try {
            const { json } = await readFlow(meta.id);
            const summary = failureSummary(json);
            return summary ? { ...meta, summary } : meta;
          } catch {
            // A flow whose steps cannot be read still belongs in the list; the
            // row is what tells the reader it exists at all.
            return meta;
          }
        }),
      );

      return text(JSON.stringify(detailed, null, 2));
    }

    case 'get_flow_errors': {
      let flow;
      try {
        flow = await readFlow(args.id);
      } catch (error) {
        return readFailure(error, args.id);
      }

      const render = renderingFor(flow.json);

      const broken = flow.json.steps
        .map((step, i) => ({ step, number: i + 1 }))
        .filter(({ step }) => consoleErrors(step).length > 0 || failedCalls(step).length > 0)
        .map(({ step, number }) => {
          // What turns "something broke on this click" into a file to open. The
          // path is repeated here rather than left to get_flow's table: this
          // tool exists to be the cheap call, and sending a debugger to make the
          // expensive one just to learn *where* would undo that.
          const component = stepComponent(flow.json, step);
          const within = stepEnclosing(flow.json, step);

          return {
            step: number,
            action: step.action,
            url: step.url,
            element: step.element?.cssSelector ?? null,
            component: component?.name ?? undefined,
            componentSource: component ? (formatSource(component) ?? undefined) : undefined,
            componentWithin: within?.name ?? undefined,
            componentWithinSource: within ? (formatSource(within) ?? undefined) : undefined,
            screenshotPath: screenshotPath(flow.dir, step),
            consoleErrors: consoleErrors(step).map((entry) =>
              truncate(entry.args.join(' '), render.bodyLimit),
            ),
            failedCalls: failedCalls(step).map((call) => ({
              method: call.method,
              url: call.url,
              status: call.status,
              durationMs: call.durationMs,
              /*
               * The trace id, and this is the tool that most needs it.
               *
               * A failed call is exactly when somebody goes and greps their own
               * backend, and this id is the one their backend logged. The
               * object is built field by field, so a field not named here does
               * not travel — which is how `traceId` would have been recorded,
               * plumbed through three files, and then been invisible from
               * outside.
               *
               * Left off entirely when absent rather than sent as null:
               * `JSON.stringify` drops an `undefined`, and it is absent on
               * nearly every call there is.
               */
              traceId: call.traceId,
              /*
               * Diagnostic: these are the calls that broke, so the body stays.
               *
               * `render.limits` was missing here and is not decoration — this
               * tool renders bodies like every other one, and a flow sent with
               * summarising switched off had it switched back on for the one
               * tool a reader debugging a failure calls first.
               */
              requestBody: compactCall(
                call.requestBody,
                bodyMeta(call, 'request'),
                true,
                render.bodyLimit,
                render.limits,
              ),
              responseBody: compactCall(
                call.responseBody,
                bodyMeta(call, 'response'),
                true,
                render.bodyLimit,
                render.limits,
              ),
            })),
          };
        });

      if (!broken.length) {
        return text(
          withheld(flow.json) ??
            `No step in "${flow.json.name}" logged a console error or a failed request. Call get_flow to read the whole recording.`,
        );
      }

      /*
       * Budgeted like `get_flow`, and for the same reason.
       *
       * This is the cheap call, but "cheap" is relative to the whole recording,
       * not absolute: a flow that failed on forty steps, each carrying a stack
       * trace and two failed request bodies, is its own context-window problem.
       * Cut on a step boundary with the cut stated — never by the client, mid
       * string, in silence.
       */
      const shown = [];
      let used = 0;
      for (const entry of broken) {
        const cost = estimateTokens(JSON.stringify(entry));
        if (shown.length > 0 && used + cost > render.maxTokens) break;
        shown.push(entry);
        used += cost;
      }

      // The one-line story first: it is often the whole answer, and it is forty
      // tokens against the thousands below it.
      const headline = failureSummary(flow.json) ?? `${broken.length} steps failed.`;
      const cut =
        shown.length < broken.length
          ? ` Showing the first ${shown.length} — steps ${shown
              .map((entry) => entry.step)
              .join(', ')}. The rest are at get_flow({"id":"${flow.json.id}","from":${
              shown[shown.length - 1].step + 1
            }}).`
          : '';

      /*
       * What a `traceId` in the JSON below is *for*, said once.
       *
       * Per call it would be the same sentence repeated down the response; not
       * said at all, a model is handed an opaque hex string and the whole Tier 1
       * payoff goes unclaimed — the id DevFlow put on the request is the id the
       * user's own backend logged, and going and searching for it there is the
       * entire reason a header was worth changing anybody's traffic for.
       *
       * Only when one is actually present, which means off by default and then
       * only for the calls the injection rule allowed, so the ordinary response
       * pays nothing for this line. The wording comes from `core/trace` rather
       * than being written a second time here.
       */
      const traced = shown
        .flatMap((entry) => entry.failedCalls ?? [])
        .find((call) => call.traceId);
      const trace = traced ? `\n\n${describeTrace(traced.traceId)}` : '';

      return text(`${headline}${cut}${trace}\n\n\`\`\`json\n${JSON.stringify(shown)}\n\`\`\``);
    }

    case 'get_flow_step': {
      let flow;
      try {
        flow = await readFlow(args.id);
      } catch (error) {
        return readFailure(error, args.id);
      }

      const render = renderingFor(flow.json);
      const total = flow.json.steps.length;
      const number = Math.trunc(Number(args.step));
      const step = Number.isFinite(number) ? flow.json.steps[number - 1] : undefined;

      if (!step) {
        return failure(
          `"${flow.json.name}" has no step ${args.step}. It has ${total} step${total === 1 ? '' : 's'}, numbered 1 to ${total}.`,
        );
      }

      /*
       * Rendered against the step before it, so `📍` means the same thing here
       * as it does in the walkthrough — a page change, not "this step has a URL".
       */
      const { lines } = renderStep(
        step,
        number,
        pathBefore(flow.json, number - 1),
        imageFor(flow.dir, step),
        {},
        flow.json.react?.components ?? {},
        render.limits,
      );

      /*
       * `full`: bodies, xpath, bounding box, the lot. Every other tool trims
       * because it is carrying tens of steps; this one is carrying one, and it
       * exists because something already decided this is the step that matters.
       */
      const detail = stepJson(flow.dir, step, flowOrigin(flow.json), true, render);

      return text(
        `## Step ${number} of ${total} — ${flow.json.name}\n\n${lines.join('\n')}\n\n` +
          `\`\`\`json\n${JSON.stringify(detail)}\n\`\`\``,
      );
    }

    case 'get_flow': {
      try {
        const { dir, json } = await readFlow(args.id);
        // `args.raw` verbatim, not `=== true`: an omitted argument has to stay
        // undefined so `mcp.raw` can answer for it. Coercing here would make the
        // setting unreachable while looking wired.
        return flowPayload(dir, json, '## Walkthrough', args.from, args.raw);
      } catch (error) {
        return readFailure(error, args.id);
      }
    }

    case 'get_flow_screenshots': {
      let flow;
      try {
        flow = await readFlow(args.id);
      } catch (error) {
        return readFailure(error, args.id);
      }

      const available = flow.json.steps
        .map((step, i) => ({ number: i + 1, file: screenshotPath(flow.dir, step) }))
        .filter((entry) => entry.file);

      if (!available.length) return text('No step in this flow has a screenshot.');

      if (!Array.isArray(args.steps) || args.steps.length === 0) {
        return text(
          `${available.length} screenshots. Read any of these directly, or pass "steps" to have them returned inline:\n\n${available
            .map((entry) => `- Step ${entry.number}: ${entry.file}`)
            .join('\n')}`,
        );
      }

      const wanted = available.filter((entry) => args.steps.includes(entry.number));
      if (!wanted.length) {
        return failure(
          `No screenshots for steps ${args.steps.join(', ')}. Available: ${available.map((e) => e.number).join(', ')}.`,
        );
      }

      /*
       * The flow's own limit, not this installation's.
       *
       * A recording made by someone who set "screenshots per MCP call" to eight
       * carries that answer in its stamp, and the tool description above can
       * only name one number — this machine's — because it is written once, at
       * startup, for every flow at once. So the description says what this
       * installation does and the response says what it actually did.
       */
      const maxImages = renderingFor(flow.json).maxImages;
      const chosen = wanted.slice(0, maxImages);

      if (chosen.length === 0) {
        return text(
          `Screenshots are switched off for this call — "screenshots per MCP call" is ${maxImages}. ` +
            `Read them from disk instead:\n\n${wanted.map((entry) => `- Step ${entry.number}: ${entry.file}`).join('\n')}`,
        );
      }

      const content = [];
      for (const entry of chosen) {
        const bytes = await fs.readFile(entry.file).catch(() => null);
        if (!bytes) continue;
        content.push({ type: 'text', text: `**Step ${entry.number}** — ${entry.file}` });
        content.push({
          type: 'image',
          data: bytes.toString('base64'),
          mimeType: entry.file.endsWith('.png') ? 'image/png' : 'image/jpeg',
        });
      }

      if (wanted.length > chosen.length) {
        content.push({
          type: 'text',
          text: `Returned ${chosen.length} of ${wanted.length} requested — ${maxImages} is the per-call limit. Ask for the rest in another call, or read them from disk.`,
        });
      }

      return { content };
    }

    case 'compare_flows': {
      let working;
      let broken;
      try {
        working = await readFlow(args.working);
      } catch (error) {
        return readFailure(error, args.working);
      }
      try {
        broken = await readFlow(args.broken);
      } catch (error) {
        return readFailure(error, args.broken);
      }

      return text(
        `## "${working.json.name}" (worked) vs "${broken.json.name}" (broken)\n\n` +
          compareFlows(working.json, broken.json),
      );
    }

    /*
     * Work Stream 3.4, and it is a join rather than a second comparison.
     *
     * `compare_flows` already answers what differs between two runs, so this
     * decides which two recordings are the two builds, asks git what shipped
     * between their commits, and crosses that against what the graph has seen
     * running. Building a second comparison beside a working one is the mistake
     * this package already made once with its markdown renderers.
     *
     * The roadmap's signature was `(flowId, sha1, sha2)` and it does not
     * survive contact: a flow id names one recording, made at one commit, so no
     * id has two builds to be asked for. What exists at two builds is a flow by
     * *name*.
     */
    case 'compare_flows_across_deploys': {
      const asked = typeof args.flow === 'string' ? args.flow.trim() : '';
      if (!asked) {
        return failure('Pass "flow" — a flow name as list_flows reports it, or the id of one recording of it.');
      }

      /*
       * Normalised, then validated, then refused with the reason rather than
       * left to silently match nothing.
       *
       * `isShaPrefix` takes lowercase only, and that is a rule about what may
       * reach a `git` argument list rather than a rule about what a caller may
       * type. Case-folding here is the boundary doing its job: one spelling
       * gets past this line, so everything inside compares one value against
       * one value. Refusing an uppercase SHA instead would be pedantry with a
       * hex string.
       */
      for (const key of ['sha', 'otherSha']) {
        const given = args[key];
        if (given === undefined || given === null || given === '') continue;
        if (!isShaPrefix(String(given).toLowerCase())) {
          return failure(
            `"${key}" must be at least 7 and at most 40 hex characters of a commit — got ${JSON.stringify(given)}.`,
          );
        }
      }
      const sha = args.sha ? String(args.sha).toLowerCase() : null;
      const otherSha = args.otherSha ? String(args.otherSha).toLowerCase() : null;

      const all = await listAllFlows();
      const byId = all.find((meta) => meta.id === asked);
      const name = byId ? byId.name : asked;
      const named = all.filter(
        (meta) => (meta.name ?? '').toLowerCase() === String(name).toLowerCase(),
      );

      if (!named.length) {
        const known = [...new Set(all.map((meta) => meta.name))].slice(0, 12);
        return failure(
          `Nothing recorded is called "${asked}". ` +
            (known.length
              ? `Recorded flows: ${known.map((one) => `"${one}"`).join(', ')}.`
              : 'Nothing has been recorded yet.'),
        );
      }

      const chosen = choosePair(
        named
          .filter((meta) => meta.git?.sha)
          .map((meta) => ({
            id: meta.id,
            name: meta.name,
            timestamp: meta.timestamp,
            startUrl: meta.startUrl ?? null,
            git: meta.git,
          })),
        { sha, otherSha },
      );
      if ('problem' in chosen) return failure(chosen.problem);

      const { older, newer } = chosen.pair;
      let before;
      let after;
      try {
        before = await readFlow(older.id);
      } catch (error) {
        return readFailure(error, older.id);
      }
      try {
        after = await readFlow(newer.id);
      } catch (error) {
        return readFailure(error, newer.id);
      }

      const root = gitRoot();
      const range = await gitTry(
        'deploy range',
        (g) => g.logRange(root, older.git.sha, newer.git.sha),
        null,
      );

      /*
       * An unreadable range and an empty one are different findings, and an
       * empty one splits again: two builds on branches that diverged produce
       * the same empty `git log` as two builds with nothing between them, and
       * only the second means "nothing shipped".
       */
      let rangeProblem = null;
      let reversed = null;
      if (range === null) {
        rangeProblem =
          `The commits ${older.git.short}..${newer.git.short} could not be read out of ${root ?? 'this project'}. ` +
          'Most often that is a recording made against a different checkout, or a commit that has since been ' +
          'rebased away — the runtime comparison above stands either way.';
      } else if (!range.length) {
        reversed = await gitTry(
          'deploy range, reversed',
          (g) => g.rangeSize(root, newer.git.sha, older.git.sha),
          null,
        );
      }

      /*
       * What has been seen running, graph first and the two recordings on top.
       *
       * The graph is the better answer — it pools every recording and every
       * pick — and the recordings are what makes the tool work at all on an
       * installation whose graph is missing, which `arkgTry` says is a state
       * every tool has to survive.
       */
      const observed = { ...(arkgTry('observed files', (graph) => graph.getObservedFiles(), null) ?? {}) };
      for (const recorded of [before.json, after.json]) {
        for (const component of Object.values(recorded.react?.components ?? {})) {
          if (!component?.source) continue;
          const list = (observed[component.source] ??= []);
          if (component.name && !list.includes(component.name)) list.push(component.name);
        }
      }

      const checkout = await readStamp();

      return text(
        renderDeployDiff({
          pair: chosen.pair,
          runtimeDiff: compareFlows(before.json, after.json, {
            working: 'the older build',
            broken: 'the newer build',
          }),
          range,
          rangeProblem,
          reversed,
          suspects: suspectFiles({
            range: range ?? [],
            prefix: checkout?.prefix ?? '',
            observed,
          }),
        }),
      );
    }

    case 'get_latest_flow': {
      const flows = await listAllFlows();
      if (!flows.length) return text('No flows recorded yet.');
      try {
        const { dir, json } = await readFlow(flows[0].id);
        return flowPayload(dir, json, `## Latest flow: ${flows[0].name}`, args.from, args.raw);
      } catch (error) {
        return error instanceof UnsupportedFlow
          ? failure(error.message)
          : failure('The most recent flow could not be read.');
      }
    }

    case 'get_flow_summary': {
      /*
       * The id is optional and its absence means "the latest", which is the
       * shape `get_latest_flow` already established. A triage tool that
       * insisted on an id would need `list_flows` in front of it to answer the
       * commonest question there is — did the thing I just recorded break.
       */
      let id = args.id;
      if (typeof id !== 'string' || !id) {
        const flows = await listAllFlows();
        if (!flows.length) {
          return text(
            `No flows recorded yet (looking in ${FLOWS_DIR}). Record one in the DevFlow Chrome extension and press Send — it will appear here.`,
          );
        }
        id = flows[0].id;
      }

      try {
        const { json } = await readFlow(id);
        return text(flowSummary(json));
      } catch (error) {
        return readFailure(error, id);
      }
    }

    case 'get_step_detail': {
      let flow;
      try {
        flow = await readFlow(args.id);
      } catch (error) {
        return readFailure(error, args.id);
      }

      const render = renderingFor(flow.json);
      const total = flow.json.steps.length;
      const number = Math.trunc(Number(args.step));
      const step = Number.isFinite(number) ? flow.json.steps[number - 1] : undefined;

      if (!step) {
        return failure(
          `"${flow.json.name}" has no step ${args.step}. It has ${total} step${total === 1 ? '' : 's'}, numbered 1 to ${total}.`,
        );
      }

      const parts = stepParts(flow.json, flow.dir, step, render);
      const heading =
        `## Step ${number} of ${total} — ${flow.json.name}\n` +
        `${step.action}${urlPath(step.url) ? `  ·  ${urlPath(step.url)}` : ''}`;

      /** One part as it is returned, so the index prices what the next call sends. */
      const section = (name) => {
        const part = parts[name];
        return `### ${name}\n\n${part.lines.length ? part.lines.join('\n') : part.have}`;
      };

      const asked = Array.isArray(args.include)
        ? args.include.filter((name) => typeof name === 'string')
        : [];
      const unknown = asked.filter((name) => !STEP_PARTS.includes(name));
      if (unknown.length) {
        return failure(
          `get_step_detail has no part called ${unknown.map((name) => `"${name}"`).join(', ')}. ` +
            `The parts are ${STEP_PARTS.join(', ')}.`,
        );
      }

      /*
       * The index, when nothing was asked for. It is the whole point of the
       * tool: a reader who knows the step made two calls and logged nothing
       * does not spend a thousand tokens finding out which.
       */
      if (!asked.length) {
        // A column, so the labels have a width. The sentence a part has to say
        // about itself when it is empty belongs in the part, not in the table.
        const LABEL = 46;
        const rows = STEP_PARTS.map((name) => {
          const label = ellipsis(parts[name].have, LABEL);
          return `  ${name.padEnd(11)}${label.padEnd(LABEL + 2)}~${estimateTokens(section(name))} tokens`;
        });

        const owner = stepComponent(flow.json, step);
        const where = owner ? formatSource(owner) : null;

        return text(
          `${heading}\n` +
            (owner ? `${owner.name}${where ? `  ${where}` : ''}\n` : '') +
            `\nParts of this step, and what each one costs:\n\n${rows.join('\n')}\n\n` +
            `get_step_detail({"id":"${flow.json.id}","step":${number},"include":["network"]}) returns one or more of them. ` +
            'get_flow_step returns the whole step at once, with bodies kept four times longer.',
        );
      }

      /**
       * One part, cut on a line boundary, saying what it lost.
       *
       * Reached when a single part exceeds the whole budget on its own — a step
       * that made three hundred requests is thirty thousand tokens of `network`
       * before anything else is asked for. Dropping the part instead would
       * answer a direct question with nothing; sending it whole is the failure
       * this file exists to prevent, because every MCP client applies its cap by
       * truncating the string and the response would arrive cut at an arbitrary
       * character with nothing anywhere saying so.
       */
      const fitPart = (name, budget) => {
        const part = parts[name];
        const head = `### ${name}\n\n`;
        const kept = [];
        // Room reserved for the omission line, which has to fit inside the
        // budget too — an accounting that says what was cut and then overruns
        // to say it has cut nothing.
        let used = estimateTokens(head) + 40;

        for (const line of part.lines) {
          const cost = estimateTokens(`${line}\n`);
          if (used + cost > budget) break;
          kept.push(line);
          used += cost;
        }

        const dropped = part.lines.length - kept.length;
        return (
          head +
          (kept.length ? `${kept.join('\n')}\n` : '') +
          `… ${dropped} of ${part.lines.length} lines omitted — this part alone exceeds the response budget`
        );
      };

      /*
       * Budgeted like every other multi-part response here, and cut on a part
       * boundary with the cut named. The first part asked for is always
       * returned, shrunk if it has to be, for the same reason `get_flow` always
       * returns its first step: a reader who asked a direct question and got an
       * empty document has no way to ask a smaller one.
       */
      const sections = [];
      let used = estimateTokens(heading);
      let cut = null;
      for (const name of STEP_PARTS) {
        if (!asked.includes(name)) continue;

        const rendered = section(name);
        const cost = estimateTokens(rendered);
        const remaining = render.maxTokens - used;

        if (cost <= remaining) {
          sections.push(rendered);
          used += cost;
          continue;
        }

        if (sections.length > 0) {
          cut = name;
          break;
        }

        const fitted = fitPart(name, Math.max(200, remaining));
        sections.push(fitted);
        used += estimateTokens(fitted);
      }

      const tail = cut
        ? `\n\nStopped before "${cut}" — the parts above already fill this response. Ask for it on its own.`
        : '';

      return text(`${heading}\n\n${sections.join('\n\n')}${tail}`);
    }

    case 'get_source_snippet': {
      /*
       * Refused outright when this server is reachable over a network.
       *
       * Everything else here answers out of `~/.devflow/flows`, which is the
       * data the caller sent in the first place. This one reads the machine's
       * own source, and in remote mode the caller is not the person sitting at
       * that machine. `DEVFLOW_PROJECT_ROOT` is the deployment saying otherwise
       * deliberately, and it is the only thing that can — a `root` argument
       * would let the caller choose, which is the whole of the problem.
       */
      if (REMOTE && !PROJECT_ROOT_ENV) {
        return failure(
          'get_source_snippet is off on a remote server: it reads source files from the machine the ' +
            'server runs on, which is not the machine the caller is working on. Set DEVFLOW_PROJECT_ROOT ' +
            'on the deployment if the source really is there. Every other tool answers from the ' +
            'recordings and is unaffected.',
        );
      }

      const root = REMOTE
        ? PROJECT_ROOT_ENV
        : typeof args.root === 'string' && args.root.trim()
          ? path.resolve(args.root.trim())
          : (PROJECT_ROOT_ENV ?? process.cwd());

      let file = typeof args.file === 'string' ? args.file.trim() : '';
      let line = Math.trunc(Number(args.line));
      let label = '';
      /**
       * The provenance, when a component supplied the file and line — see
       * `sourceProvenance`. This tool is the only one that turns an attribution
       * into the *contents* of a file, so a reader who is about to trust these
       * lines is exactly the reader entitled to know the position came out of a
       * build step in the recorded application. Empty whenever `file` was passed
       * directly: there is no attribution to have provenance about.
       */
      let how = '';
      /** The component's own absolute path, tried when the repo-relative one does not resolve. */
      let alternate = '';

      if (!file) {
        if (typeof args.id !== 'string' || !args.id) {
          return failure(
            'get_source_snippet needs either a "file" — a path under the project root, with an ' +
              'optional "line" — or an "id" and a "step", naming the recording and the step whose ' +
              'component you want to read.',
          );
        }

        let flow;
        try {
          flow = await readFlow(args.id);
        } catch (error) {
          return readFailure(error, args.id);
        }

        const components = flow.json.react?.components ?? {};
        let component = null;

        if (typeof args.component === 'string' && args.component.trim()) {
          const wanted = args.component.trim().replace(/^#/, '');
          component =
            components[wanted] ??
            Object.values(components).find((entry) => entry.name === wanted) ??
            null;
          if (!component) {
            return failure(
              `"${flow.json.name}" records no component called "${args.component}". ` +
                'get_flow lists the components a recording met, each with its source.',
            );
          }
        } else {
          const total = flow.json.steps.length;
          const number = Math.trunc(Number(args.step));
          const step = Number.isFinite(number) ? flow.json.steps[number - 1] : undefined;
          if (!step) {
            return failure(
              `"${flow.json.name}" has no step ${args.step}. It has ${total} step${total === 1 ? '' : 's'}, numbered 1 to ${total}.`,
            );
          }
          component = stepComponent(flow.json, step);
          if (!component) {
            return failure(
              `Step ${number} of "${flow.json.name}" has no component attributed to it, so there is no ` +
                'source to read. Pass "file" and "line" directly, or get_flow_step for what the step does carry.',
            );
          }
          label = `step ${number}`;
        }

        if (!component.source) {
          /*
           * A component that was picked but never located is the case the
           * `detail` sentence on `ComponentSource` exists for, and repeating it
           * here is the difference between "there is no file" and "the file is
           * in a chunk that never loaded".
           */
          return failure(
            `${component.name} was never resolved to a source file` +
              (component.detail ? `: ${component.detail.replace(/\.?$/, '.')}` : '.') +
              (component.compiled ? ` The bundle position is ${formatSource(component)}.` : ''),
          );
        }

        file = component.source;
        if (typeof component.absolutePath === 'string') alternate = component.absolutePath;
        if (!Number.isFinite(line) || line < 1) line = Number(component.line) || 1;
        label = label ? `${component.name}, ${label}` : component.name;
        how = sourceProvenance(component) ?? '';
      }

      if (!Number.isFinite(line) || line < 1) line = 1;
      const asked = Number(args.radius);
      const radius = Number.isFinite(asked)
        ? Math.min(MAX_SNIPPET_RADIUS, Math.max(0, Math.trunc(asked)))
        : SNIPPET_RADIUS;

      /*
       * The map's absolute path is a second candidate, never a second rule: it
       * came off the same web page and goes through the same guard. The first
       * candidate's refusal is the one reported, because it is the path the
       * recording actually names and the one the reader is holding.
       */
      let found = await resolveSource(root, file);
      /** The candidate that actually resolved — which is what the heading may name. */
      let named = file;
      let fellBack = false;

      if (!found.file && alternate && alternate !== file) {
        fellBack = true;
        const other = await resolveSource(root, alternate);
        if (other.file) {
          found = other;
          // The heading names what was read. Printing the recorded path above
          // the contents of the file the fallback found asserts a filename that
          // was not opened, which is the one thing a snippet must never do.
          named = alternate;
        }
      }

      /*
       * The fallback is named only when it was tried and refused. Each refusal
       * here says what caused it, and "no such file" over a second candidate
       * that was silently rejected for a different reason is one cause short.
       */
      const alsoTried = fellBack && !found.file
        ? ` The absolute path the same source map recorded, ${alternate}, does not resolve under it either.`
        : '';

      if (found.reason === 'no-root') {
        return failure(
          `The project root ${root} does not exist, so there is nowhere to read ${file} from. ` +
            'Pass "root", or start the server in the project, or set DEVFLOW_PROJECT_ROOT.',
        );
      }
      if (found.reason === 'outside') {
        return failure(
          `${file} resolves outside the project root ${found.root}, and this tool reads nothing from ` +
            'outside it. That path came from the recorded page\'s own source map, so it describes ' +
            'wherever that application was built, not this checkout. Pass "root" if the source is ' +
            `somewhere else on this machine.${alsoTried}`,
        );
      }
      if (found.reason === 'not-a-file') {
        return failure(`${file} is ${found.what}, not a source file. Name the file you want to read.`);
      }
      if (found.reason === 'too-big') {
        return failure(
          `${file} is ${Math.round(found.bytes / 1024)}KB, which is a bundle rather than a source file. ` +
            'Nothing that size is read here.',
        );
      }
      if (found.reason === 'missing') {
        return failure(
          `${file} was not found under the project root ${found.root}. The recording names it because that is ` +
            'what the page\'s source map said, so either this checkout is not the application that was ' +
            `recorded, or it has moved since. Pass "root" to point at the right one.${alsoTried}`,
        );
      }

      const contents = await fs.readFile(found.file, 'utf8').catch(() => null);
      if (contents === null) {
        return failure(`${found.file} could not be read.`);
      }

      const window = snippet(contents, line, radius);
      const heading = `${named}:${line}${label ? ` — ${label}` : ''}${how ? ` (${how})` : ''}`;
      const stale = window.beyondEnd
        ? `\n\nLine ${line} is past the end of this file (${window.range}). The recording was made ` +
          'against a different build of this application than the one at this project root, so the ' +
          'lines below are the end of the file rather than the component.'
        : '';

      return text(
        `${heading}\n${found.file} · ${window.range}${stale}\n\n` +
          (window.lines.length ? `\`\`\`\n${window.lines.join('\n')}\n\`\`\`` : '(the file is empty)'),
      );
    }

    case 'get_state_patch': {
      let flow;
      try {
        flow = await readFlow(args.id);
      } catch (error) {
        return readFailure(error, args.id);
      }

      const render = renderingFor(flow.json);
      const name = flow.json.name;
      const total = flow.json.steps.length;

      /*
       * The step arguments are settled before the state ones, so a reader who
       * mistyped a step number is told that rather than told the recording has
       * no state — which would be true of a flow that does have state, and
       * would send them to the settings page to fix a typo.
       */
      const noStep = (asked) =>
        failure(
          `"${name}" has no step ${asked}. ` +
            (total
              ? `It has ${total} step${total === 1 ? '' : 's'}, numbered 1 to ${total}.`
              : 'It has no steps at all.'),
        );

      const given = (value) => value !== undefined && value !== null;
      if (given(args.step) && (given(args.from) || given(args.to))) {
        return failure(
          'get_state_patch takes either "step" for one step or "from" and "to" for a range, not both. ' +
            `Pass {"id":"${flow.json.id}","step":${args.step}} for that one step, or drop "step" for the range.`,
        );
      }

      let first;
      let last;
      if (given(args.step)) {
        first = Math.trunc(Number(args.step));
        if (!Number.isFinite(first) || !flow.json.steps[first - 1]) return noStep(args.step);
        last = first;
      } else {
        first = given(args.from) ? Math.trunc(Number(args.from)) : 1;
        last = given(args.to) ? Math.trunc(Number(args.to)) : total;
        if (!Number.isFinite(first) || !flow.json.steps[first - 1]) return noStep(given(args.from) ? args.from : 1);
        if (!Number.isFinite(last) || !flow.json.steps[last - 1]) return noStep(args.to);
        /*
         * Refused rather than sorted. A patch means something because it is in
         * the order the app moved in, so a reversed range names a sequence that
         * never happened — and quietly reversing it back hands the reader a
         * correct answer to a question they did not ask, which they then trust
         * the next time they get it wrong in a way that cannot be repaired.
         */
        if (first > last) {
          return failure(
            `That range runs backwards: "from" is step ${first} and "to" is step ${last}. These patches ` +
              'concatenate in step order and describe a sequence, so a reversed range would describe ' +
              `something that never happened. Pass {"id":"${flow.json.id}","from":${last},"to":${first}}.`,
          );
        }
      }

      const turnOn =
        'Switch "recording.state" on in the DevFlow extension\'s settings and record the journey again.';

      const state = flow.json.state;
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return text(
          `"${name}" carries no application state at all — it was recorded by a build of DevFlow that ` +
            'did not read the app\'s stores, so this is the absence of data and not the absence of ' +
            `change. Nothing was looked at. ${turnOn}`,
        );
      }

      if (state.read !== true) {
        return text(
          `State capture was switched off when "${name}" was recorded, so no store was read at any ` +
            'point in it. This is the absence of data and not the absence of change — nothing was ' +
            `looked at. ${turnOn}` +
            (typeof state.note === 'string' && state.note ? `\n\nThe recording's own note: ${state.note}` : ''),
        );
      }

      const stores = Array.isArray(state.stores) ? state.stores : [];
      if (!stores.length) {
        return text(
          `State capture ran while "${name}" was recorded and recognised no store on that page.\n\n` +
            (typeof state.note === 'string' && state.note
              ? `The recording's own note: ${state.note}\n\n`
              : 'The recording left no note saying why.\n\n') +
            'DevFlow reads Redux, Zustand, React Query and React context; an application holding its ' +
            'state anywhere else reads from here as holding none. This is not "nothing changed" — there ' +
            'was nothing to watch.',
        );
      }

      const wanted = typeof args.store === 'string' ? args.store.trim().replace(/^#/, '') : '';
      let only = null;
      if (wanted) {
        only =
          stores.find((store) => store.id === wanted) ??
          stores.find((store) => store.label === wanted) ??
          null;
        /*
         * A refusal, not an empty patch. "That store is not in this recording"
         * and "that store did not move" are the two answers a filter can give,
         * and returning the second for the first is the mistake this whole tool
         * is organised around not making.
         */
        if (!only) {
          return failure(
            `"${name}" read no store called "${args.store}". It read ${stores.length}: ` +
              `${stores.map(storeName).join(' · ')}. Answering with an empty patch would have read as ` +
              '"that store did not move", which is a different thing.',
          );
        }
      }

      const byId = new Map(stores.map((store) => [store.id, store]));
      /** One store's movement on one step, in step order, deltas kept in stored order. */
      const entries = [];
      for (let number = first; number <= last; number++) {
        const deltas = flow.json.steps[number - 1]?.state;
        if (!Array.isArray(deltas)) continue;
        for (const delta of deltas) {
          if (only && delta?.store !== only.id) continue;
          const ops = Array.isArray(delta?.patch) ? delta.patch : [];
          if (!ops.length) continue;
          entries.push({ number, delta, ops, ref: byId.get(delta.store) ?? null });
        }
      }

      const where = first === last ? `step ${first}` : `steps ${first}–${last}`;
      const heading =
        first === last
          ? `## State on step ${first} of ${total} — ${name}${flow.json.steps[first - 1].action ? `\n${flow.json.steps[first - 1].action}` : ''}`
          : `## State across steps ${first}–${last} of ${total} — ${name}`;

      if (!entries.length) {
        return text(
          `${heading}\n\n` +
            (only
              ? `${storeName(only)} did not move on ${where}.`
              : `No store moved on ${where}.`) +
            ` State capture ran and read ${stores.length} store${stores.length === 1 ? '' : 's'}: ` +
            `${stores.map(storeName).join(' · ')}.\n\n` +
            'What that means exactly: the sample taken when each interaction was dispatched and the one ' +
            'taken after the app settled were identical. A store that changed and changed back between ' +
            'those two reads looks the same from here, so this is "the two samples matched", not ' +
            '"nothing happened".',
        );
      }

      /*
       * The roster is not decoration: it is what makes "did not move" readable
       * as a fact about a store rather than as the shape of the response. It is
       * dropped from the budget last, along with the caveat, because both of
       * them qualify every number underneath.
       */
      const components = flow.json.react?.components ?? {};
      const movedIn = (id) => new Set(entries.filter((e) => e.delta.store === id).map((e) => e.number)).size;
      const listed = only ? [only] : stores;
      const roster = listed.map((store) => {
        const count = movedIn(store.id);
        const subscribers = (store.subscribers ?? [])
          .map((id) => components[id]?.name)
          .filter(Boolean);
        const read = subscribers.length
          ? `  read by ${subscribers.slice(0, 4).join(', ')}${subscribers.length > 4 ? ` (+${subscribers.length - 4} more)` : ''}`
          : '';
        return `  ${storeName(store)} — ${count ? `moved on ${count} of these steps` : 'did not move'}${read}`;
      });
      const filtered = only
        ? [
            `Filtered to this store. "${name}" also read ${stores.length - 1} other` +
              `${stores.length - 1 === 1 ? '' : 's'} — ` +
              `${stores.filter((store) => store.id !== only.id).map(storeName).join(' · ')} — and this ` +
              'response says nothing at all about them.',
          ]
        : [];

      const caveat =
        'These operate on the snapshot DevFlow took of each store — a JSON copy read off the page under ' +
        'its depth, width and string caps — and not on the live store. Within one store the blocks below ' +
        'concatenate in the order printed and the concatenation is itself a valid RFC 6902 patch: ' +
        'applying it to that store\'s snapshot at the start of this range yields its snapshot at the end. ' +
        'Across stores they do not concatenate, because each store is a separate document.';

      const preamble = [heading, '', 'Stores read:', ...roster, ...filtered, '', caveat].join('\n');

      /*
       * Cut on a step boundary, like `get_flow` and `get_flow_errors`, so the
       * "from" this response names resumes exactly where it stopped rather than
       * halfway through a step whose other stores were already printed.
       */
      const steps = [];
      for (const entry of entries) {
        const at = steps[steps.length - 1];
        if (at && at.number === entry.number) at.entries.push(entry);
        else steps.push({ number: entry.number, entries: [entry] });
      }

      const budget = render.maxTokens;
      // Room reserved for the sentence that reports the cut — an accounting
      // that overruns to say it has cut nothing is not an accounting.
      let used = estimateTokens(preamble) + 80;
      const blocks = [];
      let stopped = null;
      let partial = false;

      for (const group of steps) {
        const rendered = group.entries.map((entry) => stateBlock(entry).join('\n'));
        const cost = rendered.reduce((sum, block) => sum + estimateTokens(block) + 1, 0);

        if (used + cost <= budget) {
          blocks.push(...rendered);
          used += cost;
          continue;
        }

        if (blocks.length) {
          stopped = group.number;
          break;
        }

        /*
         * The first step is always answered, shrunk as far as it has to be, for
         * the reason `get_flow` always returns its first step: a reader who
         * asked a direct question and got an empty document has no smaller
         * question to ask next.
         */
        partial = true;
        for (const entry of group.entries) {
          const whole = stateBlock(entry).join('\n');
          const remaining = budget - used;
          if (estimateTokens(whole) <= remaining) {
            blocks.push(whole);
            used += estimateTokens(whole) + 1;
            continue;
          }
          // The very first block is shrunk rather than dropped; anything after
          // it stops the loop, and the sentence below names the step it was on.
          if (blocks.length === 0) {
            const fitted = stateBlock(entry, Math.max(200, remaining)).join('\n');
            blocks.push(fitted);
            used += estimateTokens(fitted) + 1;
          }
          break;
        }
        stopped = steps[1]?.number ?? null;
        break;
      }

      /*
       * Three different cuts and three different sentences, because the reader
       * has to know whether what is above is a whole prefix of the range, a
       * partial prefix of one step, or both. "Some of it is missing" is the
       * answer that lets a model treat an incomplete patch as a complete one.
       */
      const rest = (at) =>
        `get_state_patch({"id":"${flow.json.id}","from":${at},"to":${last}}${only ? `,"store":"${only.id}"` : ''})`;
      const budgetLine = `The response budget is ${budget} tokens ("mcp.maxTokens").`;

      let cut = '';
      if (partial && stopped !== null) {
        cut =
          `\n\nCut to fit the response budget. Step ${first} did not fit whole — what is above is a prefix ` +
          `of it — and nothing from step ${stopped} onwards is here at all. ${budgetLine} The rest of the ` +
          `range is at ${rest(stopped)}; a "store" narrows step ${first} enough to see the remainder of it.`;
      } else if (partial) {
        cut =
          `\n\nCut to fit the response budget. Step ${first} on its own does not fit, so what is above is a ` +
          'prefix of its patch and does not reconstruct the state that step ended in. ' +
          budgetLine;
      } else if (stopped !== null) {
        cut =
          `\n\nCut to fit the response budget. Stopped at step ${stopped} — the blocks above already fill ` +
          `this response, and every step from ${stopped} to ${last} is missing from it. ${budgetLine} The ` +
          `rest of the range is at ${rest(stopped)}.`;
      }

      return text(`${preamble}\n\n${blocks.join('\n\n')}${cut}`);
    }

    /*
     * The three graph tools.
     *
     * Each opens with `if (!arkg)`, and that is not the same check `arkgTry`
     * makes: a tool asked a question it structurally cannot answer says so as a
     * failure, where a tool whose answer is genuinely "nothing yet" says that as
     * text. Collapsing the two produces the worst reply of the set — an empty
     * list that reads as "your app is fine".
     */
    case 'get_causal_chain':
    case 'get_effects_of': {
      let flow;
      try {
        flow = await readFlow(args.id);
      } catch (error) {
        return readFailure(error, args.id);
      }

      const backwards = name === 'get_causal_chain';
      const graph = buildCausalGraph(flow.json);
      const byRef = new Map(graph.events.map((event) => [event.ref, event]));

      /*
       * No event named: list what there is to ask about, rather than refusing.
       *
       * A ref is a syntax, and a tool whose first answer is "that is not a
       * valid ref" has made the caller guess at one. The listing is the cheap
       * call that makes the expensive one right, exactly as `get_step_detail`
       * with no `include` prices its parts before one is asked for.
       */
      const asked = typeof args.event === 'string' ? args.event.trim() : '';
      if (!asked) return text(renderCausalIndex(flow.json, graph, backwards));

      const event = byRef.get(asked);
      if (!event) {
        return failure(
          `"${asked}" names no event in "${flow.json.name}". Call ${name} with no "event" to see the ` +
            'refs this recording has; they are of the form "step:3", "net:3.1", "log:3.2" or ' +
            '"state:3/redux:0/0", and they are derived from the step numbering, so a ref from a ' +
            'different recording will not resolve here.',
        );
      }

      const depth = Number.isFinite(Number(args.depth)) && Number(args.depth) > 0
        ? Math.trunc(Number(args.depth))
        : undefined;
      const links = backwards ? causesOf(graph, asked, depth) : effectsOf(graph, asked, depth);

      const lines = [
        `${backwards ? 'What led to' : 'What followed'} ${event.ref} — ${event.label}`,
        `Step ${event.step} of ${flow.json.steps.length} in "${flow.json.name}".`,
      ];

      if (!links.length) {
        /*
         * Nothing found is three different facts and this says which.
         *
         * An event with no cause is ordinary — a step *is* a root, the user
         * caused it — and reporting that as "nothing found" would read as a
         * failure of the analysis rather than as the answer.
         */
        lines.push(
          '',
          backwards
            ? event.kind === 'step'
              ? 'Nothing led to it: a step is where a chain starts. The user did this, and DevFlow records what followed rather than what preceded.'
              : 'Nothing in this recording links to it. It was attributed to its step, but no request named it, no response was echoed into it, and no failed call preceded it.'
            : event.kind === 'console'
              ? 'Nothing followed it. A console entry is where a chain ends — DevFlow observes what the app said, not what the app did about it.'
              : 'Nothing in this recording followed from it.',
        );
        return text(lines.join('\n'));
      }

      lines.push(
        '',
        `${links.length} link${links.length === 1 ? '' : 's'}, nearest first — each with the evidence it rests on:`,
      );
      for (const link of links) {
        const other = byRef.get(backwards ? link.from : link.to);
        lines.push(
          `  ${backwards ? link.from : link.to}  ${other ? other.label : '(unknown)'}`,
          `      ${link.basis} · ${link.confidence} confidence — ${link.detail}`,
        );
      }

      lines.push(
        '',
        'The bases, in the order they are worth trusting: "echoed" and "named" are evidence from the ' +
          'events themselves; "attributed" is only that the recorder filed them under the same step; ' +
          '"followed" is only that one came after a failed call. ' +
          `${backwards ? 'get_effects_of' : 'get_causal_chain'} walks the same graph the other way, and ` +
          'get_flow_step opens any step named above.',
      );
      return text(lines.join('\n'));
    }

    case 'get_value_provenance': {
      let flow;
      try {
        flow = await readFlow(args.id);
      } catch (error) {
        return readFailure(error, args.id);
      }

      const steps = Array.isArray(flow.json.steps) ? flow.json.steps : [];
      const asked = typeof args.value === 'string' ? args.value.trim() : '';

      /*
       * A step named instead of a value: trace what that element said.
       *
       * This is as close as a recording comes to the "DOM node id" the feature
       * was planned around. A flow describes an element — tag, text, label,
       * selector — and addresses none, so the value it showed is the handle
       * that exists, and saying that out loud is cheaper than inventing an id
       * scheme nothing else in the product uses.
       */
      let needle = asked;
      let from = '';
      if (!needle && Number.isFinite(Number(args.step))) {
        const wanted = Math.trunc(Number(args.step));
        const step = steps.find((entry, index) => stepNumberOf(entry, index) === wanted);
        if (!step) {
          return failure(
            `"${flow.json.name}" has no step ${wanted}. It has ${steps.length} step${steps.length === 1 ? '' : 's'}; get_flow lists them.`,
          );
        }
        needle = valueOfStep(step);
        from = `step ${wanted}`;
        if (!needle) {
          return failure(
            `Step ${wanted} of "${flow.json.name}" showed no text to trace — it is a navigation, a note, ` +
              'or an element with no label and no content. Call get_value_provenance with a "value" ' +
              'instead; get_flow_step returns what the step does carry.',
          );
        }
      }

      /*
       * Neither: list what there is to ask about rather than refusing.
       *
       * `get_causal_chain`'s discipline — a tool whose first answer is "that is
       * not valid" has made the caller guess. Here the caller has a screenshot
       * or a walkthrough in front of them and needs to know which of the things
       * on it this recording can actually speak to.
       */
      if (!needle) return text(renderProvenanceIndex(flow.json, steps));

      /*
       * The span store is asked here rather than inside `traceValue`, which is
       * pure and has no socket. `backend` is a required argument for the reason
       * its own header gives: optional would make forgetting it a five-layer
       * answer silently printed as four, and a layer that goes missing without
       * saying so is the exact failure the rest of this tool exists to prevent.
       */
      const result = traceValue(flow.json, needle, backendReadingFor(flow.json));
      return text(renderProvenance(flow.json, result, from));
    }

    case 'explain_feature': {
      if (!arkg) return failure(NO_GRAPH);

      const description = typeof args.description === 'string' ? args.description.trim() : '';
      if (!description) {
        return failure(
          'explain_feature needs a "description" — what you are looking for, in your own words. It ' +
            'matches your words against the names in the graph, so name the thing the way the code ' +
            'probably names it: "cart badge", "invoice totals", "the checkout flow".',
        );
      }

      const corpus = arkgTry('navigator corpus', (graph) => graph.getNamedEntities());
      if (!corpus || !corpus.entities.length) {
        return failure(
          'The knowledge graph holds nothing to search yet. Record a flow and send it, or pick a ' +
            'component in the DevFlow panel; get_app_architecture says what the graph does hold.',
        );
      }

      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
        ? Math.min(40, Math.trunc(Number(args.limit)))
        : 8;

      const query = findFeature(description, corpus.entities, limit);
      const neighbours = new Map();
      for (const match of query.matches) {
        neighbours.set(
          `${match.entity.kind}:${match.entity.id}`,
          arkgTry('navigator neighbours', (graph) =>
            graph.getNeighbours(match.entity.kind, match.entity.id),
          ) ?? [],
        );
      }

      return text(renderFeature(description, query, neighbours, corpus));
    }

    case 'suggest_actions': {
      const metas = await listAllFlows();
      if (!metas.length) {
        return text(
          `No flows recorded yet (looking in ${FLOWS_DIR}). This tool reads what people have actually ` +
            'done on a page, so it has nothing to offer until a recording has been sent.',
        );
      }

      /*
       * The most recent recordings, and no more.
       *
       * Every flow read is a `flow.json` off disk, and a library of two hundred
       * is a library rather than an investigation. The bound is said out loud
       * below when it bit, for `explain_feature`'s reason: a tool that answers
       * "nothing was recorded on that page" about flows it never opened has
       * given the one wrong answer available to it.
       */
      const READ_FLOWS = 25;
      const opened = metas.slice(0, READ_FLOWS);

      const observed = [];
      for (const meta of opened) {
        try {
          const { json } = await readFlow(meta.id);
          observed.push({
            id: meta.id,
            name: typeof json.name === 'string' ? json.name : meta.id,
            steps: Array.isArray(json.steps) ? json.steps : [],
          });
        } catch {
          // A flow whose steps cannot be read contributes nothing and is not an
          // error: the other twenty-four still answer the question.
        }
      }

      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
        ? Math.min(100, Math.trunc(Number(args.limit)))
        : 20;

      const plan = planActions(
        observed,
        {
          ...(typeof args.url === 'string' && args.url ? { url: args.url } : {}),
          ...(typeof args.component === 'string' && args.component ? { component: args.component } : {}),
        },
        limit,
      );

      return text(renderActions(plan, args, observed.length, metas.length - opened.length));
    }

    case 'replay_flow': {
      let flow;
      try {
        flow = await readFlow(args.id);
      } catch (error) {
        return readFailure(error, args.id);
      }

      const root = PROJECT_ROOT_ENV ?? process.cwd();

      /*
       * Loaded here rather than at the top of the file, the way `arkg.js` is.
       *
       * The module spawns processes, and a server nobody has switched replay on
       * for should not have it in memory at all — but more than that, a publish
       * that omits `replay.js` must fail *this tool* rather than the server's
       * startup, so the ninety-nine people who never enable it are unaffected
       * by a mistake that only reaches the one who did.
       */
      let replay;
      try {
        replay = await import('./replay.js');
      } catch (error) {
        return failure(
          `The replay module could not be loaded (${error.message}). This is a packaging fault in the ` +
            'server rather than anything about your recording.',
        );
      }

      const ready = await replay.replayReady(root);
      if (!ready.ok) return failure(ready.reason);

      const steps = Array.isArray(flow.json.steps) ? flow.json.steps : [];
      const plan = planReplay(flow.json.id ?? args.id);
      const source = generatePlaywrightTest(steps, flow.json.name ?? 'DevFlow recorded flow');

      let spec;
      try {
        spec = await replay.writeSpec(root, plan.specPath, source);
      } catch (error) {
        return failure(`The replay spec could not be written: ${error.message}`);
      }

      const run = await replay.runCommand({
        executable: ready.runner,
        args: plan.args,
        cwd: root,
        timeoutMs: Number(args.timeoutMs),
      });

      return text(renderReplay(flow.json, steps, spec, run, root));
    }

    case 'diagnose_failure': {
      let flow;
      try {
        if (args.id) {
          flow = await readFlow(args.id);
        } else {
          const recent = await listAllFlows();
          if (!recent.length) {
            return text(
              `No flows recorded yet (looking in ${FLOWS_DIR}). Record one and send it, then ask again.`,
            );
          }
          flow = await readFlow(recent[0].id);
        }
      } catch (error) {
        return readFailure(error, args.id);
      }

      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
        ? Math.min(25, Math.trunc(Number(args.limit)))
        : 5;

      /*
       * The causal graph is built once for the whole recording rather than per
       * failure: it is derived from the flow and a second build would be a
       * second walk of the same events for the same answer.
       */
      const graph = buildCausalGraph(flow.json);
      const byRef = new Map(graph.events.map((event) => [event.ref, event]));

      /*
       * One entry per event, keeping the nearest.
       *
       * `causesOf` walks a graph, so one event can be reached by two paths —
       * the click that opened the step and the request that step made both lead
       * back to the click. Printed as they arrive, the same ref appears twice
       * and reads as two pieces of evidence rather than one event reached
       * twice, which is precisely the kind of inflation a diagnosis must not
       * do. The first is kept because the walk is nearest-first.
       */
      const evidenceFor = (ref) => {
        const seen = new Set();
        const out = [];
        for (const link of causesOf(graph, ref)) {
          if (seen.has(link.from)) continue;
          seen.add(link.from);
          out.push({
            ref: link.from,
            label: byRef.get(link.from)?.label ?? '(unknown)',
            basis: link.basis,
            detail: link.detail,
          });
        }
        return out;
      };

      /*
       * The graph is optional and stays optional. Every other ARKG reader here
       * goes through `arkgTry`; a diagnosis without history is a smaller
       * answer, and `standing: 'unknown'` is a state this feature is built to
       * report rather than one it falls over on.
       */
      const historyFor = (kind, key) =>
        arkgTry('diagnosis history', (known) => known.getFailureHistory?.(kind, key) ?? null, null);

      const diagnoses = diagnose(flow.json, { evidenceFor, historyFor }, limit);
      return text(renderDiagnosis(flow.json, diagnoses, limit));
    }

    case 'get_backend_trace': {
      let flow;
      try {
        flow = await readFlow(args.id);
      } catch (error) {
        return text(error.message);
      }

      /*
       * `flow.json`, not `flow`. `readFlow` returns `{ dir, json }`, so the old
       * call handed the wrapper to a function that reads `.steps` off it — and
       * a function that treats a missing `steps` as an empty recording answers
       * "no call in this recording carried a trace id" for every recording
       * there has ever been. The tool has never printed a span. Nothing caught
       * it because the wrong answer is the same sentence as the common right
       * one, which is the failure mode this whole file's "name the nothings"
       * discipline exists to make visible and could not see from inside.
       */
      const all = tracedCallsOf(flow.json);
      const calls =
        typeof args.step === 'number' ? all.filter((call) => call.step === args.step) : all;

      /*
       * Three refusals before any span is read, because each sends the reader
       * somewhere different and only one of them is about spans at all.
       */
      if (!otelmod || !otelmod.OTEL_ENABLED) {
        return text(
          'Span ingest is off, so this server holds no backend traces.\n\n' +
            'Start the DevFlow MCP server with `DEVFLOW_OTEL=1` and point your backend\u2019s OTLP ' +
            'exporter at `POST /v1/traces` on this port, with ' +
            '`OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json`.' +
            (all.length
              ? `\n\nThis recording does carry ${all.length} traced call(s), so once ingest is on and the backend is exporting, re-send the recording to join them.`
              : '\n\nThis recording also carries no traced calls \u2014 see below.'),
        );
      }
      if (!all.length) {
        return text(
          'No call in this recording carried a trace id, so there is nothing to join spans to.\n\n' +
            'Trace headers are off by default, are added only while a flow is recording, and are ' +
            'added to a cross-origin request only for an origin named in the allow-list. Turn them ' +
            'on in DevFlow\u2019s settings and record again.',
        );
      }
      if (!calls.length) {
        return text(
          `No call in step ${args.step} carried a trace id. Traced calls in this recording are in ` +
            `step(s) ${[...new Set(all.map((call) => call.step))].join(', ')}.`,
        );
      }

      const spans =
        otelTry('read held spans', (o) => o.spansForTraces(calls.map((c) => c.traceId)), []) ?? [];
      const { joined, awaiting } = joinTrace({ calls, spans });

      const sections = joined.map((join) => {
        const head =
          `### Step ${join.call.step} \u2014 ${join.call.method} ${urlPath(join.call.url)}\n` +
          `trace \`${join.call.traceId}\` \u00b7 ${join.spans.length} span(s) \u00b7 ` +
          `service(s): ${join.services.join(', ')}`;
        const lines = flattenSpanLines(join.roots);
        return `${head}\n\n${lines}`;
      });

      /*
       * `awaiting` is printed as its own paragraph and never folded into "no
       * data". A traced call with no spans means the exporter has not sent
       * them, is not pointed here, or sampled the trace away \u2014 which is a
       * different errand from turning the header on, and a reader told the
       * wrong one goes and changes a setting that was already correct.
       */
      const pending = awaiting.length
        ? `\n\n**${awaiting.length} traced call(s) have no spans yet.** The recording carried the ` +
          `id, so the header went out; nothing has arrived under it. Either the backend is not ` +
          `exporting to this server, or it sampled the trace away, or the spans are still in a ` +
          `batch. Re-send this recording after they arrive and they will join.`
        : '';

      if (!sections.length) {
        return text(`No spans have arrived for this recording\u2019s traced calls.${pending}`);
      }
      return text(
        `## Backend trace \u2014 ${flow.json.name ?? args.id}\n\n${sections.join('\n\n')}${pending}`,
      );
    }

    case 'get_living_architecture': {
      /*
       * The three answers below are three different situations and a reader who
       * cannot tell them apart assumes the worst of them — the shape
       * `getAnomalyReport` was built into and `stateNote` has in the page agent.
       *
       * No reading at all is not "the app has no components": it is nobody
       * having taken one, and the next move is a button in the panel. A URL
       * filter that matched nothing is not an empty app either — it is a typo or
       * a page that has not been read — and it names what *is* held so the
       * reader can see which.
       */
      if (!architectureReadings.size) {
        return text(
          'No architecture reading has been taken. This map is read on demand from an open page rather than accumulated, so there is nothing here until somebody takes one: open the DevFlow panel in Chrome DevTools on the page in question and press "Read architecture". Nothing is stored between server restarts, by design — a saved map would describe a page that is no longer open.',
        );
      }

      const held = [...architectureReadings.values()].sort((a, b) => b.takenAt - a.takenAt);
      const wanted = typeof args?.url === 'string' ? args.url.trim().toLowerCase() : '';
      const matched = wanted ? held.filter((reading) => reading.url.toLowerCase().includes(wanted)) : held;

      if (!matched.length) {
        return failure(
          `No reading is held for a URL containing "${args.url}". ` +
            `Readings are held for: ${held.map((reading) => reading.url).join(', ')}.`,
        );
      }

      const [freshest, ...rest] = matched;
      return text(renderArchitecture(freshest, Date.now(), rest.map((reading) => reading.url)));
    }

    case 'get_app_architecture': {
      if (!arkg) return failure(NO_GRAPH);

      const arch = arkgTry('architecture', (graph) => graph.getAppArchitecture());
      if (!arch) return text(EMPTY_GRAPH);

      /*
       * A graph with components and no flows is a real state, not an empty one:
       * every component below was picked in the panel while somebody read the
       * code. Saying "0 flows observed" and then listing them would read as a
       * contradiction, so the header names what this graph is made of and what
       * is missing from it — the endpoints and the edges between them, which
       * only a recording carries.
       */
      const lines = [
        arch.totalFlows
          ? `Knowledge graph — ${arch.totalFlows} flow${arch.totalFlows === 1 ? '' : 's'} observed` +
            `${arch.lastSeen ? `, latest ${arch.lastSeen}` : ''}.`
          : `Knowledge graph — no recorded flow yet, and ${arch.totalComponents} component` +
            `${arch.totalComponents === 1 ? '' : 's'} seen by picking in the DevTools panel` +
            `${arch.lastSeen ? `, latest ${arch.lastSeen}` : ''}. Send a recording to Claude and ` +
            'the endpoints each one calls, and the flows they appear in, are added to what is below.',
      ];

      if (arch.topComponents.length) {
        lines.push('', 'Components, most seen first — name, times seen, failure rate, source, id:');
        for (const component of arch.topComponents) {
          lines.push(
            `  ${component.name}  ${component.frequency}x${failPct(component.failureRate)}` +
              `${component.source ? `  ${component.source}` : ''}  #${component.id}`,
          );
          for (const call of component.calls) {
            lines.push(`      calls ${call.endpoint}  ${call.frequency}x${failPct(call.failureRate)}`);
          }
        }
      }

      if (arch.topEndpoints.length) {
        lines.push('', 'Endpoints, most called first — route, times called, p50/p95, failure rate:');
        for (const endpoint of arch.topEndpoints) {
          const p50 = endpoint.timingP50Ms ? Math.round(endpoint.timingP50Ms) : null;
          const p95 = endpoint.timingP95Ms ? Math.round(endpoint.timingP95Ms) : null;
          lines.push(
            `  ${endpoint.name}  ${endpoint.frequency}x` +
              `${p50 ? `  ${p50}/${p95 ?? '—'}ms` : ''}${failPct(endpoint.failureRate)}`,
          );
        }
      }

      /*
       * State keys, and the two numbers that are not the same question.
       *
       * `frequency` is how many recordings held this key at all; `changeCount`
       * is how many steps across them actually wrote to it. A key present in
       * every recording and never written is the least interesting row in the
       * graph, and a summary that printed only "seen" could not tell it from
       * the one the bug is in. Absent entirely on a graph with no state, which
       * is how every graph built before this reads.
       */
      if (arch.topStateKeys?.length) {
        lines.push('', 'State keys, most changed first — key, store, steps that changed it, recordings seen in:');
        for (const key of arch.topStateKeys) {
          lines.push(`  ${key.key}  ${key.store}  ${key.changeCount} changed  ${key.frequency} seen`);
        }
      }

      /*
       * The backend, when there is one, and absent entirely when there is not.
       *
       * A graph with no services is not an application with no backend — it is
       * one whose spans DevFlow has never been sent, which is the state every
       * graph built before Tier 2 is in. So this section does not appear at all
       * rather than printing a zero, for the reason the state-keys section
       * above does not: a heading with nothing under it reads as a finding.
       */
      const services = arkgTry('services', (graph) => graph.getServices?.() ?? [], []) ?? [];
      if (services.length) {
        lines.push(
          '',
          'Backend services, from spans your own tracer exported — service, operations, recordings seen in:',
        );
        for (const service of services) {
          lines.push(
            `  ${service.name}${service.environment ? ` (${service.environment})` : ''}` +
              `  ${service.operationCount ?? 0} operation(s)  ${service.frequency}x`,
          );
        }
      }

      // The drill-down, named: a summary that does not say what to ask next is
      // read as the whole of what is known.
      lines.push(
        '',
        'get_component_history takes a name or an id from above; get_anomalies says what has moved recently.' +
          (services.length ? ' get_backend_trace shows the server-side span tree for one recording.' : '') +
          (arch.topStateKeys?.length
            ? ' get_state_patch shows what one step did to a store, in the recording it did it in.'
            : ''),
      );
      return text(lines.join('\n'));
    }

    case 'get_component_history': {
      if (!arkg) return failure(NO_GRAPH);

      const asked = typeof args.componentId === 'string' ? args.componentId.trim() : '';
      if (!asked) {
        return failure(
          'get_component_history needs a componentId: a component name, or an id from get_app_architecture.',
        );
      }

      /*
       * A name or an id, because the id is a hash and the name is what the
       * reader has in front of them — in a stack trace, in a flow, in the file
       * they are already looking at. A tool that takes only the hash needs
       * another call before it can be used at all, which on a 20-component
       * summary is 500 tokens spent to ask one question.
       *
       * Both lookups are the graph's own. The name used to be resolved through
       * `getAppArchitecture`, which reached only the twenty busiest components
       * and only once a flow had been ingested — so a component known solely
       * from picks could not be asked about by either argument.
       */
      const wanted = asked.replace(/^#/, '');
      const component =
        arkgTry('component', (graph) => graph.getComponent(wanted)) ??
        arkgTry('component by name', (graph) => graph.getComponentByName(wanted));

      if (!component) {
        return text(
          `Nothing is recorded against "${asked}". get_app_architecture lists the components the ` +
            'graph has seen, each with the id it is keyed by — a component only appears there once ' +
            'a flow naming it has been sent, or it has been picked in the panel.',
        );
      }

      const since = Number(args.since);
      const window = Number.isFinite(since) && since > 0 ? since : 0;
      const history =
        arkgTry('component history', (graph) => graph.getComponentHistory(component.id, window), []) ?? [];

      const lines = [
        `${component.display_name}  ${component.frequency}x seen${failPct(component.failure_rate)}` +
          `${component.timing_p50_ms ? `  p50 ${Math.round(component.timing_p50_ms)}ms` : ''}  #${component.id}`,
        component.source_file
          ? `Source: ${component.source_file}${component.source_line ? `:${component.source_line}` : ''}`
          : 'Source: never resolved in anything observed so far.',
        `First seen ${day(component.first_observed_at)}, last seen ${day(component.last_observed_at)}.`,
      ];

      if (!history.length) {
        lines.push(
          '',
          window
            ? 'It appears in no flow observed since that timestamp — it may have been seen only before then, or only from a pick in the panel.'
            : 'It appears in no recorded flow: everything above came from picking it in the DevTools panel.',
        );
        renderEdges(lines, component);
        return text(lines.join('\n'));
      }

      lines.push(
        '',
        `In ${history.length} recorded flow${history.length === 1 ? '' : 's'} — id, name, date, steps, failures:`,
      );
      for (const flow of history) {
        lines.push(
          `  ${flow.id}  ${flow.name}  ${day(flow.created_at)}  ${flow.step_count} steps` +
            `${flow.failure_count ? `, ${flow.failure_count} failures` : ''}`,
        );
      }
      renderEdges(lines, component);
      lines.push('', 'get_flow with one of those ids opens the recording itself.');
      return text(lines.join('\n'));
    }

    case 'get_commit_candidates': {
      if (!arkg) return failure(NO_GRAPH);

      const askedComponent = typeof args.componentId === 'string' ? args.componentId.trim() : '';
      const askedFile = typeof args.file === 'string' ? args.file.trim() : '';
      if (!askedComponent && !askedFile) {
        return failure(
          'get_commit_candidates needs a componentId (a name, or an id from get_app_architecture) or a file.',
        );
      }

      const observedFiles = arkgTry('observed files', (graph) => graph.getObservedFiles(), {}) ?? {};
      const known = Object.keys(observedFiles);

      /*
       * A component or a file, and the component is resolved to its file rather
       * than answered separately: git changes files, so the file is the only
       * thing the walk can be matched against. What the component adds is the
       * anchor — its `git_sha`, the last commit it was observed at with a clean
       * tree — which is the entire reason this answer is worth more than a
       * `git log`.
       */
      let subject;
      if (askedComponent) {
        const wanted = askedComponent.replace(/^#/, '');
        const component =
          arkgTry('component', (graph) => graph.getComponent(wanted)) ??
          arkgTry('component by name', (graph) => graph.getComponentByName(wanted));

        if (!component) {
          return text(
            `Nothing is recorded against "${askedComponent}". get_app_architecture lists the components ` +
              'the graph has seen, each with the id it is keyed by.',
          );
        }
        if (!component.source_file) {
          return text(
            `${component.display_name} has been observed ${component.frequency}x but never resolved to a ` +
              'source file, so there is no file to ask git about. That is a source-mapping failure rather ' +
              'than a missing commit — the flow’s component table says which way it failed, and ' +
              'get_component_history is the whole of what the graph holds about it.',
          );
        }
        subject = {
          kind: 'component',
          name: component.display_name,
          file: component.source_file,
          line: component.source_line ?? null,
          observedSha: component.git_sha ?? null,
          frequency: component.frequency ?? null,
          failureRate: component.failure_rate ?? null,
          lastObservedAt: component.last_observed_at ?? null,
        };
      } else {
        const node = matchSourceFile(known, askedFile);
        if (!node) {
          return text(
            `The graph has no source file matching "${askedFile}". It knows a file only once a component ` +
              'has been resolved into it — by recording a flow that rendered one, or picking one in the ' +
              'DevTools panel. get_app_architecture names the files it does hold.',
          );
        }
        const row = arkgTry('source file', (graph) => graph.getSourceFile(node));
        subject = {
          kind: 'source_file',
          name: node,
          file: node,
          line: null,
          observedSha: row?.git_sha ?? null,
          frequency: row?.frequency ?? null,
          failureRate: null,
          lastObservedAt: row?.last_observed_at ?? null,
        };
      }

      const askedLimit = Number(args.limit);
      const walkLimit = Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(1000, Math.trunc(askedLimit)) : 200;

      const root = gitRoot();
      const walk = await gitTry('recent commits', (g) => g.recentCommits(root, walkLimit), null);
      if (!walk) {
        return text(
          renderForensics(
            rankCandidates({
              subject,
              commits: [],
              anchorCommittedAt: null,
              walked: 0,
              capped: false,
              gitProblem:
                'git could not be read here — it is switched off with DEVFLOW_GIT=0, is not on the PATH, ' +
                'or this server is not running inside a repository',
            }),
          ),
        );
      }

      /*
       * The prefix, because git prints repository-relative paths and a source
       * map names project-relative ones. Without it the two never meet in a
       * monorepo, which is the shape most likely to have history worth reading.
       */
      const checkout = await readStamp();
      const prefix = checkout?.prefix ?? '';
      const graphShas = arkgTry('commit shas', (graph) => graph.getCommitShas(), new Set()) ?? new Set();

      const commits = [];
      walk.forEach((change, walkIndex) => {
        const touched = change.files.some((file) => {
          const relative = projectRelative(prefix, file);
          return relative !== null && matchSourceFile(known, relative) === subject.file;
        });
        if (!touched) return;
        commits.push({
          sha: change.commit.sha,
          shortSha: shortSha(change.commit.sha),
          subject: change.commit.subject,
          author: change.commit.author,
          committedAt: change.commit.committedAt,
          inGraph: graphShas.has(change.commit.sha),
          // Its place in the whole walk, not among the commits that touched
          // this file: ancestry is a fact about the history, and an index into
          // a filtered list would compare two different sequences.
          walkIndex,
        });
      });

      /*
       * The anchoring commit's date, from the walk when it is inside the window
       * and from the graph's own commit node when it is not. A sighting six
       * months old is exactly the case this tool exists for, so failing to date
       * it would lose the answer precisely when it matters most.
       */
      let anchorCommittedAt = null;
      let anchorIndex = null;
      if (subject.observedSha) {
        const at = walk.findIndex((change) => change.commit.sha === subject.observedSha);
        anchorIndex = at === -1 ? null : at;
        anchorCommittedAt =
          (at === -1 ? null : walk[at].commit.committedAt) ??
          arkgTry('commit node', (graph) => graph.getCommit(subject.observedSha))?.committed_at ??
          null;
      }

      return text(
        renderForensics(
          rankCandidates({
            subject,
            commits,
            anchorIndex,
            anchorCommittedAt,
            walked: walk.length,
            capped: walk.length >= walkLimit,
          }),
        ),
      );
    }

    case 'get_blast_radius': {
      if (!arkg) return failure(NO_GRAPH);

      const askedFile = typeof args.file === 'string' ? args.file.trim() : '';
      if (!askedFile) {
        return failure('get_blast_radius needs a file — get_app_architecture names the ones the graph holds.');
      }

      const start = Number(args.lineStart);
      const end = Number(args.lineEnd);
      const hasStart = Number.isFinite(start);
      const hasEnd = Number.isFinite(end);
      /*
       * One bound alone is refused rather than treated as the whole file. A
       * caller who asked for lines 40 upward and silently got every component
       * in the file would read a wider answer as a narrower one, which is the
       * failure this whole tool's closing paragraph is about.
       */
      if (hasStart !== hasEnd) {
        return failure(
          'get_blast_radius takes lineStart and lineEnd together or neither. One bound alone would be ' +
            'answered as the whole file, which reads like a narrower answer than it is.',
        );
      }

      const observedFiles = arkgTry('observed files', (graph) => graph.getObservedFiles(), {}) ?? {};
      const node = matchSourceFile(Object.keys(observedFiles), askedFile);
      if (!node) {
        return text(
          renderBlastRadius({
            file: askedFile,
            lineStart: null,
            lineEnd: null,
            components: [],
            fileKnown: false,
          }),
        );
      }

      const lineStart = hasStart ? Math.trunc(start) : null;
      const lineEnd = hasEnd ? Math.trunc(end) : null;
      const rows =
        (lineStart !== null && lineEnd !== null
          ? arkgTry('blast radius', (graph) => graph.getBlastRadius(node, lineStart, lineEnd), [])
          : arkgTry('blast radius', (graph) => graph.getBlastRadius(node), [])) ?? [];

      const components = rows.map((row) => ({
        id: row.id,
        name: row.display_name,
        line: row.source_line ?? null,
        frequency: row.frequency ?? 1,
        failureRate: row.failure_rate ?? 0,
        /*
         * One hop, and only the two edge kinds that say what this component
         * *did* — what it called and what it read. `maps_to` would print the
         * file the caller just named back at them, and `renders` is the DOM
         * rather than the application.
         */
        reaches: (arkgTry('neighbours', (graph) => graph.getNeighbours('component', row.id, 12), []) ?? [])
          .filter((edge) => edge.edge === 'calls' || edge.edge === 'subscribes_to')
          .map((edge) => ({ edge: edge.edge, label: edge.label ?? edge.id, frequency: edge.frequency ?? 1 })),
      }));

      /*
       * What production says about this file, under the same answer.
       *
       * Not a second tool, and the boundary is what makes that right rather
       * than merely tidy: `get_blast_radius` is the "what should I know before
       * I change this file" question, and a crash somebody's users are hitting
       * in it is the most important possible answer to that. The two counts are
       * kept visibly apart — DevFlow's observations and a provider's production
       * events are different units and are never added.
       */
      const production = arkgTry('production errors', (graph) => graph.getProductionErrors(node), []) ?? [];
      const rendered = renderBlastRadius({ file: node, lineStart, lineEnd, components, fileKnown: true });

      if (!production.length) return text(rendered);

      const lines = [
        rendered,
        '',
        `${production.length} production issue${production.length === 1 ? '' : 's'} reach this file:`,
      ];
      for (const issue of production) {
        lines.push(
          `  ${describeProductionError({
            type: issue.error_type,
            culprit: issue.culprit,
            count: issue.event_count,
            level: issue.level,
            lastSeenMs: issue.last_seen_at,
          })}`,
        );
        if (issue.url) lines.push(`      ${issue.url}`);
      }
      lines.push(
        '',
        'Those counts are events a provider saw in production. The observation counts above are ' +
          'recordings DevFlow made. They are different units and are never added.',
      );
      return text(lines.join('\n'));
    }

    case 'get_anomalies': {
      if (!arkg) return failure(NO_GRAPH);

      const asked = Number(args.since);
      const since = Number.isFinite(asked) && asked > 0 ? asked : null;
      const window = since ? `since ${day(since)}` : 'in the last 24 hours';
      /*
       * The report rather than the bare array, because the empty list is two
       * different answers — nothing is wrong, and nothing had enough history to
       * be judged — and only `examined`/`tooNew` can say which one this is. The
       * array is still what the graph's own `getAnomalies` returns and what
       * every other caller reads; this is the one place the difference is worth
       * the extra fields.
       */
      const report = arkgTry(
        'anomalies',
        (graph) => (since === null ? graph.getAnomalyReport() : graph.getAnomalyReport(since)),
        null,
      );
      if (!report) return failure('The knowledge graph could not be read for anomalies.');

      const { anomalies, examined, tooNew, minObservations } = report;
      /** What was in the window but too young to judge, said the same way everywhere. */
      const young = tooNew
        ? `${tooNew} more ${tooNew === 1 ? 'was' : 'were'} observed with fewer than ${minObservations} ` +
          `observations, so nothing was judged about ${tooNew === 1 ? 'it' : 'them'}.`
        : null;

      if (!anomalies.length) {
        if (examined === 0) {
          return text(
            `Nothing was examined ${window}: ${
              tooNew
                ? `${tooNew} entit${tooNew === 1 ? 'y was' : 'ies were'} observed, and none has reached the ` +
                  `${minObservations} observations an entity needs before it has a baseline to deviate from.`
                : 'no component or endpoint was observed at all, so nothing reached the ' +
                  `${minObservations} observations a baseline needs.`
            } This is "nothing is known yet", not "nothing is wrong". ` +
              'get_app_architecture says how much has been observed so far.',
          );
        }
        return text(
          `Nothing is behaving unusually ${window}. ${examined} entit${examined === 1 ? 'y' : 'ies'} had ` +
            `${minObservations} or more observations and ${examined === 1 ? 'was' : 'were'} judged` +
            `${young ? `; ${young}` : '.'}`,
        );
      }

      const lines = [
        `${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'} ${window} — what, which, why:`,
        '',
      ];
      for (const item of anomalies) {
        lines.push(
          `  ${item.type === 'component' ? 'component' : 'endpoint '}  ${item.name}  ` +
            `${item.issue.replace(/_/g, ' ')}: ${item.detail}${item.source ? `  ${item.source}` : ''}`,
        );
      }
      lines.push(
        '',
        `Out of ${examined} entit${examined === 1 ? 'y' : 'ies'} with enough history to judge.` +
          (young ? ` ${young}` : ''),
        '',
        'get_component_history for a component named here; get_flow_errors on a recent flow for the failures themselves.',
      );
      return text(lines.join('\n'));
    }

    default:
      return failure(`Unknown tool: ${name}`);
  }
});

if (!REMOTE) {
  await mcpServer.connect(new StdioServerTransport());
}
