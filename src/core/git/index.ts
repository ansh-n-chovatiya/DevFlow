/**
 * What commit a recording was made at, and what that claim is worth.
 *
 * ## The claim, stated narrowly, because the wide version is false
 *
 * The extension has no filesystem and no repository. The MCP server runs *in*
 * the project — `DEVFLOW_PROJECT_ROOT`, or the directory Claude Code started it
 * in — so a recording is stamped by the server at ingest and carries nothing
 * about git on the wire. There is no other place the answer could come from:
 * asking the page means asking a browser about a checkout it cannot see.
 *
 * That fixes what the stamp means, and it is narrower than "the build that was
 * running": it is **the state of the checkout this server runs in, at the
 * moment the recording arrived**. Those coincide when somebody records
 * `localhost:5173` against the app they are editing, which is the ordinary
 * case. They do not coincide when the recorded page is staging — the developer
 * is on a feature branch, the deployed build is last Tuesday's, and the stamp
 * names the branch. So `recordedLocally()` exists, every renderer that prints a
 * commit is expected to pass the recording's `startUrl` through it, and the
 * sentence says which of the two situations it is. A caveat printed beside the
 * fact is worth more than a field nobody qualifies.
 *
 * ## A dirty tree is a build that exists nowhere
 *
 * `git status` non-empty means the working tree is not the commit. The SHA is
 * still the most useful anchor a developer has — "HEAD plus my edits" is how
 * people describe where they are — so it is still recorded on the flow, beside
 * `dirty: true`, and every renderer says so.
 *
 * The graph is the other way round. `git_sha` on an ARKG node is a **join
 * key**: a bare column with no room beside it to carry "but the tree was
 * dirty", read by anything asking which build a thing was last seen in. So a
 * dirty observation does not write it — not even to NULL, because erasing a
 * commit that was true is not an improvement on failing to add one. The column
 * therefore means *the last commit at which this node was observed with a clean
 * tree*, which is a lower bound on staleness and is exactly the fact
 * `changed_in` is crossed against: a component last observed at a commit older
 * than the one that last changed its file is a component the graph knows about
 * from before the change.
 *
 * ## Four repository states are four different answers
 *
 * Only one of them is "no commit, and nothing to say". A project root that is
 * not a repository, a repository with no commits yet, a `git` that is not on
 * the PATH and a `git` that failed are four things a person would do four
 * different things about, so they are four reasons and not one `null`. A
 * detached HEAD is *not* on that list: it is an ordinary commit and, on a CI
 * checkout, the likeliest thing to be a real deployed build. It records a SHA
 * and no branch.
 *
 * ## Nothing from the wire reaches an argv
 *
 * `mcp-server/git.js` spawns `git`, and every argument it passes is either a
 * literal in this repository or a string `isShaPrefix()` has vouched for. That
 * check is here, in the pure half, because it is the whole of the argument for
 * running git without the switch `replay_flow` is behind: replay executes the
 * user's code, and this reads a repository the server already reads source
 * files out of, with a fixed argv. The inverse switch exists —
 * `DEVFLOW_GIT=0` — because "no subprocess at all" is a preference somebody may
 * hold, and it degrades to `reason: 'off'` like every other unknown.
 */

/** A commit, as this project records one. */
export interface Commit {
  /** 40 lowercase hex. The join key everywhere. */
  sha: string;
  /** Epoch milliseconds. `git` speaks seconds; the conversion happens once, here. */
  committedAt: number;
  /** `%s` — the first line of the message, and never more than one line. */
  subject: string;
  author: string | null;
}

/** The checkout the server runs in, at one moment. */
export interface Checkout {
  commit: Commit;
  /** `null` when HEAD is detached. */
  branch: string | null;
  /** The working tree differs from `commit` — tracked edits or untracked files. */
  dirty: boolean;
  /**
   * Where the project root sits inside the repository, as a relative path with
   * no leading or trailing slash; `''` when they are the same directory.
   *
   * Git prints paths relative to the repository root and a source map names
   * them relative to the project, so without this the two never meet in a
   * monorepo — which is the shape most likely to have a `changed_in` edge worth
   * drawing.
   */
  prefix: string;
}

export type NoCommitReason = 'off' | 'no-git' | 'not-a-repo' | 'no-commits' | 'failed';

export type CheckoutState =
  | { known: true; checkout: Checkout }
  | { known: false; reason: NoCommitReason };

/**
 * The stamp a flow carries, and the shape stored in `meta.json`.
 *
 * Deliberately not `Checkout`: `prefix` is a fact about this machine's
 * directory layout and has no business in a recording, and `short` is stored
 * rather than derived so that everything printing it agrees on the length.
 */
export interface FlowCommit {
  sha: string;
  short: string;
  branch: string | null;
  dirty: boolean;
  subject: string;
  committedAt: number;
}

