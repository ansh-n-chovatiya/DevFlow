/**
 * The one place this package runs `git`.
 *
 * ## Why this is not behind `DEVFLOW_REPLAY`'s switch
 *
 * `replay.js` is off by default because it **executes the user's code** — their
 * test runner, against their application, because a model asked a question.
 * Reaching for the same switch here would be a reflex rather than a decision,
 * and it would cost the whole feature: a stamp nobody has enabled is a
 * `git_sha` column that is always NULL, which is the defect this exists to
 * close, arrived at by a different road.
 *
 * The difference is worth stating rather than assuming:
 *
 *   - **It reads.** `rev-parse`, `status`, `log`, `show`. Nothing here writes to
 *     a repository, checks anything out, or fetches.
 *   - **The argv is fixed.** Every argument is a literal in this file except a
 *     commit-ish, and a commit-ish reaches `spawn` only after `isShaPrefix()`
 *     in `core/git` has vouched for it — seven to forty lowercase hex and
 *     nothing else. `shell: false`, so there is no second parser to get past
 *     even if one did.
 *   - **The directory is one this server already reads.** `get_source_snippet`
 *     opens files underneath the project root on request. Learning which commit
 *     that root is at is strictly less than what the server already does with
 *     it.
 *
 * What that argument does not license is skipping the ordinary hardening, so:
 * a timeout, an output cap, and every failure degrading to a reason rather than
 * an exception.
 *
 * `DEVFLOW_GIT=0` switches it off — an environment variable rather than a
 * `config.json` key for `DEVFLOW_PROJECT_ROOT`'s reason, which is that
 * `POST /config` is reachable by any page the browser visits and a page that
 * could move this would be choosing whether a subprocess runs. It is the
 * inverse of `replay.js`'s gate on purpose: reading a repository is the default
 * and opting out is the deliberate act, because that is which way round the
 * risk sits.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

/*
 * Namespaced for `arkg.js`'s reason: `core.js` is a build artefact and an
 * installed copy of this package can be older than the module a symbol comes
 * from. A missing named import is a link error that takes the server down at
 * startup; a missing property costs a stamp, which is what a machine with no
 * git already lives with.
 */
import * as core from './core.js';

/** The switch, read per call so a long-lived server picks up nothing stale. */
export function gitEnabled() {
  return process.env.DEVFLOW_GIT !== '0';
}

/**
 * How long one `git` may take.
 *
 * `git status` is the slow one and it is on the path of `POST /flows`, which
 * the extension is waiting on. Ten seconds is far longer than any of these
 * takes on a repository of ordinary size and short enough that a repository on
 * a stalled network filesystem costs a stamp rather than the save.
 */
const TIMEOUT_MS = 10_000;

/** Enough for a large commit's file list; not a place to buffer a repository. */
const OUTPUT_CAP = 4 * 1024 * 1024;

/**
 * How long a checkout reading is reused.
 *
 * Two subprocesses per component pick would make a burst of picking a burst of
 * spawns, and the panel writes one pick per click. Five seconds is shorter than
 * anybody's edit-and-record cycle and longer than a burst, so the cost is that
 * a stamp can name the commit the tree was at up to five seconds ago — which is
 * the same commit, unless somebody committed mid-recording.
 */
const CHECKOUT_TTL_MS = 5_000;

/**
 * Run one `git`, and never throw.
 *
 * Returns the trimmed stdout, or `null` for every kind of failure: a non-zero
 * exit, a missing binary, a timeout, output past the cap. The caller cannot act
 * differently on those and `readCheckout` in `core/git` turns the absence into
 * the reason a person reads.
 */
function run(cwd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A repository whose hooks or pager could run is not wanted here, and
        // an interactive credential prompt would hang until the timeout fires.
        env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
      });
    } catch {
      resolve(null);
      return;
    }

    let stdout = '';
    let over = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (over) return;
      stdout += chunk;
      if (stdout.length > OUTPUT_CAP) {
        over = true;
        child.kill('SIGKILL');
      }
    });
    // Read and dropped. Left unread the pipe fills and a chatty git blocks.
    child.stderr.on('data', () => {});

    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && !over ? stdout : null);
    });
  });
}

/**
 * Is there a `git` at all?
 *
 * Run from this process's own directory rather than from the root being asked
 * about: a root that does not exist fails `spawn` for a reason that has nothing
 * to do with git, and answering "install git" to that sends the reader after
 * the wrong thing.
 */
