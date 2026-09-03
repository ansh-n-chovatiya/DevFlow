/**
 * The half of RSC attribution that needs a filesystem.
 *
 * ## Why this file exists at all
 *
 * `.ctx/spike-rsc.md` §4, stated as plainly as the spike could: *in production
 * the only route from a wire fact to a source file is a build-time artefact on
 * the filesystem. DevFlow's extension cannot reach it. DevFlow's MCP server
 * can.* That is the whole argument, and it was measured rather than assumed —
 * the three plausible served paths for the manifest were tried and all three
 * 404'd:
 *
 * ```
 * /_next/server/app/page_client-reference-manifest.js   -> 404
 * /_next/static/chunks/page_client-reference-manifest.js -> 404
 * /_next/app/page_client-reference-manifest.js          -> 404
 * ```
 *
 * So a production flight payload's `4:I[56850,…]` is an opaque integer to
 * everything in the browser, and `page_client-reference-manifest.js` on disk is
 * the only thing in the world that says `56850` means
 * `app/components/ClientCounter.tsx`. Same for a server action: the `next-action`
 * id in a request header is a hash, and `server-reference-manifest.json` is the
 * only place it becomes `app/actions.ts` / `echoAction`.
 *
 * This is the same split `otel.js` already represents — decisions in `core/`,
 * the resource that only exists on this machine here — and it is forced by
 * measurement rather than chosen for tidiness.
 *
 * ## What it does not recover, and must not pretend to
 *
 * **A production server component.** Not a name, not a module id, not a file,
 * nowhere on the wire. The manifests below are about *client* modules and
 * *server actions*; there is no server-component manifest, and nothing here
 * fabricates one. `core/rsc/adapter.ts` returns `absent` with `server-rendered`
 * for that case and this file does not soften it.
 *
 * ## Never `eval`, never `import()`
 *
 * `page_client-reference-manifest.js` is JavaScript, and the obvious way to read
 * a JavaScript file is to run it. It is the user's build output, reached by path
 * from a value that ultimately came off a web page, and running it would make
 * this server execute code because a model asked a question — the exact line
 * `replay.js` is gated behind. So it is *scanned as text*, for entries of a
 * shape the spike printed, and a wrapper this scanner does not recognise costs a
 * lookup rather than executing anything.
 *
 * The wrapper is also the part the spike did **not** print: it recorded the
 * entries, not the assignment around them. So the scan is deliberately
 * wrapper-agnostic and handles the entries both plainly and backslash-escaped,
 * because Next has historically embedded this manifest as a JSON *string*
 * inside a JS assignment and that is a difference of quoting, not of content.
 *
 * ## On by default, `DEVFLOW_RSC=0` to switch off
 *
 * The inverse of `replay.js` and the same way round as `git.js`, for `git.js`'s
 * reason. This **reads** files, under a root this server already opens source
 * files from for `get_source_snippet`, with no subprocess and no network. A
 * capability nobody enabled is a feature that is always missing, which is the
 * defect it would exist to close arrived at by another road. An environment
 * variable rather than a `config.json` key, because `POST /config` is reachable
 * by any page the browser visits.
 */

import fs from 'node:fs';
import path from 'node:path';

/*
 * Namespaced and never imported by name, for `git.js`'s and `arkg.js`'s reason:
 * `core.js` is a build artefact and an installed copy of this package can be
 * older than the module a symbol comes from. A missing named import is a link
 * error that takes the whole server down at startup; a missing property costs
 * the path tidying below and nothing else.
 */
import * as core from './core.js';

// ── The gate ─────────────────────────────────────────────────────────────────

/** The switch, read per call so a long-lived server picks up nothing stale. */
export function rscEnabled() {
  return process.env.DEVFLOW_RSC !== '0';
}

// ── Caps ─────────────────────────────────────────────────────────────────────

/**
 * The largest manifest this will read.
 *
 * A client-reference manifest on a large app is hundreds of kilobytes. Eight
 * megabytes is far past any of them and small enough that a `.next` directory
 * pointed at something enormous costs a refusal rather than the process.
 */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/** One per route. A thousand routes is a large app; ten thousand is a mistake. */
