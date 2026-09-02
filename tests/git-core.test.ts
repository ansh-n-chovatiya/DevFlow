/**
 * What the git stamp is allowed to claim, and what it must refuse to claim.
 *
 * **`isShaPrefix` is a security control, not a tidiness check.** It is the only
 * thing standing between a string and a `git` argv in `mcp-server/git.js`, so
 * the tests below spend most of their weight on refusals — an option-looking
 * argument, a ref name, a shell fragment — rather than on the one spelling that
 * works. A widened regex passes every happy-path test ever written.
 *
 * **`joinableSha` on a dirty tree is the module's load-bearing rule.** A dirty
 * observation must not write `git_sha`, because that column is a join key with
 * no room beside it for "but the tree was dirty". The rule lives in one
 * expression precisely so it cannot be forgotten at a fifth write site, and it
 * is asserted here on its own rather than only through `flowCommit`.
 *
 * **`matchSourceFile` refusing an ambiguous suffix is the point of it.** Two
 * monorepo files ending `src/index.ts` are the case a suffix rule cannot decide,
 * and a coin toss belongs in neither column of an edge — so the ambiguous case
 * is asserted to return null, not "something reasonable".
 *
 * **`parseCommitRecord` returns null, never a partial.** It reads a
 * subprocess's stdout; a half-built commit that reaches the graph as a node is
 * worse than a commit that never arrived, and a partial is the failure that
 * looks like success.
 *
 * Every git string in this file is real `git` output shape. Inventing a shape
 * would test the parser against a fiction.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMIT_FORMAT,
  FIELD_SEP,
  RECORD_SEP,
  SHORT_SHA_LENGTH,
  commitCaveats,
  describeCommit,
  flowCommit,
  isDirty,
  isSha,
  isShaPrefix,
  joinableSha,
  matchSourceFile,
  normaliseSourcePath,
  parseCommitRecord,
  parseLog,
  parseStatusBranch,
  projectRelative,
  readCheckout,
  recordedLocally,
  shaMatches,
  shortSha,
  unquotePath,
} from '../src/core/git/index.js';
import type { Checkout, Commit, FlowCommit } from '../src/core/git/index.js';
import { relative } from 'node:path';

const SHA = 'a1b2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d';
const SHA_2 = '0f1e2d3c4b5a69788796a5b4c3d2e1f009182736';

function commit(over: Partial<Commit> = {}): Commit {
  return { sha: SHA, committedAt: 1_756_000_000_000, subject: 'Add the cart', author: 'Ada', ...over };
}

function checkout(over: Partial<Checkout> = {}): Checkout {
  return { commit: commit(), branch: 'main', dirty: false, prefix: '', ...over };
}

function stamp(over: Partial<FlowCommit> = {}): FlowCommit {
  return { ...flowCommit(checkout()), ...over };
}

/** One `git log --format=COMMIT_FORMAT --name-only` record, built from the real separators. */
function logRecord(fields: { sha: string; seconds: string; author: string; subject: string }, files: string[]): string {
  const header = [fields.sha, fields.seconds, fields.author, fields.subject].join(FIELD_SEP);
  return RECORD_SEP + [header, ...files].join('\n');
}

describe('COMMIT_FORMAT', () => {
  // The format is written in git's `%xNN` escapes so the argv carries no control
  // bytes; the parser splits on the bytes those escapes produce. If the two ever
  // disagree every commit silently parses as null, so they are tied together here.
  it('asks git for exactly the bytes the parser splits on', () => {
    expect(COMMIT_FORMAT).toBe('%x01%H%x1f%ct%x1f%an%x1f%s');
    expect(RECORD_SEP).toBe('\u0001');
    expect(FIELD_SEP).toBe('\u001f');
  });
});

describe('isSha', () => {
  it('accepts 40 lowercase hex and nothing else in that shape', () => {
    expect(isSha(SHA)).toBe(true);
  });

  it('refuses anything that is not exactly 40 lowercase hex', () => {
    expect(isSha(SHA.toUpperCase())).toBe(false);
    expect(isSha(SHA.slice(0, 39))).toBe(false);
    expect(isSha(`${SHA}0`)).toBe(false);
    expect(isSha(`${SHA.slice(0, 39)}z`)).toBe(false);
    expect(isSha('')).toBe(false);
  });

  it('refuses a non-string rather than coercing one', () => {
    // It is a type guard on a value that arrived from JSON on disk, so `null`
    // and a number both reach it in practice.
    expect(isSha(null)).toBe(false);
    expect(isSha(undefined)).toBe(false);
    expect(isSha(12345)).toBe(false);
    expect(isSha({ toString: () => SHA })).toBe(false);
    expect(isSha([SHA])).toBe(false);
  });
});