/** One commit in a range, with the files it touched. */
export interface CommitChange {
  commit: Commit;
  /** Repository-relative, in git's own order. Empty for a merge commit — see `parseLog`. */
  files: string[];
}

// ── What may reach an argv ────────────────────────────────────────────────────

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * A prefix a caller may hand us to look a commit up by.
 *
 * Seven is git's own floor for `--abbrev`, and the ceiling is a full SHA.
 * Lowercase only: git resolves uppercase fine, but a second accepted spelling
 * of one value is a second cache key and a second thing to compare, and the
 * caller can lowercase.
 */
const SHA_PREFIX = /^[0-9a-f]{7,40}$/;

export const isSha = (value: unknown): value is string =>
  typeof value === 'string' && FULL_SHA.test(value);

export const isShaPrefix = (value: unknown): value is string =>
  typeof value === 'string' && SHA_PREFIX.test(value);

/** The abbreviation every surface prints. Ten, because seven collides in a big repository. */
export const SHORT_SHA_LENGTH = 10;

export const shortSha = (sha: string): string => sha.slice(0, SHORT_SHA_LENGTH);

/**
 * Does `prefix` name `sha`?
 *
 * Prefix matching is done here rather than by `git rev-parse` when the candidate
 * set is already in hand — the recordings on disk — because that is a string
 * comparison against flows this server saved, and shelling out to ask git to
 * confirm what a substring already says would be a subprocess per candidate.
 */
export const shaMatches = (prefix: string, sha: string): boolean =>
  isShaPrefix(prefix) && isSha(sha) && sha.startsWith(prefix);

// ── Reading git's output ──────────────────────────────────────────────────────

/**
 * The first line of `git status --porcelain --branch`.
 *
 * Three shapes, and the third is why this is parsed rather than assumed:
 *
 *   `## main...origin/main [ahead 21]`   a branch, tracking something
 *   `## HEAD (no branch)`                detached
 *   `## No commits yet on main`          a repository nobody has committed to
 *
 * The tracking half is dropped on purpose. Whether a branch is ahead of its
 * remote says something about the developer's afternoon and nothing about which
 * build a recording was made against.
 */
export function parseStatusBranch(line: string): {
  branch: string | null;
  detached: boolean;
  noCommits: boolean;
} {
  const body = line.startsWith('## ') ? line.slice(3) : line;

  if (body.startsWith('No commits yet on ')) {
    return { branch: body.slice('No commits yet on '.length).trim() || null, detached: false, noCommits: true };
  }
  if (body === 'HEAD (no branch)') return { branch: null, detached: true, noCommits: false };

  // `...` separates the branch from its upstream, and a branch name may not
  // contain it — git refuses `..` in a ref name outright.
  const name = body.split('...')[0].trim();
  return { branch: name || null, detached: false, noCommits: false };
}

/** Was anything in the working tree different from HEAD? */
export function isDirty(statusOutput: string): boolean {
  // Every line after the `## ` header is a changed path, and the header is
  // always present because `--branch` was asked for.
  return statusOutput
    .split('\n')
    .slice(1)
    .some((line) => line.trim().length > 0);
}

/** The separator this project asks git for. A commit subject cannot contain it. */
export const FIELD_SEP = '\u001f';
/** Marks the start of one commit record in a `git log` stream. */
export const RECORD_SEP = '\u0001';

/**
 * The `--format` every commit read here is asked for, so one parser serves them
 * all. Written in git's own `%xNN` escapes rather than as literal separators,
 * so the argv this ends up in carries no control bytes and the string stays
 * legible in a diff.
 */
export const COMMIT_FORMAT = '%x01%H%x1f%ct%x1f%an%x1f%s';

/**
 * One `sha \x1f seconds \x1f author \x1f subject` header into a `Commit`.
 *
 * Returns null rather than a partial commit for anything that does not parse:
 * this reads a subprocess's stdout, and a half-built commit that reaches a
 * database as a node is worse than a commit that never arrived.
 */
export function parseCommitRecord(header: string): Commit | null {
  const [sha, seconds, author, ...rest] = header.split(FIELD_SEP);
  if (!isSha(sha)) return null;

  const at = Number(seconds);
  if (!Number.isFinite(at)) return null;

  // `%s` cannot contain the separator, but rejoining costs nothing and means a
  // future format change loses nothing silently.
  const subject = rest.join(FIELD_SEP).trim();

  return {
    sha,
    committedAt: at * 1000,
    subject,
    author: author?.trim() ? author.trim() : null,
  };
}

