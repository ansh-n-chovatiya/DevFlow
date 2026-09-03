/**
 * The judgement in `core/forensics`, away from git and away from SQLite.
 *
 * Most of these are about a *standing* rather than about a list, because the
 * list is the easy half: git said which commits touched the file and nothing
 * here re-decides that. What this module decides is which side of the graph's
 * last clean sighting each commit fell on, and every way that can go wrong is
 * silent — a commit misplaced as `seen-since` simply does not appear at the top
 * of an answer nobody knew was incomplete.
 *
 * So the accusing standing is what most of these guard: `unseen-since` is the
 * one that sends somebody to read a diff, and the cases below are the ones
 * where it must *not* be given.
 */

import { describe, expect, it } from 'vitest';
import type { ForensicCommit, ForensicSubject } from '../src/core/forensics/index.js';
import {
  describeCoverage,
  rankCandidates,
  renderBlastRadius,
  renderForensics,
} from '../src/core/forensics/index.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

const commit = (n: number, at: number, extra: Partial<ForensicCommit> = {}): ForensicCommit => ({
  sha: String(n).repeat(40).slice(0, 40),
  shortSha: String(n).repeat(10).slice(0, 10),
  subject: `commit ${n}`,
  author: 'Ada',
  committedAt: at,
  inGraph: false,
  walkIndex: null,
  ...extra,
});

/** A walk, newest first, as `--topo-order` hands one over: index 0 is HEAD. */
const walk = (...commits: ForensicCommit[]): ForensicCommit[] =>
  commits.map((c, walkIndex) => ({ ...c, walkIndex }));

const subject = (extra: Partial<ForensicSubject> = {}): ForensicSubject => ({
  kind: 'component',
  name: 'CartButton',
  file: 'src/Cart.tsx',
  line: 12,
  observedSha: null,
  frequency: 9,
  failureRate: 0,
  lastObservedAt: T0,
  ...extra,
});