describe('isShaPrefix', () => {
  it('accepts seven hex through a full forty', () => {
    // Seven is git's own `--abbrev` floor; the ceiling is a whole SHA.
    expect(isShaPrefix('a1b2c3d')).toBe(true);
    expect(isShaPrefix(SHA.slice(0, 10))).toBe(true);
    expect(isShaPrefix(SHA)).toBe(true);
  });

  it('refuses six, because git will not abbreviate that short either', () => {
    expect(isShaPrefix('a1b2c3')).toBe(false);
  });

  it('refuses forty-one, because nothing longer than a SHA is a prefix of one', () => {
    expect(isShaPrefix(`${SHA}a`)).toBe(false);
  });

  it('refuses uppercase, because a second spelling of one value is a second cache key', () => {
    // git itself resolves `A1B2C3D` fine, so this refusal is a decision and not
    // a limitation — the caller lowercases.
    expect(isShaPrefix('A1B2C3D')).toBe(false);
    expect(isShaPrefix(SHA.toUpperCase())).toBe(false);
    expect(isShaPrefix('a1b2C3d')).toBe(false);
  });

  it('refuses non-hex characters', () => {
    expect(isShaPrefix('ghijklm')).toBe(false);
    expect(isShaPrefix('a1b2c3g')).toBe(false);
  });

  // ── The refusals that are the reason this function exists ──────────────────
  // Everything below would reach `git`'s argv if this check widened. An
  // unanchored regex accepts every one of them by finding hex somewhere inside.

  it('refuses an argument that would be read by git as an option', () => {
    expect(isShaPrefix(`--upload-pack=${SHA}`)).toBe(false);
    expect(isShaPrefix('--upload-pack=touch /tmp/pwned')).toBe(false);
    expect(isShaPrefix(`-c core.pager=${SHA}`)).toBe(false);
    expect(isShaPrefix(`--output=${SHA}`)).toBe(false);
  });

  it('refuses a ref name, however ordinary', () => {
    // `HEAD` is the one a caller is most likely to try to pass by hand, and it
    // is not a SHA — resolving refs is the caller's job, not this argv's.
    expect(isShaPrefix('HEAD')).toBe(false);
    expect(isShaPrefix('head')).toBe(false);
    expect(isShaPrefix('main')).toBe(false);
    expect(isShaPrefix('refs/heads/main')).toBe(false);
  });

  it('refuses range and traversal syntax', () => {
    expect(isShaPrefix('..')).toBe(false);
    expect(isShaPrefix('../../etc/passwd')).toBe(false);
    expect(isShaPrefix(`${SHA}..${SHA_2}`)).toBe(false);
    expect(isShaPrefix(`${SHA}^`)).toBe(false);
    expect(isShaPrefix(`${SHA}~1`)).toBe(false);
  });

  it('refuses shell metacharacters, even though nothing here runs a shell', () => {
    // The spawn is argv-only, so these are not exploitable today. They are
    // refused anyway because the check is what the no-shell assumption rests on.
    expect(isShaPrefix('; rm -rf /')).toBe(false);
    expect(isShaPrefix(`${SHA}; rm -rf /`)).toBe(false);
    expect(isShaPrefix('$(whoami)')).toBe(false);
    expect(isShaPrefix('`id`')).toBe(false);
    expect(isShaPrefix(`${SHA}\n${SHA_2}`)).toBe(false);
    expect(isShaPrefix(` ${SHA} `)).toBe(false);
  });

  it('refuses the empty string and non-strings', () => {
    expect(isShaPrefix('')).toBe(false);
    expect(isShaPrefix(null)).toBe(false);
    expect(isShaPrefix(undefined)).toBe(false);
    expect(isShaPrefix(0)).toBe(false);
    expect(isShaPrefix({ toString: () => SHA })).toBe(false);
  });
});

describe('shortSha', () => {
  it('abbreviates to the one length every surface prints', () => {
    // Ten rather than git's seven, because seven collides in a big repository —
    // and it is a constant so that nothing derives its own.
    expect(SHORT_SHA_LENGTH).toBe(10);
    expect(shortSha(SHA)).toBe('a1b2c3d4e5');
    expect(shortSha(SHA)).toHaveLength(SHORT_SHA_LENGTH);
  });

  it('returns a short input whole rather than padding it', () => {
    expect(shortSha('abc')).toBe('abc');
  });
});