const MAX_MANIFEST_FILES = 1000;

/** Enough for every client component in a large app, and a bound on a bad scan. */
const MAX_ENTRIES = 50_000;

/** `.next/server` is broad but shallow. A cap here bounds a symlink loop. */
const MAX_WALK_DIRS = 5000;

/**
 * How long a reading is reused.
 *
 * `readCheckout`'s five seconds, for its reason: a burst of picks must not be a
 * burst of directory walks, and the cost of the staleness is that a manifest
 * read up to five seconds ago is used — which is the same manifest, unless
 * somebody rebuilt mid-question, and a rebuild moves every id anyway.
 */
const CACHE_TTL_MS = 5_000;

// ── Where the build output is ────────────────────────────────────────────────

/**
 * `target` is at or beneath `root`.
 *
 * The same containment `get_source_snippet` applies, applied again rather than
 * assumed: every path this file opens is derived from a root the caller chose,
 * and a `nextDir` argument that walked out of it would make this a file reader
 * for the whole disk.
 */
function contained(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The build output directory for a project root.
 *
 * `.next` is the default and the only one the spike ran. A project with
 * `distDir` set has a different one, which is why this is an argument rather
 * than a constant — and why a caller that passes one gets it checked rather
 * than trusted.
 */
export function nextDirFor(root, distDir = '.next') {
  const resolvedRoot = path.resolve(root);
  const dir = path.resolve(resolvedRoot, distDir, 'server');
  if (!contained(resolvedRoot, dir)) return null;
  return dir;
}

// ── Reading the client-reference manifests ───────────────────────────────────

/**
 * One entry of a client-reference manifest.
 *
 * `id` is the join key. It is what a production `I` row carries — measured,
 * `4:I[56850,…]` against the manifest's `{"id":56850,…}` — and it is a number
 * there and can be a string in other builds, so it is kept exactly as written
 * and compared as a string. Coercing it to a number would silently collapse two
 * distinct string ids that happen to parse the same.
 */

/** Matches one `"<path>": { "id": …, "name": …, "chunks": [ … ] }` entry. */
const ENTRY =
  /"((?:[^"\\]|\\.)+?)"\s*:\s*\{\s*"id"\s*:\s*(\d+|"(?:[^"\\]|\\.)*")\s*,\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"chunks"\s*:\s*(\[[^\]]*\])/g;

/**
 * The manifest text, and the same text with one level of escaping removed.
 *
 * Both are scanned, because the entries reach disk in two quotings depending on
 * whether the build embedded the manifest as an object literal or as a JSON
 * string inside an assignment — and the spike printed the entries without the
 * wrapper, so neither can be ruled out. Scanning both costs one extra pass over
 * a few hundred kilobytes and removes a whole class of "returns nothing on your
 * Next version" that would be indistinguishable from "this app has no client
 * components".
 */
function quotings(text) {
  if (!text.includes('\\"')) return [text];
  return [text, text.replace(/\\"/g, '"').replace(/\\\\/g, '\\')];
}

/**
 * Tidies a manifest key into a repo-relative path.
 *
 * The rule lives in `core/rsc/flight.ts` because the *wire* needs it too — a
 * dev `I` row's module id is the same path wearing an extra
 * ` [app-client] (ecmascript)` — and one rule in one place is the only way the
 * two halves agree about what a file is called.
 *
 * When `core.js` predates that export the raw key is returned instead and the
 * reading says `normalized: false`. A degraded `[project]/app/actions.ts` is
 * still a path a person can read; a second copy of the rule here is how the two
 * halves start disagreeing.
 */
function tidyPath(key) {
  const withoutExport = key.split('#')[0];
  if (typeof core.normalizeModulePath !== 'function') return { file: withoutExport, ok: false };
  return { file: core.normalizeModulePath(withoutExport) ?? withoutExport, ok: true };
}

function readManifestText(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Every `*_client-reference-manifest.js` under a build's server directory. */
function findClientManifests(serverDir) {
  const found = [];
  const queue = [serverDir];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_WALK_DIRS && found.length < MAX_MANIFEST_FILES) {
    const dir = queue.shift();
    visited++;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // `withFileTypes` reports a symlink as neither, which is the answer this
      // wants: a link out of the build directory is not walked into.
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && entry.name.endsWith('_client-reference-manifest.js')) {
        found.push(full);
      }
    }
  }

  return found;
}