/**
 * A path as git printed it, unquoted.
 *
 * Git quotes a path containing a double quote, a backslash or a control
 * character — *always*, whatever `core.quotePath` says, which is the property
 * this parser depends on: with quoting on for those and `core.quotePath=false`
 * suppressing the escaping of ordinary non-ASCII, no unquoted line can contain
 * a newline, so the output can be split on newlines at all.
 */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;

  const body = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      out += body[i];
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next >= '0' && next <= '7') {
      // Git escapes a non-ASCII byte as three octal digits, one per byte of
      // UTF-8, so the bytes are gathered and decoded together rather than one
      // at a time — decoding each on its own produces mojibake, not a path.
      const bytes: number[] = [];
      // Back onto the backslash: `i` was advanced past it to read `next`, and
      // the gathering loop below tests for a backslash before each triple. From
      // `i` it fails on its first test, every escape falls through unread, and
      // the octal digits are emitted literally — a path that is not even
      // plausible mojibake, and that therefore matches no source file at all.
      let j = i - 1;
      while (body[j] === '\\' && /^[0-7]$/.test(body[j + 1] ?? '')) {
        bytes.push(parseInt(body.slice(j + 1, j + 4), 8));
        j += 4;
      }
      out += new TextDecoder().decode(Uint8Array.from(bytes));
      i = j - 1;
    } else out += next;
  }
  return out;
}

/**
 * A `git log --format=COMMIT_FORMAT --name-only` stream into commits and files.
 *
 * **A merge commit lists no files, and that is git's answer rather than a gap
 * in this one.** `--name-only` on a merge shows nothing without `-m` or
 * `--first-parent`, because a merge introduces no change against *both*
 * parents. Neither flag is passed: `-m` reports every file of both sides as
 * changed by the merge, which would file `changed_in` edges for work that
 * shipped in the commits either side and is about to be reported again by them.
 * So a merge arrives as a commit node with no edges, which is true.
 */
export function parseLog(raw: string): CommitChange[] {
  const out: CommitChange[] = [];

  for (const record of raw.split(RECORD_SEP)) {
    if (!record.trim()) continue;

    const [header, ...lines] = record.split('\n');
    const commit = parseCommitRecord(header);
    if (!commit) continue;

    const files = lines.map((line) => line.trim()).filter(Boolean).map(unquotePath);
    out.push({ commit, files });
  }

  return out;
}

/**
 * Everything `git` was asked at ingest, assembled into one state.
 *
 * Separate from the spawning so that the four reasons — and the detached and
 * dirty readings, which are the two easiest to get backwards — are decided by a
 * function three strings can be handed in a test, rather than by a repository
 * somebody has to build to exercise the branch.
 */
export function readCheckout(raw: {
  /** `git rev-parse --show-toplevel`, or null when it failed. */
  topLevel: string | null;
  /** `git status --porcelain --branch`, or null when it failed. */
  status: string | null;
  /** `git log -1 --format=COMMIT_FORMAT`, or null when it failed. */
  head: string | null;
  /** The project root, so the prefix can be worked out. Absolute. */
  projectRoot: string;
  /** Injected so this stays free of `node:path` — see the module's purity rule. */
  relative: (from: string, to: string) => string;
}): CheckoutState {
  if (!raw.topLevel) return { known: false, reason: 'not-a-repo' };
  if (raw.status === null) return { known: false, reason: 'failed' };

  const first = raw.status.split('\n')[0] ?? '';
  const { branch, detached, noCommits } = parseStatusBranch(first);
  if (noCommits) return { known: false, reason: 'no-commits' };

  if (!raw.head) return { known: false, reason: 'failed' };
  const commit = parseCommitRecord(raw.head.replace(RECORD_SEP, '').trim());
  if (!commit) return { known: false, reason: 'failed' };

  /*
   * A prefix that climbs out of the repository is not a prefix. It happens when
   * the project root is a symlink git resolved differently, and the honest
   * answer is an empty prefix — every git path then fails to project and no
   * `changed_in` edge is drawn, which is better than drawing them against the
   * wrong directory.
   */
  const rel = raw.relative(raw.topLevel, raw.projectRoot).replace(/\\/g, '/');
  const prefix = rel && !rel.startsWith('..') ? rel.replace(/^\/+|\/+$/g, '') : '';

  return {
    known: true,
    checkout: { commit, branch: detached ? null : branch, dirty: isDirty(raw.status), prefix },
  };
}

/** The stamp a flow stores, from the checkout it arrived at. */
export const flowCommit = (checkout: Checkout): FlowCommit => ({
  sha: checkout.commit.sha,
  short: shortSha(checkout.commit.sha),
  branch: checkout.branch,
  dirty: checkout.dirty,
  subject: checkout.commit.subject,
  committedAt: checkout.commit.committedAt,
});

/**
 * The SHA a node's `git_sha` column may be written with — see the header.
 *
 * One expression rather than an `if` at each of the write sites, because "clean
 * trees only" is a rule about the column and not about one caller, and the way
 * a rule like that dies is the fifth write site added by somebody who had not
 * read the fourth.
 */