describe('shaMatches', () => {
  it('matches a genuine prefix of seven or more', () => {
    expect(shaMatches(SHA.slice(0, 7), SHA)).toBe(true);
    expect(shaMatches(SHA.slice(0, 10), SHA)).toBe(true);
    expect(shaMatches(SHA, SHA)).toBe(true);
  });

  it('refuses a prefix shorter than seven even when it genuinely is one', () => {
    // The floor is deliberate: at six characters a prefix names several commits
    // in a real repository, so "it is a prefix" stops meaning "it is the one".
    expect(SHA.startsWith(SHA.slice(0, 6))).toBe(true);
    expect(shaMatches(SHA.slice(0, 6), SHA)).toBe(false);
  });

  it('refuses a prefix that is not one, and a candidate that is not a SHA', () => {
    expect(shaMatches(SHA_2.slice(0, 10), SHA)).toBe(false);
    expect(shaMatches(SHA.slice(0, 10), 'not-a-sha')).toBe(false);
    expect(shaMatches(SHA.slice(0, 10).toUpperCase(), SHA)).toBe(false);
  });
});

describe('parseStatusBranch', () => {
  it('reads a branch tracking a remote, and drops the tracking half', () => {
    // Whether a branch is ahead says something about the developer's afternoon
    // and nothing about which build a recording was made against.
    expect(parseStatusBranch('## main...origin/main [ahead 21]')).toEqual({
      branch: 'main',
      detached: false,
      noCommits: false,
    });
  });

  it('reads a branch with no upstream', () => {
    expect(parseStatusBranch('## main')).toEqual({ branch: 'main', detached: false, noCommits: false });
    expect(parseStatusBranch('## phase-3/git-lineage')).toEqual({
      branch: 'phase-3/git-lineage',
      detached: false,
      noCommits: false,
    });
  });

  it('reads a detached HEAD as detached rather than as a branch named HEAD', () => {
    // A detached HEAD is an ordinary commit and, on CI, the likeliest thing to be
    // a real deployed build — so it must not become the branch name `HEAD`.
    expect(parseStatusBranch('## HEAD (no branch)')).toEqual({
      branch: null,
      detached: true,
      noCommits: false,
    });
  });

  it('reads a repository nobody has committed to, keeping the branch name', () => {
    expect(parseStatusBranch('## No commits yet on main')).toEqual({
      branch: 'main',
      detached: false,
      noCommits: true,
    });
  });
});

describe('isDirty', () => {
  it('is clean when the header line is all there is', () => {
    // `--branch` guarantees the header, so "one line" is the clean shape and not
    // an empty-output edge case.
    expect(isDirty('## main...origin/main [ahead 21]')).toBe(false);
    expect(isDirty('## main...origin/main [ahead 21]\n')).toBe(false);
  });

  it('is dirty for a tracked edit', () => {
    expect(isDirty('## main...origin/main\n M src/a.txt')).toBe(true);
  });

  it('is dirty for an untracked file', () => {
    // An untracked file is a build that exists nowhere just as much as an edit
    // is, so `??` counts.
    expect(isDirty('## main\n?? new.txt')).toBe(true);
  });

  it('is dirty for several entries at once', () => {
    expect(isDirty('## main\n M src/a.txt\nA  src/b.txt\n?? new.txt')).toBe(true);
  });
});

describe('parseCommitRecord', () => {
  it('reads a whole record, converting git seconds to milliseconds once', () => {
    // git speaks seconds and the rest of this project speaks milliseconds; the
    // conversion happens here and nowhere else.
    const parsed = parseCommitRecord([SHA, '1756000000', 'Ada Lovelace', 'Add the cart'].join(FIELD_SEP));

    expect(parsed).toEqual({
      sha: SHA,
      committedAt: 1_756_000_000_000,
      subject: 'Add the cart',
      author: 'Ada Lovelace',
    });
  });

  it('has no author rather than an empty one', () => {
    expect(parseCommitRecord([SHA, '1756000000', '   ', 'Add the cart'].join(FIELD_SEP))?.author).toBeNull();
  });

  it('returns null, not a partial commit, for a bad sha', () => {
    // A half-built commit reaching the graph as a node is worse than a commit
    // that never arrived — so this is null and not `{ sha: 'nope', ... }`.
    expect(parseCommitRecord(['nope', '1756000000', 'Ada', 'Add the cart'].join(FIELD_SEP))).toBeNull();
    expect(parseCommitRecord([SHA.toUpperCase(), '1756000000', 'Ada', 'x'].join(FIELD_SEP))).toBeNull();
    expect(parseCommitRecord([SHA.slice(0, 10), '1756000000', 'Ada', 'x'].join(FIELD_SEP))).toBeNull();
  });

  it('returns null for a non-numeric timestamp rather than a commit dated NaN', () => {
    expect(parseCommitRecord([SHA, 'yesterday', 'Ada', 'Add the cart'].join(FIELD_SEP))).toBeNull();
  });

  it('returns null for an empty record', () => {
    expect(parseCommitRecord('')).toBeNull();
  });

  it('returns null for a record missing its fields entirely', () => {
    expect(parseCommitRecord(SHA)).toBeNull();
  });
});