/**
 * Every client module this build knows about, keyed by the id the wire uses.
 *
 * Returns a reason rather than throwing, and the reasons are distinct on
 * purpose: `no-build` is *run `next build`*, `no-manifest` is *this build has no
 * client components, or your Next version writes the manifest somewhere this
 * has not been taught*, and `unreadable` is a permissions or size problem. One
 * silence would send all three readers to the wrong fix.
 */
export function readClientReferences(root, distDir = '.next') {
  if (!rscEnabled()) return { available: false, reason: 'disabled', modules: new Map() };

  const serverDir = nextDirFor(root, distDir);
  if (!serverDir || !fs.existsSync(serverDir)) {
    return { available: false, reason: 'no-build', modules: new Map() };
  }

  const files = findClientManifests(serverDir);
  if (files.length === 0) {
    return { available: false, reason: 'no-manifest', modules: new Map() };
  }

  const modules = new Map();
  let normalized = true;
  let read = 0;

  for (const file of files) {
    const text = readManifestText(file);
    if (text === null) continue;
    read++;

    for (const candidate of quotings(text)) {
      ENTRY.lastIndex = 0;
      let match;
      while ((match = ENTRY.exec(candidate)) !== null) {
        if (modules.size >= MAX_ENTRIES) break;
        const [, rawKey, rawId, exportName, rawChunks] = match;
        const id = rawId.startsWith('"') ? safeJson(rawId) : rawId;
        if (id === undefined || id === null) continue;

        const tidied = tidyPath(rawKey);
        if (!tidied.ok) normalized = false;

        const key = String(id);
        if (modules.has(key)) continue;
        modules.set(key, {
          id: key,
          file: tidied.file,
          exportName,
          chunks: safeJson(rawChunks) ?? [],
          manifest: path.relative(path.resolve(root), file),
        });
      }
    }
  }

  if (read === 0) return { available: false, reason: 'unreadable', modules: new Map() };
  return { available: true, modules, normalized, manifests: read };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── Reading the server-reference manifest ────────────────────────────────────

/**
 * Server actions, keyed by the `next-action` id.
 *
 * Measured shape, verbatim:
 *
 * ```json
 * {"node":{"40f43782738bb9c45a0870d2dcbb114f82c8acb929":{
 *    "workers":{"app/page":{"moduleId":57526,"async":false,"codeHash":null}},
 *    "filename":"app/actions.ts","exportedName":"echoAction"}},"edge":{},…}
 * ```
 *
 * JSON, so it is parsed rather than scanned — the reason the manifest above is
 * scanned is that it is JavaScript, and this one is not.
 *
 * `node` and `edge` are merged. They are two runtimes for the same action id and
 * a caller asking "which file is this action in" does not care which one served
 * it; keeping them apart would push a runtime distinction into every call site
 * to answer a question neither runtime disagrees about.
 *
 * The id is **build-specific** — dev `407b1663…`, prod `40f43782…` for the same
 * function — so a hit is only meaningful against the build that produced it.
 * `encryptionKey` in this file is deliberately not read or returned.
 */
export function readServerReferences(root, distDir = '.next') {
  if (!rscEnabled()) return { available: false, reason: 'disabled', actions: new Map() };

  const serverDir = nextDirFor(root, distDir);
  if (!serverDir) return { available: false, reason: 'no-build', actions: new Map() };

  const file = path.join(serverDir, 'server-reference-manifest.json');
  const text = readManifestText(file);
  if (text === null) {
    return {
      available: false,
      reason: fs.existsSync(serverDir) ? 'no-manifest' : 'no-build',
      actions: new Map(),
    };
  }

  const parsed = safeJson(text);
  if (!parsed || typeof parsed !== 'object') {
    return { available: false, reason: 'unreadable', actions: new Map() };
  }

  const actions = new Map();
  for (const runtime of ['node', 'edge']) {
    const table = parsed[runtime];
    if (!table || typeof table !== 'object') continue;
    for (const [id, entry] of Object.entries(table)) {
      if (actions.size >= MAX_ENTRIES) break;
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.filename !== 'string') continue;
      if (actions.has(id)) continue;
      actions.set(id, {
        id,
        runtime,
        file: entry.filename,
        exportName: typeof entry.exportedName === 'string' ? entry.exportedName : '',
        workers: entry.workers && typeof entry.workers === 'object' ? Object.keys(entry.workers) : [],
      });
    }
  }

  return { available: true, actions };
}

