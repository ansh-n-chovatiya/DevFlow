#!/usr/bin/env node
/**
 * FlowSnap MCP server — recorded browser flows, as tools Claude can call.
 *
 * LOCAL (default): stdio MCP, plus an HTTP receiver on 127.0.0.1:7734 that the
 * Chrome extension POSTs recordings to.
 *
 *   npx flowsnap-mcp install
 *
 * which is `claude mcp add flowsnap --scope user -- npx -y flowsnap-mcp` with
 * the scope no longer something a person can leave off. See `install.js`.
 *
 * REMOTE: SSE MCP and the receiver on $PORT, for a hosted deployment.
 *
 *   MCP_MODE=remote node server.js
 *
 * Flows are written to ~/.flowsnap/flows, not next to this file: under npx the
 * package lives in a cache directory that gets cleared without warning, which
 * would take every recording with it. FLOWSNAP_DIR overrides the location.
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
  callFailed,
  compactBody,
  DEFAULTS,
  describeStamp,
  exportToMarkdown,
  fieldFor,
  flowRendering,
  formatSource,
  MACHINE_KEYS,
  renderComponents,
  renderStep,
  resolve as resolveSettings,
  urlPath,
} from './core.js';

/*
 * The CLI verbs, before anything else in this file happens.
 *
 * Everything below makes a directory, reads a config file and binds a port, all
 * at the top level, because that is what a server started by an MCP client
 * should do the moment it is started. `npx flowsnap-mcp install` should do none
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
  const { run } = await import('./install.js');
  process.exit(run(process.argv[2], process.argv.slice(3)));
}

const { version: VERSION } = createRequire(import.meta.url)('./package.json');
const REMOTE = process.env.MCP_MODE === 'remote';
const HOME = process.env.FLOWSNAP_DIR
  ? path.resolve(process.env.FLOWSNAP_DIR)
  : path.join(os.homedir(), '.flowsnap');
const FLOWS_DIR = path.join(HOME, 'flows');
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
 *     `~/.flowsnap/config.json`, which `POST /config` writes and this file
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
 * `FLOWSNAP_MAX_TOKENS` predates the mechanism and keeps its name.
 *
 * The last three are the machine-wide keys. They used to be read straight from
 * `process.env` further up this file, which is why `config.json` naming one had
 * to be announced and ignored; they come through the ordinary chain now, so a
 * variable still beats the file and the file finally reaches something.
 * `PORT` is not here: it belongs to remote mode, where the port is how MCP
 * itself is served and no settings layer may move it.
 */
const ENV_SETTINGS = {
  FLOWSNAP_MAX_TOKENS: 'mcp.maxTokens',
  FLOWSNAP_RAW: 'mcp.raw',
  FLOWSNAP_MAX_IMAGES: 'mcp.maxImages',
  FLOWSNAP_BODY_LIMIT: 'mcp.bodyLimit',
  FLOWSNAP_MAX_RESPONSE_BODY: 'mcp.maxResponseBody',
  FLOWSNAP_MAX_CONSOLE_ENTRIES: 'mcp.maxConsoleEntries',
  FLOWSNAP_PORT: 'mcp.port',
  FLOWSNAP_MAX_FLOWS: 'mcp.maxFlows',
  FLOWSNAP_MAX_BYTES: 'mcp.maxFlowBytes',
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
 * `FLOWSNAP_RAW=maybe` producing the default while looking set is exactly the
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
 * FlowSnap and is not this server's to complain about.
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
  process.stderr.write(`FlowSnap: ${message}\n`);
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
    'it is not reporting a clean run. Re-send the flow from the FlowSnap extension with those switches on.'
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
  const failing = flow.steps
    .map((step, i) => ({ step, number: i + 1 }))
    .filter(({ step }) => consoleErrors(step).length > 0 || failedCalls(step).length > 0);

  if (!failing.length) return null;

  const shapes = new Map();
  for (const { step } of failing) {
    for (const call of failedCalls(step)) {
      const key = `${call.method || 'GET'} ${urlPath(call.url) || call.url} → ${call.status ?? 'no response'}`;
      shapes.set(key, (shapes.get(key) ?? 0) + 1);
    }
  }

  const messages = new Set();
  for (const { step } of failing) {
    for (const entry of consoleErrors(step)) messages.add(truncate(entry.args.join(' '), 120));
  }

  const first = failing[0];
  const parts = [`${failing.length} of ${flow.steps.length} steps failed`];

  const ranked = [...shapes.entries()].sort((a, b) => b[1] - a[1]);
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
 */
function compareFlows(working, broken) {
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
        `where the working run has "${workingSteps[shared] ?? '(working run ends)'}".`,
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
  if (onlyBroken.length) lines.push('', '**Only the broken run calls:**', ...onlyBroken.map((c) => `- ${c}`));
  if (onlyWorking.length)
    lines.push('', '**Only the working run calls:**', ...onlyWorking.map((c) => `- ${c}`));

  // ── console ──
  const messages = (flow) =>
    new Set(flow.steps.flatMap((step) => consoleErrors(step).map((e) => truncate(e.args.join(' '), 200))));

  const workingErrors = messages(working);
  const newErrors = [...messages(broken)].filter((message) => !workingErrors.has(message));
  if (newErrors.length) {
    lines.push('', '**Errors only the broken run logs:**', ...newErrors.map((m) => `- ${m}`));
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
        'trace in either — compare the screenshots, or record the broken run again with ' +
        'network and console switched on.',
    );
  }

  return lines.join('\n');
}