describe('unquotePath', () => {
  it('passes an unquoted path through untouched', () => {
    // Git only quotes when it has to, so the overwhelming majority of lines
    // arrive like this and must not be mangled.
    expect(unquotePath('src/core/git/index.ts')).toBe('src/core/git/index.ts');
    expect(unquotePath('a file with spaces.txt')).toBe('a file with spaces.txt');
  });

  it('unescapes a quote, a backslash and a newline inside a quoted path', () => {
    // These three are exactly why git quotes at all, and the newline case is the
    // one that would otherwise break splitting the output on newlines.
    expect(unquotePath('"src/a\\"b.txt"')).toBe('src/a"b.txt');
    expect(unquotePath('"src/a\\\\b.txt"')).toBe('src/a\\b.txt');
    expect(unquotePath('"src/two\\nlines.txt"')).toBe('src/two\nlines.txt');
    expect(unquotePath('"src/a\\tb.txt"')).toBe('src/a\tb.txt');
  });

  // `\303\251` is the two bytes of `é`, and they have to be gathered and decoded
  // together: decoding each on its own gives `Ã©`, a path that looks plausible,
  // matches nothing, and would send a `changed_in` edge at a file that does not
  // exist. This shipped broken once — `const next = body[++i]` had already moved
  // `i` onto the first digit, so the gathering loop started past the backslash,
  // failed on its first test, and emitted the octal digits literally as
  // `src/caf303251.txt`, which is worse than mojibake because it is not even
  // plausible. Both assertions below are here so neither reading can come back.
  it('decodes a run of octal escapes as UTF-8 bytes together, not one at a time', () => {
    expect(unquotePath('"src/caf\\303\\251.txt"')).toBe('src/café.txt');
    expect(unquotePath('"src/caf\\303\\251.txt"')).not.toBe('src/cafÃ©.txt');
  });

  it('decodes a multi-byte run in the middle of a path and resumes after it', () => {
    expect(unquotePath('"src/\\346\\227\\245\\346\\234\\254/x.ts"')).toBe('src/日本/x.ts');
  });

  it('leaves a bare string that merely starts with a quote alone', () => {
    expect(unquotePath('"')).toBe('"');
    expect(unquotePath('"src/a.txt')).toBe('"src/a.txt');
  });
});