// ── The cached reading ───────────────────────────────────────────────────────

const cache = new Map();

/**
 * Both manifests for one project root, cached for `CACHE_TTL_MS`.
 *
 * Nothing here throws. A recording is saved on the path that calls this, and
 * `otelTry`/`gitTry` exist because nothing about a side capability may fail one
 * — an RSC build that is half-written, a `.next` on a disconnected volume, a
 * manifest in a shape this has never seen: each of those costs an attribution
 * and none of them costs the flow.
 */
export function readManifests(root, distDir = '.next') {
  const resolved = path.resolve(root);
  const key = `${resolved} ${distDir}`;
  const now = Date.now();
  const held = cache.get(key);
  if (held && now - held.at < CACHE_TTL_MS) return held.reading;

  let reading;
  try {
    reading = {
      root: resolved,
      client: readClientReferences(resolved, distDir),
      server: readServerReferences(resolved, distDir),
    };
  } catch (error) {
    reading = {
      root: resolved,
      client: { available: false, reason: 'unreadable', modules: new Map(), error: error.message },
      server: { available: false, reason: 'unreadable', actions: new Map(), error: error.message },
    };
  }

  cache.set(key, { at: now, reading });
  return reading;
}

/** Drops the cache, so a test and a rebuild both see the next read afresh. */
export function forgetManifests() {
  cache.clear();
}

// ── The two lookups a caller actually wants ──────────────────────────────────

/**
 * The file behind a production `I` row's module id.
 *
 * The id arrives from the browser as a number and is compared as a string, for
 * the reason on `ENTRY`: two distinct string ids can parse to one number, and a
 * wrong file is worse than no file.
 */
export function fileForModuleId(root, moduleId, distDir = '.next') {
  const reading = readManifests(root, distDir);
  if (!reading.client.available) return { found: false, reason: reading.client.reason };
  const entry = reading.client.modules.get(String(moduleId));
  if (!entry) return { found: false, reason: 'not-in-manifest' };
  return { found: true, ...entry };
}

/** The file and export behind a `next-action` id. */
export function fileForActionId(root, actionId, distDir = '.next') {
  const reading = readManifests(root, distDir);
  if (!reading.server.available) return { found: false, reason: reading.server.reason };
  const entry = reading.server.actions.get(String(actionId));
  if (!entry) return { found: false, reason: 'not-in-manifest' };
  return { found: true, ...entry };
}

/**
 * What this machine can say about a project's RSC build, before anything is asked.
 *
 * The three states are not three wordings of one nothing, which is
 * `backendReadingFor`'s distinction and is kept here for its reason: the switch
 * being off is this server's configuration, no build is the user's workflow, and
 * a build with no manifest is a Next version this has not been taught. The
 * reader who cannot tell them apart goes and changes the thing that was working.
 */
export function rscReading(root, distDir = '.next') {
  if (!rscEnabled()) return { available: false, reason: 'disabled' };

  const reading = readManifests(root, distDir);
  return {
    available: reading.client.available || reading.server.available,
    reason: reading.client.available ? undefined : reading.client.reason,
    clientModules: reading.client.modules.size,
    serverActions: reading.server.actions.size,
    /**
     * True when the paths went through `core/rsc`'s rule. False means an older
     * `core.js` and raw `[project]/…` keys — usable, and worth saying so rather
     * than letting a reader wonder why the paths look different today.
     */
    normalizedPaths: reading.client.normalized !== false,
    /**
     * Named here so the one thing this cannot do is stated at the top of every
     * answer rather than inferred from an empty result.
     */
    serverComponents: 'absent',
  };
}