async function gitPresent() {
  return (await run(process.cwd(), ['--version'])) !== null;
}

let cached = { root: null, at: 0, state: null };

/**
 * What the checkout at `root` is, right now.
 *
 * Three reads rather than one, because they answer three questions and only the
 * first has a cheap combined form: whether this is a repository at all, what
 * the branch is and whether the tree is dirty, and what HEAD actually is. The
 * assembling — and every one of the reasons — is `readCheckout` in `core/git`,
 * where a test can reach it without building a repository.
 */
export async function readCheckout(root) {
  if (!gitEnabled()) return { known: false, reason: 'off' };
  if (!root) return { known: false, reason: 'not-a-repo' };

  const now = Date.now();
  if (cached.root === root && now - cached.at < CHECKOUT_TTL_MS && cached.state) return cached.state;

  const topLevelRaw = await run(root, ['rev-parse', '--show-toplevel']);
  if (topLevelRaw === null) {
    // Told apart here because they are the only two answers a caller can act
    // on differently, and "install git" is not the same advice as "this
    // directory is not a repository".
    const state = { known: false, reason: (await gitPresent()) ? 'not-a-repo' : 'no-git' };
    cached = { root, at: now, state };
    return state;
  }

  const [status, head] = await Promise.all([
    run(root, ['status', '--porcelain', '--branch']),
    run(root, ['log', '-1', `--format=${core.COMMIT_FORMAT}`]),
  ]);

  const state = core.readCheckout({
    topLevel: topLevelRaw.trim() || null,
    status,
    head,
    projectRoot: path.resolve(root),
    relative: path.relative,
  });

  cached = { root, at: now, state };
  return state;
}

/** Drops the memo. For tests, and for a caller that has just changed the tree. */
export function forgetCheckout() {
  cached = { root: null, at: 0, state: null };
}

/**
 * The repository-relative paths one commit changed, or null when git could not
 * say.
 *
 * `--no-walk` so a bad argument cannot turn this into a history walk, and
 * `core.quotePath=false` so an ordinary non-ASCII path arrives as itself —
 * git still quotes anything containing a control character whatever that
 * setting says, which is the property `unquotePath` depends on.
 */
export async function commitFiles(root, sha) {
  if (!gitEnabled() || !core.isShaPrefix(sha)) return null;

  const raw = await run(root, [
    '-c',
    'core.quotePath=false',
    'show',
    '--no-walk',
    '--name-only',
    `--format=${core.COMMIT_FORMAT}`,
    sha,
  ]);
  if (raw === null) return null;

  const parsed = core.parseLog(raw);
  return parsed.length ? parsed[0].files : [];
}

/**
 * Every commit reachable from `to` and not from `from`, newest first.
 *
 * `from..to` and not `...`: the question is what shipped between two builds one
 * of which is an ancestor of the other, and a symmetric difference would answer
 * a different one silently when they are not. When they are not, git answers
 * with the commits on `to`'s side alone, which is still the more useful half.
 */
export async function logRange(root, from, to, limit = 200) {
  if (!gitEnabled() || !core.isShaPrefix(from) || !core.isShaPrefix(to)) return null;

  const raw = await run(root, [
    '-c',
    'core.quotePath=false',
    'log',
    `--max-count=${Math.max(1, Math.min(1000, limit | 0))}`,
    '--name-only',
    `--format=${core.COMMIT_FORMAT}`,
    `${from}..${to}`,
  ]);
  if (raw === null) return null;
  return core.parseLog(raw);
}

/** Is `sha` a commit this repository has? The full SHA, or null. */
export async function resolveCommit(root, sha) {
  if (!gitEnabled() || !core.isShaPrefix(sha)) return null;
  const raw = await run(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  const full = raw?.trim();
  return core.isSha(full) ? full : null;
}

/**
 * How many commits are in `from..to`. Null when git could not say.
 *
 * The direction of a comparison is decided from the two recordings' commit
 * dates, which is what a person means by "the newer build" and is not the same
 * as ancestry. This is how the report finds out it guessed wrong: a range that
 * is empty one way round and full the other is two builds on diverged branches,
 * which is a different thing to tell the reader than "nothing shipped".
 */
export async function rangeSize(root, from, to) {
  if (!gitEnabled() || !core.isShaPrefix(from) || !core.isShaPrefix(to)) return null;
  const raw = await run(root, ['rev-list', '--count', `${from}..${to}`]);
  if (raw === null) return null;
  const count = Number(raw.trim());
  return Number.isFinite(count) ? count : null;
}