describe('parseLog', () => {
  it('reads several commits, each with the files it touched', () => {
    const raw =
      logRecord({ sha: SHA, seconds: '1756000000', author: 'Ada', subject: 'Add the cart' }, [
        'src/Cart.tsx',
        'src/cart/total.ts',
      ]) +
      logRecord({ sha: SHA_2, seconds: '1755900000', author: 'Grace', subject: 'Fix the total' }, ['src/cart/total.ts']);

    const log = parseLog(raw);

    expect(log).toHaveLength(2);
    expect(log[0].commit.sha).toBe(SHA);
    expect(log[0].commit.committedAt).toBe(1_756_000_000_000);
    expect(log[0].files).toEqual(['src/Cart.tsx', 'src/cart/total.ts']);
    expect(log[1].commit.subject).toBe('Fix the total');
    expect(log[1].files).toEqual(['src/cart/total.ts']);
  });

  it('reads a merge commit as a commit with no files, because that is git\u2019s answer', () => {
    // `--name-only` shows nothing for a merge without `-m` or `--first-parent`,
    // and neither is passed on purpose: `-m` would file `changed_in` edges for
    // work the commits either side are about to report. So an empty file list is
    // the truth here, not a parse failure — the commit must still arrive.
    const raw =
      logRecord({ sha: SHA, seconds: '1756000000', author: 'Ada', subject: "Merge branch 'feature'" }, []) +
      logRecord({ sha: SHA_2, seconds: '1755900000', author: 'Grace', subject: 'Fix the total' }, ['src/cart/total.ts']);

    const log = parseLog(raw);

    expect(log).toHaveLength(2);
    expect(log[0].commit.subject).toBe("Merge branch 'feature'");
    expect(log[0].files).toEqual([]);
    expect(log[1].files).toEqual(['src/cart/total.ts']);
  });

  it('skips a malformed record instead of throwing, so one bad line is not the whole log', () => {
    const raw =
      logRecord({ sha: 'not-a-sha', seconds: '1756000000', author: 'Ada', subject: 'Whatever' }, ['src/a.ts']) +
      logRecord({ sha: SHA, seconds: 'not-a-number', author: 'Ada', subject: 'Whatever' }, ['src/b.ts']) +
      logRecord({ sha: SHA_2, seconds: '1755900000', author: 'Grace', subject: 'Fix the total' }, ['src/cart/total.ts']);

    const log = parseLog(raw);

    expect(log).toHaveLength(1);
    expect(log[0].commit.sha).toBe(SHA_2);
  });

  it('unquotes the paths it reports', () => {
    // A quoted path is the only shape git guarantees for a name containing a
    // quote, so the file list must arrive unquoted or nothing downstream can
    // compare it against a source map's path.
    const raw = logRecord({ sha: SHA, seconds: '1756000000', author: 'Ada', subject: 'Rename' }, [
      '"src/a\\"b.txt"',
      'src/plain.ts',
    ]);

    expect(parseLog(raw)[0].files).toEqual(['src/a"b.txt', 'src/plain.ts']);
  });

  it('is empty for empty output rather than yielding a blank commit', () => {
    expect(parseLog('')).toEqual([]);
    expect(parseLog('\n')).toEqual([]);
  });
});

describe('readCheckout', () => {
  const base = {
    topLevel: '/repo',
    status: '## main...origin/main [ahead 21]',
    head: `${RECORD_SEP}${[SHA, '1756000000', 'Ada', 'Add the cart'].join(FIELD_SEP)}\n`,
    projectRoot: '/repo',
    relative,
  };

  it('reads a clean checkout on a branch', () => {
    const state = readCheckout(base);

    expect(state).toEqual({
      known: true,
      checkout: {
        commit: { sha: SHA, committedAt: 1_756_000_000_000, subject: 'Add the cart', author: 'Ada' },
        branch: 'main',
        dirty: false,
        prefix: '',
      },
    });
  });

  it('reads a dirty checkout as dirty, still with its commit', () => {
    // The SHA is the most useful anchor a developer has even when the tree is
    // dirty — "HEAD plus my edits" is how people describe where they are — so
    // dirty is a flag beside the commit, never a reason to withhold it.
    const state = readCheckout({ ...base, status: '## main\n M src/a.txt' });

    expect(state).toEqual({ known: true, checkout: expect.objectContaining({ dirty: true, branch: 'main' }) });
  });

  it('records a SHA and no branch when HEAD is detached', () => {
    // Detached is not a reason: on a CI checkout it is the likeliest thing to be
    // a real deployed build.
    const state = readCheckout({ ...base, status: '## HEAD (no branch)' });

    expect(state.known).toBe(true);
    expect(state.known && state.checkout.branch).toBeNull();
    expect(state.known && state.checkout.commit.sha).toBe(SHA);
  });

  it('is not-a-repo when there is no toplevel', () => {
    // Four repository states are four different answers a person would act on
    // differently, so each keeps its own reason rather than collapsing to null.
    expect(readCheckout({ ...base, topLevel: null })).toEqual({ known: false, reason: 'not-a-repo' });
    expect(readCheckout({ ...base, topLevel: '' })).toEqual({ known: false, reason: 'not-a-repo' });
  });

  it('is no-commits for a repository nobody has committed to', () => {
    expect(readCheckout({ ...base, status: '## No commits yet on main', head: null })).toEqual({
      known: false,
      reason: 'no-commits',
    });
  });

  it('is failed when status could not be read', () => {
    expect(readCheckout({ ...base, status: null })).toEqual({ known: false, reason: 'failed' });
  });

  it('is failed when the head commit could not be read', () => {
    expect(readCheckout({ ...base, head: null })).toEqual({ known: false, reason: 'failed' });
  });

  it('is failed when the head commit is unparseable, rather than half-read', () => {
    expect(readCheckout({ ...base, head: 'fatal: your current branch has no commits' })).toEqual({
      known: false,
      reason: 'failed',
    });
    expect(readCheckout({ ...base, head: '' })).toEqual({ known: false, reason: 'failed' });
  });

  it('has an empty prefix when the project root is the repository root', () => {
    const state = readCheckout(base);
    // Bound once: two calls are two values, and narrowing on the first says
    // nothing about the second.
    expect(state.known && state.checkout.prefix).toBe('');
  });

  it('names where the project sits inside a monorepo', () => {
    // Without this the two halves never meet: git prints repository-relative
    // paths and a source map names project-relative ones.
    const state = readCheckout({ ...base, topLevel: '/repo', projectRoot: '/repo/packages/web' });

    expect(state.known && state.checkout.prefix).toBe('packages/web');
  });

  it('has an empty prefix when the project root climbs out of the repository', () => {
    // It happens when the project root is a symlink git resolved differently.
    // The honest answer is no prefix: every git path then fails to project and
    // no edge is drawn, which beats drawing them against the wrong directory.
    expect(relative('/repo/packages/web', '/repo').startsWith('..')).toBe(true);

    const state = readCheckout({ ...base, topLevel: '/repo/packages/web', projectRoot: '/repo' });

    expect(state.known && state.checkout.prefix).toBe('');
  });
});