export const joinableSha = (git: FlowCommit | null | undefined): string | null =>
  git && !git.dirty ? git.sha : null;

// ── What the stamp is worth, per recording ────────────────────────────────────

/**
 * Was the recorded page served by this machine?
 *
 * The stamp names the checkout the server runs in. When the page came off
 * `localhost` that is almost certainly the build that served it; when it came
 * off a hostname, the two are unrelated until somebody says otherwise. Derived
 * from `startUrl`, which every recording has already stored, so this reaches
 * flows recorded before any of it existed.
 */
export function recordedLocally(startUrl: string | null | undefined): boolean {
  if (!startUrl) return false;
  let host: string;
  try {
    host = new URL(startUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // WHATWG keeps the brackets on an IPv6 literal — `hostname` is `[::1]`, not
  // `::1` — so they come off here. Without this the loopback test below is
  // dead code and an IPv6 recording is wrongly caveated as one this machine
  // did not serve.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === '::1' || bare === '::' || host === '0.0.0.0') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** How a commit reads in one line, wherever one is printed. */
export const describeCommit = (git: FlowCommit): string =>
  `${git.short}${git.branch ? ` on ${git.branch}` : ' (detached)'}` +
  `${git.dirty ? ', working tree dirty' : ''}${git.subject ? ` — ${git.subject}` : ''}`;

/**
 * The sentence that keeps the stamp from being read as more than it is.
 *
 * Returned as a list because a caller may have both things to say, and because
 * a renderer that has to concatenate two caveats itself is a renderer that will
 * print one of them.
 */
export function commitCaveats(git: FlowCommit, startUrl: string | null | undefined): string[] {
  const out: string[] = [];
  if (!recordedLocally(startUrl)) {
    out.push(
      'This flow was recorded against a page this machine did not serve, so the commit names ' +
        'the checkout this server runs in and not the build that answered the browser.',
    );
  }
  if (git.dirty) {
    out.push(
      `The working tree had uncommitted changes at ${git.short}, so this names a build that ` +
        'exists on no other machine.',
    );
  }
  return out;
}

// ── Projecting a git path onto a source file the graph already keys ───────────

/**
 * A source path as a bundler wrote it, reduced to something comparable.
 *
 * A `source` in a recording is whatever the page's source map claimed:
 * `src/Cart.tsx`, `/Users/x/app/src/Cart.tsx`, `webpack://app/./src/Cart.tsx`
 * and `webpack:///src/Cart.tsx` are all the same file said four ways. This
 * strips the parts that vary — a scheme and its authority, a leading slash, a
 * `./` — and nothing else, because every further guess is a way to make two
 * different files compare equal.
 */
export function normaliseSourcePath(raw: string): string {
  let path = raw.replace(/\\/g, '/');

  const scheme = path.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]*)\//i);
  if (scheme) path = path.slice(scheme[0].length);

  path = path.replace(/^\/+/, '');
  while (path.startsWith('./')) path = path.slice(2);
  return path.replace(/\/{2,}/g, '/');
}

/**
 * One repository-relative git path, as the project-relative path a source map
 * would have written — or null when it names a file outside the project.
 */
export function projectRelative(prefix: string, gitPath: string): string | null {
  const path = gitPath.replace(/\\/g, '/');
  if (!prefix) return path;
  if (path === prefix) return null;
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null;
}

/**
 * The source file node a changed path belongs to, out of the ones the graph
 * already keys — or null.
 *
 * **Both ends must land on a node the graph already keys stably**, which is the
 * rule `caused_by` was built to, and here it does more work than it does there:
 * the graph's ids are strings a bundler chose and this one is a path git chose,
 * so an edge drawn on a guess is a claim that a commit changed a file nobody
 * observed.
 *
 * Equality after normalisation first. A suffix is allowed after that — an
 * absolute id from a source map that recorded the developer's home directory is
 * the same file and would otherwise never match — but only when exactly one
 * candidate matches. Two files ending `src/index.ts` in a monorepo is precisely
 * the case where a suffix rule is a coin toss, and a coin toss belongs in
 * neither column of an edge.
 */
export function matchSourceFile(known: readonly string[], projectPath: string): string | null {
  const wanted = normaliseSourcePath(projectPath);
  if (!wanted) return null;

  const exact = known.filter((id) => normaliseSourcePath(id) === wanted);
  if (exact.length === 1) return exact[0];
  // Two ids that normalise to one path are two spellings of one file; either
  // answers the question, and picking the first keeps it deterministic.
  if (exact.length > 1) return [...exact].sort()[0];

  const suffix = known.filter((id) => normaliseSourcePath(id).endsWith(`/${wanted}`));
  return suffix.length === 1 ? suffix[0] : null;
}