/** Sections the extension can leave out of a send, in the order it names them. */
const OMITTABLE = ['images', 'network', 'logs', 'react'];

async function saveFlow(flow) {
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
     * not recognise would silently unlabel a flow recorded by a newer FlowSnap
     * than itself, which `npx -y flowsnap-mcp` makes an ordinary situation
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
    schemaVersion: flow.schemaVersion ?? 1,
  };

  // Additive, and absent entirely when the page was not React — which is also
  // how every flow recorded before this existed reads.
  const data = { ...meta, steps: stepsClean, ...(flow.react ? { react: flow.react } : {}) };

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
   * directory outlives any one server: `npx -y flowsnap-mcp` resolves to
   * whatever npm has cached, a second checkout can run an older build against
   * the same `~/.flowsnap`, and a downgrade is one `npm install` away. In every
   * one of those an older server reads a newer flow, finds the fields it knows,
   * and answers questions about it with confidence — which is the one failure
   * this file spends the rest of its length refusing.
   */
  if (Number(json.schemaVersion ?? 1) > SUPPORTED_SCHEMA) {
    throw new UnsupportedFlow(
      `"${json.name ?? id}" was recorded in format v${json.schemaVersion}, and flowsnap-mcp ` +
        `${VERSION} understands up to v${SUPPORTED_SCHEMA}. Reading it would mean guessing at ` +
        `fields this build does not know. Update the server: npx -y flowsnap-mcp@latest`,
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
        service: 'flowsnap-mcp',
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
   * session token in a response body — stayed in `~/.flowsnap/flows` and was
   * still handed to Claude by the very next `list_flows`. The row vanished and
   * the extension reported success, which is the worst version of not deleting
   * something.
   */
  if (req.method === 'DELETE' && req.url?.startsWith('/flows/')) {
    if (!extensionOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Flows may only be deleted by the FlowSnap extension.' }));
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
            'the environment it was launched with (FLOWSNAP_PORT, FLOWSNAP_MAX_FLOWS, FLOWSNAP_MAX_BYTES).',
        }),
      );
      return;
    }

    if (!extensionOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Settings may only be posted by the FlowSnap extension.' }));
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
      res.end(JSON.stringify({ error: 'Flows may only be posted by the FlowSnap extension.' }));
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
              `This flow uses format v${flow.schemaVersion}, and flowsnap-mcp ${VERSION} understands ` +
              `up to v${SUPPORTED_SCHEMA}. Update the server: npx -y flowsnap-mcp@latest`,
          }),
        );
        return;
      }

      const meta = await saveFlow(flow);
      log(`saved "${meta.name}" — ${meta.stepCount} steps, ${meta.errorCount} with failures`);

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

// ── MCP server (server → Claude) ───────────────────────────────────────────

const mcpServer = new Server({ name: 'flowsnap', version: VERSION }, { capabilities: { tools: {} } });

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

  const header = [
    `# ${json.name}`,
    '',
    `**Recorded:** ${new Date(json.timestamp).toLocaleString()}  `,
    `**Steps:** ${total}  `,
    json.startUrl ? `**Start URL:** ${json.startUrl}  ` : null,
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
          `No flows recorded yet (looking in ${FLOWS_DIR}). Record one in the FlowSnap Chrome extension and press Send — it will appear here.`,
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

      return text(`${headline}${cut}\n\n\`\`\`json\n${JSON.stringify(shown)}\n\`\`\``);
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

    default:
      return failure(`Unknown tool: ${name}`);
  }
});

if (!REMOTE) {
  await mcpServer.connect(new StdioServerTransport());
}