describe('flowCommit', () => {
  it('stores the short form rather than leaving every surface to derive it', () => {
    expect(flowCommit(checkout())).toEqual({
      sha: SHA,
      short: shortSha(SHA),
      branch: 'main',
      dirty: false,
      subject: 'Add the cart',
      committedAt: 1_756_000_000_000,
    });
  });

  it('carries no prefix, because that is a fact about this machine and not the recording', () => {
    expect(flowCommit(checkout({ prefix: 'packages/web' }))).not.toHaveProperty('prefix');
  });

  it('keeps dirty and a detached branch on the stamp', () => {
    expect(flowCommit(checkout({ dirty: true, branch: null }))).toMatchObject({ dirty: true, branch: null });
  });
});

describe('joinableSha', () => {
  it('yields the SHA for a clean tree', () => {
    expect(joinableSha(stamp())).toBe(SHA);
  });

  it('yields null for a dirty tree — the single most important rule in the module', () => {
    // `git_sha` on a node is a bare join key with no room beside it to carry
    // "but the tree was dirty". A dirty observation therefore writes nothing:
    // the column means *the last commit at which this node was seen clean*, and
    // that is exactly the fact `changed_in` is crossed against. Writing the SHA
    // anyway looks harmless and quietly makes every staleness answer wrong.
    expect(joinableSha(stamp({ dirty: true }))).toBeNull();
  });

  it('yields null for no stamp at all', () => {
    expect(joinableSha(null)).toBeNull();
    expect(joinableSha(undefined)).toBeNull();
  });
});

describe('recordedLocally', () => {
  it('is true for a page this machine plainly served', () => {
    expect(recordedLocally('http://localhost:5173/x')).toBe(true);
    expect(recordedLocally('http://127.0.0.1:3000')).toBe(true);
    expect(recordedLocally('https://localhost/')).toBe(true);
  });

  it('is true for a subdomain of localhost, which resolves to loopback', () => {
    expect(recordedLocally('http://app.localhost/')).toBe(true);
  });

  it('is true anywhere in 127.0.0.0/8, not just the one address people type', () => {
    expect(recordedLocally('http://127.0.0.2:8080/')).toBe(true);
  });

  it('is false for a hostname, which is the case the caveat exists for', () => {
    // Staging is the whole reason this function exists: the developer is on a
    // feature branch and the deployed build is last Tuesday's, so the stamp and
    // the page are unrelated until somebody says so.
    expect(recordedLocally('https://staging.example.com')).toBe(false);
    expect(recordedLocally('https://example.com/localhost')).toBe(false);
    expect(recordedLocally('https://notlocalhost.com/')).toBe(false);
    expect(recordedLocally('https://localhost.example.com/')).toBe(false);
  });

  it('is false for a missing or malformed URL rather than throwing', () => {
    // `startUrl` reaches this from recordings made before any of this existed,
    // so absent and unparseable are ordinary inputs.
    expect(recordedLocally(null)).toBe(false);
    expect(recordedLocally(undefined)).toBe(false);
    expect(recordedLocally('')).toBe(false);
    expect(recordedLocally('not a url')).toBe(false);
    expect(recordedLocally('http://')).toBe(false);
  });

  // WHATWG keeps the brackets, so `new URL('http://[::1]/').hostname` is `[::1]`
  // and not `::1`. A comment in the module once claimed otherwise, which made
  // its loopback test dead code and caveated every IPv6 loopback recording as
  // one this machine did not serve — the opposite of the truth.
  it('is true for an IPv6 loopback literal', () => {
    expect(recordedLocally('http://[::1]:8080/')).toBe(true);
  });
});