describe('rankCandidates', () => {
  it('places a commit by where it sits in the history, not by its date', () => {
    // The two commits share a second, which is what git actually records and
    // what the first end-to-end run of this module produced. Only ancestry can
    // separate them, and ancestry is what the walk order is.
    const [head, anchor] = walk(commit(2, T0), commit(1, T0));

    const { candidates, coverage } = rankCandidates({
      subject: subject({ observedSha: anchor.sha }),
      commits: [head, anchor],
      anchorIndex: 1,
      anchorCommittedAt: T0,
      walked: 2,
      capped: false,
    });

    expect(coverage.orderedBy).toBe('history');
    expect(candidates.map((c) => c.standing)).toEqual(['unseen-since', 'anchor']);
    expect(candidates[0].sha).toBe(head.sha);
    expect(candidates[0].basis).toContain('landed after the commit the graph saw');
  });

  it('keeps the anchor as its own standing rather than folding it into seen-since', () => {
    const [anchor, older] = walk(commit(1, T0), commit(2, T0 - DAY));
    const { candidates } = rankCandidates({
      subject: subject({ observedSha: anchor.sha }),
      commits: [anchor, older],
      anchorIndex: 0,
      anchorCommittedAt: T0,
      walked: 2,
      capped: false,
    });

    expect(candidates[0].standing).toBe('anchor');
    expect(candidates[0].basis).toContain('last observed at');
    expect(candidates[1].standing).toBe('seen-since');
  });

  it('orders unseen-since newest first, then the anchor, then seen-since', () => {
    const history = walk(
      commit(1, T0 + 2 * DAY),
      commit(2, T0 + DAY),
      commit(3, T0),
      commit(4, T0 - DAY),
      commit(5, T0 - 2 * DAY),
    );

    const { candidates } = rankCandidates({
      subject: subject({ observedSha: history[2].sha }),
      commits: [history[4], history[1], history[2], history[0], history[3]],
      anchorIndex: 2,
      anchorCommittedAt: T0,
      walked: 5,
      capped: false,
    });

    expect(candidates.map((c) => c.walkIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(candidates.map((c) => c.standing)).toEqual([
      'unseen-since',
      'unseen-since',
      'anchor',
      'seen-since',
      'seen-since',
    ]);
  });

  it('falls back to dates when the sighting is older than the walk, and says so', () => {
    const history = walk(commit(1, T0 + DAY), commit(2, T0));
    const { candidates, coverage } = rankCandidates({
      subject: subject({ observedSha: commit(9, 0).sha }),
      commits: history,
      anchorIndex: null,
      anchorCommittedAt: T0 - DAY,
      walked: 2,
      capped: true,
    });

    expect(coverage.orderedBy).toBe('date');
    expect(candidates.every((c) => c.standing === 'unseen-since')).toBe(true);
    expect(candidates[0].basis).toContain('later than the graph');
  });

  it('does not accuse a commit whose date merely equals the sighting, under the fallback', () => {
    // The conservatism has to survive into the weaker ordering: a rebase writes
    // a run of commits in one second and none of them has earned an accusation.
    const history = walk(commit(1, T0), commit(2, T0 - DAY));
    const { candidates } = rankCandidates({
      subject: subject({ observedSha: commit(9, 0).sha }),
      commits: history,
      anchorIndex: null,
      anchorCommittedAt: T0,
      walked: 2,
      capped: true,
    });

    expect(candidates.map((c) => c.standing)).toEqual(['seen-since', 'seen-since']);
  });

  it('marks everything unanchored when there is no clean-tree sighting', () => {
    const { candidates, coverage } = rankCandidates({
      subject: subject({ observedSha: null }),
      commits: walk(commit(1, T0 + DAY), commit(2, T0)),
      anchorIndex: null,
      anchorCommittedAt: null,
      walked: 2,
      capped: false,
    });

    expect(coverage.orderedBy).toBe('none');
    expect(candidates.every((c) => c.standing === 'unanchored')).toBe(true);
    expect(coverage.anchored).toBe(false);
    for (const candidate of candidates) {
      expect(candidate.basis).toContain('never been observed on a clean working tree');
    }
  });

  it('is unanchored when a sha is recorded but its commit could not be dated or placed', () => {
    const { candidates, coverage } = rankCandidates({
      subject: subject({ observedSha: commit(9, 0).sha }),
      commits: walk(commit(1, T0)),
      anchorIndex: null,
      anchorCommittedAt: null,
      walked: 1,
      capped: false,
    });

    expect(coverage.orderedBy).toBe('none');
    expect(candidates[0].standing).toBe('unanchored');
  });

  it('counts what it looked at, what touched the file, and what the graph holds', () => {
    const { coverage } = rankCandidates({
      subject: subject({ observedSha: null }),
      commits: walk(commit(1, T0, { inGraph: true }), commit(2, T0 - DAY)),
      anchorIndex: null,
      anchorCommittedAt: null,
      walked: 200,
      capped: true,
    });

    expect(coverage).toMatchObject({ walked: 200, capped: true, touching: 2, inGraph: 1 });
  });
});

describe('describeCoverage', () => {
  const result = (over: Parameters<typeof rankCandidates>[0]) => describeCoverage(rankCandidates(over)).join(' ');

  it('says the walk stopped at its limit, because a capped list looks like a complete one', () => {
    const text = result({
      subject: subject({ observedSha: null }),
      commits: [commit(1, T0)],
      anchorCommittedAt: null,
      walked: 200,
      capped: true,
    });

    expect(text).toContain('stopped at its limit');
    expect(text).toContain('recent history and not the whole of it');
  });

  it('does not claim a limit was hit when it was not', () => {
    const text = result({
      subject: subject({ observedSha: commit(1, T0).sha }),
      commits: [commit(1, T0)],
      anchorCommittedAt: T0,
      walked: 12,
      capped: false,
    });

    expect(text).not.toContain('stopped at its limit');
  });

  it('says the graph holds a sample of the history rather than a copy of it', () => {
    const text = result({
      subject: subject({ observedSha: null }),
      commits: [commit(1, T0, { inGraph: true }), commit(2, T0 + DAY)],
      anchorCommittedAt: null,
      walked: 30,
      capped: false,
    });

    expect(text).toContain('1 of those');
    expect(text).toContain('sample of yours and not a copy of it');
  });

  it('explains an unanchored subject rather than leaving the standings unexplained', () => {
    const text = result({
      subject: subject({ observedSha: null }),
      commits: [commit(1, T0)],
      anchorCommittedAt: null,
      walked: 30,
      capped: false,
    });

    expect(text).toContain('no clean-tree sighting');
    expect(text).toContain('dirty tree names a build that exists on no machine');
  });

  it('says when the standings came from dates rather than from the history', () => {
    const text = result({
      subject: subject({ observedSha: commit(9, 0).sha }),
      commits: walk(commit(1, T0)),
      anchorIndex: null,
      anchorCommittedAt: T0 - DAY,
      walked: 5,
      capped: true,
    });

    expect(text).toContain('older than this walk');
    expect(text).toContain('to the second');
    expect(text).toContain('larger limit would restore the ordering');
  });

  it('says nothing about dates when the history placed the commits', () => {
    const history = walk(commit(1, T0 + DAY), commit(2, T0));
    const text = result({
      subject: subject({ observedSha: history[1].sha }),
      commits: history,
      anchorIndex: 1,
      anchorCommittedAt: T0,
      walked: 2,
      capped: false,
    });

    expect(text).not.toContain('decided by comparing dates');
  });

  it('reports a git problem instead of a walk it did not make', () => {
    const text = result({
      subject: subject(),
      commits: [],
      anchorCommittedAt: null,
      walked: 0,
      capped: false,
      gitProblem: 'git is switched off',
    });

    expect(text).toContain('No commit history was read: git is switched off');
    expect(text).not.toContain('Read the last 0 commits');
  });
});

describe('renderForensics', () => {
  /** HEAD changed the file after the sighting, which is the ordinary answer. */
  const history = walk(commit(2, T0 + DAY), commit(1, T0));

  const rendered = (over: Partial<Parameters<typeof rankCandidates>[0]> = {}) =>
    renderForensics(
      rankCandidates({
        subject: subject({ observedSha: history[1].sha }),
        commits: history,
        anchorIndex: 1,
        anchorCommittedAt: T0,
        walked: 30,
        capped: false,
        ...over,
      }),
    );

  it('refuses to name a cause, on every answer', () => {
    expect(rendered()).toContain('None of these is a cause');
    expect(rendered({ commits: [] })).toContain('No commit in the walk touched src/Cart.tsx');
  });

  it('leads with how many commits the graph has never seen run', () => {
    expect(rendered()).toContain('1 commit changed this file after the graph last saw CartButton run');
  });

  it('says so plainly when nothing landed after the sighting', () => {
    const older = walk(commit(1, T0), commit(3, T0 - DAY));
    const text = rendered({
      subject: subject({ observedSha: older[0].sha }),
      commits: older,
      anchorIndex: 0,
    });
    expect(text).toContain('None of them landed after the graph last saw CartButton run');
  });

  it('prints a standing and its basis on every row', () => {
    const lines = rendered().split('\n');
    const rows = lines.filter((line) => /^\s{6}\w/.test(line));
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row).toMatch(/^\s+(unseen-since|anchor|seen-since|unanchored): /);
  });

  it('points at the tools that can compare behaviour, since this one compares dates', () => {
    expect(rendered()).toContain('compare_flows_across_deploys');
    expect(rendered()).toContain('it compares dates, not behaviour');
  });

  it('caps the rows and says how many it did not print', () => {
    const many = walk(...Array.from({ length: 25 }, (_, i) => commit(i + 1, T0 - i * DAY)));
    const text = renderForensics(
      rankCandidates({
        subject: subject({ observedSha: null }),
        commits: many,
        anchorIndex: null,
        anchorCommittedAt: null,
        walked: 300,
        capped: false,
      }),
      20,
    );
    expect(text).toContain('and 5 older commits');
  });
});

describe('renderBlastRadius', () => {
  const component = (name: string, frequency: number, reaches: string[] = []) => ({
    id: `cmp_${name}`,
    name,
    line: 12,
    frequency,
    failureRate: 0,
    reaches: reaches.map((label) => ({ edge: 'calls', label, frequency: 3 })),
  });

  it('sends a caller to get_app_architecture when the file is not in the graph', () => {
    const text = renderBlastRadius({
      file: 'src/Nothing.tsx',
      lineStart: null,
      lineEnd: null,
      components: [],
      fileKnown: false,
    });
    expect(text).toContain('no source file matching src/Nothing.tsx');
    expect(text).toContain('get_app_architecture');
  });

  it('always says it counts components written in the file, not files importing it', () => {
    for (const components of [[], [component('Cart', 4)]]) {
      const text = renderBlastRadius({
        file: 'src/Cart.tsx',
        lineStart: null,
        lineEnd: null,
        components,
        fileKnown: true,
      });
      expect(text).toContain('written in');
      expect(text).toContain('does not count files that import it');
    }
  });

  it('warns that a component never exercised does not appear at all', () => {
    const text = renderBlastRadius({
      file: 'src/Cart.tsx',
      lineStart: null,
      lineEnd: null,
      components: [component('Cart', 4)],
      fileKnown: true,
    });
    expect(text).toContain('never exercised while DevFlow was watching does not appear here at all');
  });

  it('orders by how often each was observed and prints what each was seen doing', () => {
    const text = renderBlastRadius({
      file: 'src/Cart.tsx',
      lineStart: null,
      lineEnd: null,
      components: [component('Rare', 1, ['GET /api/a']), component('Busy', 40, ['POST /api/b'])],
      fileKnown: true,
    });
    expect(text.indexOf('Busy')).toBeLessThan(text.indexOf('Rare'));
    expect(text).toContain('POST /api/b');
  });

  it('distinguishes a known-but-empty file from a range that matched nothing', () => {
    const empty = renderBlastRadius({
      file: 'src/Cart.tsx',
      lineStart: null,
      lineEnd: null,
      components: [],
      fileKnown: true,
    });
    const range = renderBlastRadius({
      file: 'src/Cart.tsx',
      lineStart: 40,
      lineEnd: 50,
      components: [],
      fileKnown: true,
    });

    expect(empty).toContain('no component currently resolves to it');
    expect(range).toContain('src/Cart.tsx:40-50');
    expect(range).toContain('resolved to a line in that range');
  });
});
