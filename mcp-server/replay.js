/**
 * Running a recorded journey again, in the user's own project.
 *
 * ## Off unless somebody switched it on
 *
 * Every other tool in this server reads. This one **executes code on the
 * machine it is running on** — the user's own test runner, against the user's
 * own application, started because a model asked a question. That is a
 * different kind of act, and the difference is not softened by the code being
 * theirs: a replay drives a real browser at a real app, and an app whose
 * checkout flow was recorded has a checkout flow to run.
 *
 * So it is off by default and switched on with `DEVFLOW_REPLAY=1` on the
 * server's own environment — which is to say, in the MCP client config the user
 * edits by hand, and not through `POST /config`, which any page the browser
 * visits can reach. When it is off the tool still exists, still appears in
 * `tools/list`, and answers by saying exactly what it would do and how to allow
 * it. A capability that is invisible until enabled is one nobody discovers; a
 * capability that runs without being enabled is one nobody agreed to.
 *
 * ## What it refuses before it spawns anything
 *
 * A project root that is not a directory. A project with no `@playwright/test`
 * in its `node_modules` — refused rather than installed, because `npx
 * playwright` on a machine without it goes to the network and writes into
 * somebody's disk, which is not a thing a tool call does. A spec path that does
 * not stay underneath the root once resolved, checked the way
 * `resolveSource` in `server.js` checks a source path and for the same reason.
 *
 * ## What it does with what comes back
 *
 * As little as possible. `core/replay`'s `readReport` is where a runner's
 * output becomes a verdict, and the one thing this file must never do is turn a
 * runner that crashed into a replay that passed — that is the reading a repair
 * loop acts on, and it would act on it by believing a fix worked. So a non-zero
 * exit with unreadable output stays unreadable, and the process's own stderr
 * travels with it.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** The switch, read per call so a long-lived server picks up nothing stale. */
export function replayEnabled() {
  return process.env.DEVFLOW_REPLAY === '1';
}

/**
 * How long one replay may take.
 *
 * A recorded journey is a handful of interactions; a replay that has not
 * finished in two minutes is waiting on something that is not going to happen —
 * a dev server that is not up, a login the mocks did not cover. Bounded here
 * rather than left to the runner, because the runner's own timeout is per test
 * and this is the process.
 */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** Output kept from one run. Enough to see a crash; not a log file. */
const OUTPUT_CAP = 512 * 1024;

/**
 * Whether a replay could run here, and in the reader's words when it could not.
 *
 * Each answer is a different thing to do next, which is why they are different
 * sentences rather than one `false`: switching the feature on, pointing the
 * server at the right project, and installing a runner are three unrelated
 * actions and a caller told only "unavailable" will guess.
 */
export async function replayReady(root) {
  if (!replayEnabled()) {
    return {
      ok: false,
      reason:
        'Replay is switched off. It is the only tool here that runs code on this machine — your own ' +
        'test runner, against your own application — so it is off until you say otherwise. Set ' +
        'DEVFLOW_REPLAY=1 in the environment of the devflow MCP server (in your MCP client config, ' +
        'beside DEVFLOW_PROJECT_ROOT) and restart it.',
    };
  }

  if (!root) {
    return {
      ok: false,
      reason:
        'No project root. A replay runs inside your project, so this server needs to know where that ' +
        'is: start it in the project directory, or set DEVFLOW_PROJECT_ROOT.',
    };
  }

  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    return { ok: false, reason: `The project root ${root} is not a directory this server can read.` };
  }

  const runner = path.join(root, 'node_modules', '.bin', 'playwright');
  const installed = await fs
    .stat(path.join(root, 'node_modules', '@playwright', 'test', 'package.json'))
    .catch(() => null);

  if (!installed?.isFile()) {
    return {
      ok: false,
      reason:
        `No @playwright/test in ${root}. A replay runs the spec DevFlow compiles from a recording, ` +
        'and it runs it with the copy of Playwright your project already has — this server will not ' +
        'install one, because "npx playwright" on a machine without it downloads it, and a tool call ' +
        'is not where that decision belongs. Install it in your project and try again.',
    };
  }

  const executable = await fs.stat(runner).catch(() => null);
  if (!executable) {
    return {
      ok: false,
      reason:
        `@playwright/test is in ${root} but ${runner} is not — the package is installed and its ` +
        'binary is not linked. Re-run your package manager’s install.',
    };
  }

  return { ok: true, runner };
}

/** `target` is somewhere strictly beneath `root` — `server.js`'s rule, and its reason. */
function contained(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Write one compiled spec into the project, and answer with where it went.
 *
 * Inside the project and not a temporary directory, because Playwright resolves
 * `@playwright/test` by walking up from the spec file: a spec in `/tmp` cannot
 * import the runner that is about to run it. `.devflow/replays/` is the place,
 * and the containment check is not a formality — `specPath` comes from
 * `planReplay`, which sanitises a flow id that arrived over loopback from
 * whatever page the browser was on.
 */
export async function writeSpec(root, specPath, source) {
  const target = path.resolve(root, specPath);
  if (!contained(root, target)) {
    throw new Error(`Refusing to write a replay spec outside the project root: ${specPath}`);
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, source, 'utf8');
  return target;
}

/**
 * Run one command to completion, or until the clock says it will not.
 *
 * `shell: false`, so nothing here is parsed by a shell — the arguments carry a
 * path built from a recorded flow's id, and an argument vector has no quoting
 * to get wrong. Killed on timeout rather than left, because the caller is an
 * MCP tool with a client waiting on it, and a replay that hangs would hang the
 * conversation rather than the test.
 */
export function runCommand({ executable, args, cwd, timeoutMs }) {
  const limit = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS),
  );

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      // A binary that is not executable. An answer, not a crash.
      resolve({ code: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false, spawnFailed: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    /*
     * Decoded by the stream, not by `String(chunk)` per read.
     *
     * The runner's JSON report carries the flow's own name and every failure
     * message, which is user text — and decoding each read on its own replaces
     * any multi-byte character the read boundary happens to fall inside. The
     * report still parses, so the corruption arrives as a mangled test title in
     * an otherwise correct verdict. `setEncoding` holds the partial character
     * back until the rest of it arrives.
     */
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const keep = (buffer, chunk) =>
      buffer.length >= OUTPUT_CAP ? buffer : buffer + String(chunk).slice(0, OUTPUT_CAP - buffer.length);

    child.stdout.on('data', (chunk) => {
      stdout = keep(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = keep(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // The tree, not the process: a runner spawns browsers, and killing only
      // the parent leaves them holding the port the next replay needs.
      child.kill('SIGKILL');
    }, limit);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || String(error?.message ?? error), timedOut, spawnFailed: true });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnFailed: false });
    });
  });
}

export { DEFAULT_TIMEOUT_MS };