describe('describeCommit', () => {
  it('reads as short SHA, branch and subject', () => {
    expect(describeCommit(stamp())).toBe('a1b2c3d4e5 on main — Add the cart');
  });

  it('says detached rather than printing nothing where a branch would be', () => {
    // A blank there reads as a missing field; `(detached)` reads as a fact.
    expect(describeCommit(stamp({ branch: null }))).toBe('a1b2c3d4e5 (detached) — Add the cart');
  });

  it('says the tree was dirty in the same line as the commit', () => {
    expect(describeCommit(stamp({ dirty: true }))).toBe('a1b2c3d4e5 on main, working tree dirty — Add the cart');
  });

  it('omits the dash entirely when there is no subject', () => {
    expect(describeCommit(stamp({ subject: '' }))).toBe('a1b2c3d4e5 on main');
  });
});

describe('commitCaveats', () => {
  it('says nothing about a clean tree recorded off this machine', () => {
    // The ordinary case — somebody recording localhost against the app they are
    // editing — is the one case where the stamp means what it appears to mean,
    // so it must not be decorated with a caveat that trains readers to skip them.
    expect(commitCaveats(stamp(), 'http://localhost:5173/cart')).toEqual([]);
  });

  it('caveats a recording made against a page this machine did not serve', () => {
    const caveats = commitCaveats(stamp(), 'https://staging.example.com/cart');

    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toContain('this machine did not serve');
  });

  it('caveats a dirty tree, naming the commit the edits sat on top of', () => {
    const caveats = commitCaveats(stamp({ dirty: true }), 'http://localhost:5173/cart');

    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toContain('uncommitted changes');
    expect(caveats[0]).toContain('a1b2c3d4e5');
  });

  it('returns both when both are true, rather than the more alarming one', () => {
    // They are returned as a list because a renderer asked to concatenate two
    // caveats itself is a renderer that will print one of them.
    expect(commitCaveats(stamp({ dirty: true }), 'https://staging.example.com/cart')).toHaveLength(2);
  });

  it('caveats a recording with no start URL at all', () => {
    expect(commitCaveats(stamp(), null)).toHaveLength(1);
  });
});

describe('normaliseSourcePath', () => {
  it('leaves an already project-relative path alone', () => {
    expect(normaliseSourcePath('src/Cart.tsx')).toBe('src/Cart.tsx');
  });

  it('strips a leading slash from an absolute path', () => {
    // It does not try to guess where the project root was inside it — that guess
    // is what `matchSourceFile`'s suffix rule handles, under a uniqueness check.
    expect(normaliseSourcePath('/Users/x/app/src/Cart.tsx')).toBe('Users/x/app/src/Cart.tsx');
  });

  it('strips a scheme and its authority', () => {
    expect(normaliseSourcePath('webpack://app/./src/Cart.tsx')).toBe('src/Cart.tsx');
  });

  it('strips a scheme with an empty authority', () => {
    expect(normaliseSourcePath('webpack:///src/Cart.tsx')).toBe('src/Cart.tsx');
  });

  it('normalises Windows separators, because a source map may carry them', () => {
    expect(normaliseSourcePath('src\\components\\Cart.tsx')).toBe('src/components/Cart.tsx');
    expect(normaliseSourcePath('C:\\app\\src\\Cart.tsx')).toBe('C:/app/src/Cart.tsx');
  });

  it('collapses doubled slashes so two spellings of one file compare equal', () => {
    expect(normaliseSourcePath('src//Cart.tsx')).toBe('src/Cart.tsx');
  });

  it('makes the four spellings of one file agree', () => {
    // This is the whole job: `src/Cart.tsx`, `./src/Cart.tsx` and both webpack
    // forms are one file said four ways.
    const forms = ['src/Cart.tsx', './src/Cart.tsx', 'webpack://app/./src/Cart.tsx', 'webpack:///src/Cart.tsx'];

    expect(new Set(forms.map(normaliseSourcePath)).size).toBe(1);
  });
});

