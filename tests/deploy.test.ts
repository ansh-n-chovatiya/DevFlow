/**
 * Choosing two builds, and keeping four sections from reading as one claim.
 *
 * The module under test is the join `compare_flows_across_deploys` adds on top
 * of `compare_flows`, and almost everything that can go wrong in it is a
 * judgement rather than a calculation: which recording is the older build, what
 * to say when there is only one build, and — the one that matters most — that
 * the intersection of "changed in this range" and "DevFlow has seen this run"
 * is printed as a shortlist and never as a cause.
 */

import { describe, expect, it } from 'vitest';
import type { CommitChange, FlowCommit } from '../src/core/git/index.js';
import type { DeployRecording } from '../src/core/deploy/index.js';
import { choosePair, renderDeployDiff, suspectFiles } from '../src/core/deploy/index.js';

const sha = (seed: string) => seed.repeat(40).slice(0, 40);

function commit(seed: string, at: number, extra: Partial<FlowCommit> = {}): FlowCommit {
  return {
    sha: sha(seed),
    short: sha(seed).slice(0, 10),
    branch: 'main',
    dirty: false,
    subject: `subject ${seed}`,
    committedAt: at,
    ...extra,
  };
}

function recording(
  id: string,
  at: number,
  git: FlowCommit,
  extra: Partial<DeployRecording> = {},
): DeployRecording {
  return {
    id,
    name: 'Checkout',
    timestamp: at,
    startUrl: 'http://localhost:5173/cart',
    git,
    ...extra,
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe('choosing the two builds', () => {
  const oldBuild = commit('a', 1_000);
  const newBuild = commit('b', 2_000);

  it('takes the latest two builds when no commit is named', () => {
    const chosen = choosePair([
      recording('f1', 10 * DAY, oldBuild),
      recording('f2', 20 * DAY, newBuild),
    ]);

    expect(chosen).toMatchObject({ pair: { older: { id: 'f1' }, newer: { id: 'f2' } } });
  });

  /*
   * The reason the pair is ordered by commit date and not by recording date.
   *
   * Reproducing a regression means checking out the old build and recording it
   * *second*, which is the ordinary way to end up here — and a report that
   * called that recording the newer build would have every sentence after it
   * backwards while still reading perfectly well.
   */
  it('calls the older commit the older build even when it was recorded second', () => {
    const chosen = choosePair([
      recording('recorded-first', 10 * DAY, newBuild),
      recording('recorded-second', 20 * DAY, oldBuild),
    ]);

    expect(chosen).toMatchObject({
      pair: { older: { id: 'recorded-second' }, newer: { id: 'recorded-first' } },
    });
  });

  it('falls back to the recording time only when two commits share a second', () => {
    const twin = commit('c', 1_000);
    const chosen = choosePair([
      recording('later', 20 * DAY, twin),
      recording('earlier', 10 * DAY, commit('a', 1_000)),
    ]);

    expect(chosen).toMatchObject({ pair: { older: { id: 'earlier' }, newer: { id: 'later' } } });
  });

  it('takes the most recent recording at a named commit, not the first found', () => {
    const chosen = choosePair(
      [
        recording('stale', 5 * DAY, oldBuild),
        recording('fresh', 15 * DAY, oldBuild),
        recording('other', 20 * DAY, newBuild),
      ],
      { sha: oldBuild.short },
    );

    expect(chosen).toMatchObject({ pair: { older: { id: 'fresh' }, newer: { id: 'other' } } });
  });

  it('accepts a short prefix of a commit', () => {
    const chosen = choosePair(
      [recording('f1', 10 * DAY, oldBuild), recording('f2', 20 * DAY, newBuild)],
      { sha: oldBuild.sha.slice(0, 7), otherSha: newBuild.sha.slice(0, 7) },
    );

    expect(chosen).toMatchObject({ pair: { older: { id: 'f1' }, newer: { id: 'f2' } } });
  });

  /*
   * Each refusal names what is available, because the caller's next move is
   * different for every one of them and "not found" answers none: a typo, a
   * flow nobody recorded twice, and a flow recorded ten times at one commit are
   * three situations and only the first is worth retrying.
   */
  it('says nothing carries a commit rather than reporting no flows', () => {
    const chosen = choosePair([]);
    expect(chosen).toMatchObject({ problem: expect.stringContaining('carries a commit') });
  });

  it('refuses one build and says which one it is', () => {
    const chosen = choosePair([
      recording('f1', 10 * DAY, oldBuild),
      recording('f2', 20 * DAY, oldBuild),
    ]);

    expect(chosen).toMatchObject({ problem: expect.stringContaining(oldBuild.short) });
    expect('pair' in chosen).toBe(false);
  });

  it('lists the commits it does have when the one asked for is not among them', () => {
    const chosen = choosePair(
      [recording('f1', 10 * DAY, oldBuild), recording('f2', 20 * DAY, newBuild)],
      { sha: 'ffffffff' },
    );

    if (!('problem' in chosen)) throw new Error('expected a refusal');
    expect(chosen.problem).toContain('ffffffff');
    expect(chosen.problem).toContain(oldBuild.short);
    expect(chosen.problem).toContain(newBuild.short);
  });

  it('refuses two names for one commit rather than comparing a build to itself', () => {
    const chosen = choosePair(
      [recording('f1', 10 * DAY, oldBuild), recording('f2', 20 * DAY, newBuild)],
      { sha: oldBuild.sha.slice(0, 7), otherSha: oldBuild.sha.slice(0, 12) },
    );

    expect(chosen).toMatchObject({ problem: expect.stringContaining('one build here and not two') });
  });

  /*
   * A prefix long enough to pass validation can still be short enough to be
   * ambiguous, and answering with whichever row sorted first would silently
   * compare a build the caller did not ask for.
   */
  it('refuses a prefix that matches two different commits', () => {
    const twinA = { ...commit('a', 1_000), sha: `abcdefa${'1'.repeat(33)}`, short: 'abcdefa111' };
    const twinB = { ...commit('b', 2_000), sha: `abcdefa${'2'.repeat(33)}`, short: 'abcdefa222' };

    const chosen = choosePair(
      [recording('f1', 10 * DAY, twinA), recording('f2', 20 * DAY, twinB)],
      { sha: 'abcdefa' },
    );

    expect(chosen).toMatchObject({ problem: expect.stringContaining('more than one commit') });
  });
});

describe('the files DevFlow has seen running', () => {
  const range: CommitChange[] = [
    {
      commit: { sha: sha('b'), committedAt: 2_000, subject: 'fix cart total', author: 'T' },
      files: ['src/Cart.tsx', 'docs/notes.md', 'src/util.ts'],
    },
    {
      commit: { sha: sha('a'), committedAt: 1_000, subject: 'tidy', author: 'T' },
      files: ['src/Cart.tsx'],
    },
  ];

  /*
   * The whole reason this section is narrower than the commit list above it: a
   * deploy touching three files produces one suspect, because the other two are
   * files no recording has ever run through. That gap is what an accumulated
   * runtime graph knows and `git log --name-only` does not, so a change that
   * quietly widened this back to every changed file would delete the feature
   * while leaving the output looking richer.
   */
  it('keeps only the changed files something was observed running in', () => {
    const suspects = suspectFiles({
      range,
      prefix: '',
      observed: { 'src/Cart.tsx': ['Cart', 'CartRow'] },
    });

    expect(suspects.map((s) => s.file)).toEqual(['src/Cart.tsx']);
    expect(suspects[0].components).toEqual(['Cart', 'CartRow']);
  });

  it('counts a file once per commit that touched it', () => {
    const [suspect] = suspectFiles({
      range,
      prefix: '',
      observed: { 'src/Cart.tsx': ['Cart'] },
    });

    expect(suspect.commits.map((c) => c.subject)).toEqual(['fix cart total', 'tidy']);
  });

  it('ranks by how much has been observed in a file, then by how often it changed', () => {
    const suspects = suspectFiles({
      range,
      prefix: '',
      observed: { 'src/Cart.tsx': ['Cart'], 'src/util.ts': ['Util', 'Format'] },
    });

    // src/util.ts changed once and src/Cart.tsx twice, so ordering on commits
    // alone would put Cart first — components come first deliberately.
    expect(suspects.map((s) => s.file)).toEqual(['src/util.ts', 'src/Cart.tsx']);
  });

  it('projects a monorepo path onto the file a source map named', () => {
    const suspects = suspectFiles({
      range: [
        {
          commit: { sha: sha('b'), committedAt: 2_000, subject: 'x', author: null },
          files: ['packages/web/src/Cart.tsx', 'packages/api/src/Cart.tsx'],
        },
      ],
      prefix: 'packages/web',
      observed: { 'src/Cart.tsx': ['Cart'] },
    });

    // The api copy is outside the prefix, so it never becomes a candidate —
    // which is the point: two files of that name exist and only one is this
    // project's.
    expect(suspects.map((s) => s.file)).toEqual(['src/Cart.tsx']);
  });

  it('has nothing to say when nothing has been observed', () => {
    expect(suspectFiles({ range, prefix: '', observed: {} })).toEqual([]);
  });
});

describe('the report', () => {
  const pair = {
    older: recording('f1', 10 * DAY, commit('a', 1_000)),
    newer: recording('f2', 20 * DAY, commit('b', 2_000)),
  };

  const base = {
    pair,
    runtimeDiff: '**Steps:** 3 in "Checkout", 3 in "Checkout"; the first 3 match.',
    range: [
      {
        commit: { sha: sha('b'), committedAt: 2_000, subject: 'fix cart total', author: 'T' },
        files: ['src/Cart.tsx'],
      },
    ] as CommitChange[],
    rangeProblem: null,
    reversed: null,
    suspects: [
      { file: 'src/Cart.tsx', commits: [{ short: sha('b').slice(0, 10), subject: 'fix cart total' }], components: ['Cart'] },
    ],
  };

  it('keeps the observation and the shortlist in separate sections', () => {
    const report = renderDeployDiff(base);

    expect(report).toContain('## What changed at runtime');
    expect(report).toContain('## What shipped between the two builds');
    expect(report).toContain('## Of those, the files DevFlow has seen running');
    expect(report.indexOf('## What changed at runtime')).toBeLessThan(
      report.indexOf('## Of those, the files DevFlow has seen running'),
    );
  });

  /*
   * The one sentence in this module that must not be edited away.
   *
   * Everything else here is arrangement; this is the difference between a tool
   * that offers evidence and one that names a culprit, and `core/diagnose` sets
   * the same precedent for the same reason.
   */
  it('says in words that the shortlist is not a cause', () => {
    const report = renderDeployDiff(base);
    expect(report).toContain('**A shortlist, not a cause.**');
  });

  it('prints no caveat for a clean local recording on both sides', () => {
    expect(renderDeployDiff(base)).not.toContain('>');
  });

  /*
   * A dirty stamp names a build that exists on no machine, and a recording made
   * against a deployed page is not evidence about the local checkout at all. A
   * cross-build comparison is worthless if either of those is true and unsaid,
   * so they go above the comparison and not into a footnote.
   */
  it('puts a dirty tree and a remote page above the comparison, not below it', () => {
    const report = renderDeployDiff({
      ...base,
      pair: {
        older: recording('f1', 10 * DAY, commit('a', 1_000, { dirty: true })),
        newer: recording('f2', 20 * DAY, commit('b', 2_000), {
          startUrl: 'https://staging.example.com/cart',
        }),
      },
    });

    expect(report).toContain('Older: The working tree had uncommitted changes');
    expect(report).toContain('Newer: This flow was recorded against a page this machine did not serve');
    expect(report.indexOf('uncommitted changes')).toBeLessThan(report.indexOf('## What changed at runtime'));
  });

  it('says an empty range means the difference came from outside the repository', () => {
    const report = renderDeployDiff({ ...base, range: [], suspects: [] });
    expect(report).toContain('Nothing was committed between');
    expect(report).toContain('a backend deploy, a dependency, data, or the environment');
  });

  /*
   * An empty range and diverged branches produce the same empty `git log`, and
   * they are not the same finding: one says nothing shipped, the other says the
   * question "what shipped between these" has no single answer.
   */
  it('tells diverged branches apart from nothing having shipped', () => {
    const report = renderDeployDiff({ ...base, range: [], reversed: 4, suspects: [] });
    expect(report).toContain('branches that diverged');
    expect(report).not.toContain('Nothing was committed between');
  });

  it('falls back to the runtime difference alone when git could not answer', () => {
    const report = renderDeployDiff({
      ...base,
      range: null,
      rangeProblem: 'The repository has no commit ' + sha('a').slice(0, 10) + '.',
      suspects: [],
    });

    expect(report).toContain('The repository has no commit');
    expect(report).toContain('## What changed at runtime');
  });

  it('reports an empty shortlist as a finding rather than an empty list', () => {
    const report = renderDeployDiff({ ...base, suspects: [] });
    expect(report).toContain('no recording has ever run through');
  });
});