describe('projectRelative', () => {
  it('passes a path through when the project is the repository root', () => {
    expect(projectRelative('', 'src/Cart.tsx')).toBe('src/Cart.tsx');
  });

  it('strips the prefix a monorepo project sits behind', () => {
    expect(projectRelative('packages/web', 'packages/web/src/Cart.tsx')).toBe('src/Cart.tsx');
  });

  it('is null for a path outside the project, rather than a path that looks inside it', () => {
    // A sibling package's file is not this project's file; returning the
    // untouched path would file a `changed_in` edge against the wrong tree.
    expect(projectRelative('packages/web', 'packages/api/src/Cart.tsx')).toBeNull();
    expect(projectRelative('packages/web', 'README.md')).toBeNull();
  });

  it('is null for a near-miss that merely starts with the same characters', () => {
    expect(projectRelative('packages/web', 'packages/web-legacy/src/Cart.tsx')).toBeNull();
  });

  it('is null for the prefix directory itself, which is not a file in the project', () => {
    expect(projectRelative('packages/web', 'packages/web')).toBeNull();
  });

  it('normalises Windows separators before comparing', () => {
    expect(projectRelative('packages/web', 'packages\\web\\src\\Cart.tsx')).toBe('src/Cart.tsx');
  });
});

describe('matchSourceFile', () => {
  const KNOWN = ['src/Cart.tsx', 'src/cart/total.ts', 'src/checkout/index.ts'];

  it('matches exactly after normalisation', () => {
    expect(matchSourceFile(KNOWN, 'src/Cart.tsx')).toBe('src/Cart.tsx');
    expect(matchSourceFile(KNOWN, './src/Cart.tsx')).toBe('src/Cart.tsx');
    expect(matchSourceFile(KNOWN, 'src\\Cart.tsx')).toBe('src/Cart.tsx');
  });

  it('matches an absolute graph id by suffix when exactly one candidate ends there', () => {
    // A source map that recorded the developer's home directory gives an id that
    // is the same file and would otherwise never meet a project-relative git path.
    const known = ['webpack:///Users/ada/app/src/Cart.tsx', 'webpack:///Users/ada/app/src/cart/total.ts'];

    expect(matchSourceFile(known, 'src/Cart.tsx')).toBe('webpack:///Users/ada/app/src/Cart.tsx');
  });

  it('refuses an ambiguous suffix rather than picking one', () => {
    // Two monorepo files ending `src/index.ts` is precisely the case the suffix
    // rule cannot decide, and a coin toss belongs in neither column of an edge.
    // Returning either one here would draw a `changed_in` edge claiming a commit
    // changed a file it never touched — a wrong answer wearing an observation's
    // clothes.
    const known = ['/repo/packages/web/src/index.ts', '/repo/packages/api/src/index.ts'];

    expect(matchSourceFile(known, 'src/index.ts')).toBeNull();
  });

  it('still refuses when three or more candidates share the suffix', () => {
    const known = ['a/src/index.ts', 'b/src/index.ts', 'c/src/index.ts'];

    expect(matchSourceFile(known, 'src/index.ts')).toBeNull();
  });

  it('prefers an exact match over the suffixes that would otherwise be ambiguous', () => {
    // Exactness is not a coin toss, so an exact candidate settles a set that a
    // suffix rule would have had to refuse.
    const known = ['src/index.ts', '/repo/packages/api/src/index.ts', '/repo/packages/web/src/index.ts'];

    expect(matchSourceFile(known, 'src/index.ts')).toBe('src/index.ts');
  });

  it('picks deterministically when two ids normalise to the same path', () => {
    // Two spellings of one file — either answers the question, so the tie is
    // broken by sort rather than by input order.
    const known = ['webpack:///src/Cart.tsx', './src/Cart.tsx'];

    expect(matchSourceFile(known, 'src/Cart.tsx')).toBe(matchSourceFile([...known].reverse(), 'src/Cart.tsx'));
  });

  it('is null when nothing matches', () => {
    expect(matchSourceFile(KNOWN, 'src/Unknown.tsx')).toBeNull();
    expect(matchSourceFile([], 'src/Cart.tsx')).toBeNull();
  });

  it('is null for an empty path, which would otherwise suffix-match everything', () => {
    expect(matchSourceFile(KNOWN, '')).toBeNull();
    expect(matchSourceFile(KNOWN, '/')).toBeNull();
  });
});
