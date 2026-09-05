/**
 * Which commits changed the code a component was observed in, and which of them
 * the graph has never seen run.
 *
 * ## The roadmap asks for a cause and there is no cause here
 *
 * Work Stream 4.3 words this as a *Regression Bisect Engine* that will
 * "determine the exact commit and PR that introduced the bug". Neither half of
 * that survives contact, and saying so is the deliverable rather than a caveat
 * on it:
 *
 *   - **There is no PR anywhere in this system.** Nothing DevFlow observes
 *     carries a pull-request number: a recording knows a checkout, and a
 *     checkout knows commits. A tool that printed a PR would be printing
 *     something it invented.
 *   - **A commit that changed a file is not thereby the commit that broke it.**
 *     `core/diagnose` names no cause and `core/deploy` calls its intersection a
 *     *shortlist* in those words, for one reason that applies here unchanged:
 *     the mechanism cannot tell a coincidence from a culprit, and a ranked list
 *     printed without that sentence reads exactly like one that can.
 *
 * What is real is narrower and worth more than a guess. The graph records the
 * last commit at which each component was observed **with a clean working
 * tree** (`git_sha`; see `core/git` for why a dirty tree writes nothing). Git
 * records every commit that touched that component's file. Crossed, those give
 * the one fact neither source holds alone: **the commits that changed this
 * file after the last moment DevFlow watched the component run.** That is a
 * bounded, checkable statement about the graph's own ignorance, and it is the
 * shortlist worth reading first.
 *
 * ## Why the walk is git's and the anchor is the graph's
 *
 * The obvious implementation reads `changed_in` edges, which is what the
 * roadmap's own wording assumes, and it is far thinner than it looks.
 * `arkg_git_commits` gains a row only when a recording or a pick arrives while
 * that commit is checked out — so a developer who records once a week has a
 * commit table holding one commit in every few hundred. Asking it "which
 * commits changed this file" answers "one", when git would answer "thirty", and
 * the answer is not wrong so much as about a different question.
 *
 * So the history comes from git, which has all of it, and the graph supplies
 * the thing git cannot know: whether DevFlow has ever watched this code run,
 * and when it last did. Each candidate says which of the two it rests on. The
 * `changed_in` edges keep their own job — they are what `compare_flows_across_
 * deploys` reads, and they are drawn only onto files the graph has already seen
 * code run in — and this does not duplicate them.
 *
 * ## The ordering is ancestry where it can be, and dates only where it cannot
 *
 * This was written to compare commit dates and the first end-to-end run refuted
 * it in one line: git's `%ct` has **one-second resolution**, so two commits made
 * in the same second are indistinguishable, and the anchor and the change that
 * followed it both landed at `2026-09-03`. A date comparison could not tell
 * them apart and quietly resolved to the reassuring answer.
 *
 * Dates were only ever a proxy for the real question — *did this change land
 * after the one we watched running?* — which is a question about ancestry. So
 * the walk is `--topo-order`, which guarantees no parent is listed before its
 * children, and a commit's **position in that walk** is what places it. Dates
 * are the fallback, used only when the sighting is older than the walk's window
 * and so has no position, and `describeCoverage` says which of the two was used
 * rather than letting a reader assume the stronger one.
 *
 * The conservatism survives into the fallback: `unseen-since` is the accusing
 * standing, so a date that merely *equals* the anchor's does not earn it.
 */

/** One commit, as the git walk and the graph both describe one. */
export interface ForensicCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string | null;
  /** Committer date in milliseconds — a fallback ordering, not the first one. */
  committedAt: number;
  /** Whether the graph itself holds this commit as a node. */
  inGraph: boolean;
  /**
   * Where this commit sat in the topological walk: 0 is newest.
   *
   * This is the ordering that places a commit, because it is ancestry and a
   * date is not. Null when the caller has no walk to place it in.
   */
  walkIndex: number | null;
}

/** What the graph knows about the thing being asked about. */
export interface ForensicSubject {
  kind: 'component' | 'source_file';
  name: string;
  /** The source file node, which is what the git walk is matched against. */
  file: string;
  line: number | null;
  /** The last commit it was observed at with a clean tree, or null. */
  observedSha: string | null;
  frequency: number | null;
  failureRate: number | null;
  lastObservedAt: number | null;
}

/**
 * Where one commit sits relative to the graph's last clean sighting.
 *
 * `anchor` is that sighting's own commit and is neither of the other two: it is
 * the boundary, and folding it into `seen-since` would lose the one row a
 * reader most wants to find.
 */
export type CommitStanding = 'unseen-since' | 'anchor' | 'seen-since' | 'unanchored';

export interface Candidate extends ForensicCommit {
  standing: CommitStanding;
  /** What this standing is made of, in words. One per candidate, by design. */
  basis: string;
}

/**
 * What the answer is and is not made of.
 *
 * Every field here exists because its absence would let a partial join read as
 * a complete one. `capped` is the sharpest: a walk that stopped at its limit
 * has not seen the file's whole history, and a list that silently ends at the
 * cap looks identical to one that ended because there was nothing older.
 */
export interface ForensicCoverage {
  /** How many commits the git walk read. */
  walked: number;
  /** Whether the walk hit its limit, so older history was not looked at. */
  capped: boolean;
  /** How many of those touched this file. */
  touching: number;
  /** How many of the touching commits the graph also holds as nodes. */
  inGraph: number;
  /** Whether the subject has a clean-tree observation to anchor against. */
  anchored: boolean;
  /**
   * What placed each commit: this history's own order, or a date comparison.
   *
   * `date` is the weaker of the two and is only reached when the sighting is
   * older than the walk. A reader has to be able to tell, because a same-second
   * tie is invisible under `date` and impossible under `history`.
   */
  orderedBy: 'history' | 'date' | 'none';
  /** Why git could not be walked at all, when it could not. */
  gitProblem: string | null;
}

export interface Forensics {
  subject: ForensicSubject;
  candidates: Candidate[];
  coverage: ForensicCoverage;
}

/**
 * An ISO day, because this is read by a model on a machine, not by a locale.
 *
 * `Number.isFinite` is not the whole guard: a finite millisecond count outside
 * `Date`'s ±8.64e15 range makes `toISOString()` throw a `RangeError`, and these
 * numbers come from a graph fed by flows `POST /flows` barely validates. A time
 * that cannot be described is `'unknown'`, which is what the caller was already
 * prepared to print.
 */
const MAX_DATE_MS = 8.64e15;
const day = (ms: number): string =>
  Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS
    ? new Date(ms).toISOString().slice(0, 10)
    : 'unknown';

/**
 * The order a reader wants: what the graph has never seen, newest first, then
 * the boundary, then what it has.
 *
 * Not "most likely cause first", because nothing here ranks likelihood. The
 * ordering is the standing and the standing is a fact about observation dates.
 */
const STANDING_ORDER: Record<CommitStanding, number> = {
  'unseen-since': 0,
  anchor: 1,
  'seen-since': 2,
  unanchored: 0,
};

/**
 * Every walked commit that touched the subject's file, placed against the
 * graph's last clean sighting.
 *
 * `anchorCommittedAt` is passed rather than looked up because the anchoring
 * commit may sit outside the walk — the graph can hold a sighting from six
 * months ago — and the caller has the graph's own row for it. Null means
 * either no clean sighting exists or its commit is unknown to both sources,
 * and both of those produce `unanchored` rather than a guessed order.
 */
export function rankCandidates(input: {
  subject: ForensicSubject;
  commits: readonly ForensicCommit[];
  /** Where the sighting's own commit sat in the walk, when it was inside it. */
  anchorIndex?: number | null;
  /** Its date, which places it only when it had no position. */
  anchorCommittedAt: number | null;
  walked: number;
  capped: boolean;
  gitProblem?: string | null;
}): Forensics {
  const { subject, commits, anchorCommittedAt, walked, capped } = input;
  const anchorIndex = input.anchorIndex ?? null;

  /*
   * Three ways to place a commit, in descending strength. `history` is ancestry
   * and cannot tie; `date` can, and the tie resolves away from the accusation;
   * `none` places nothing and says so on every row rather than picking an order
   * it cannot defend.
   */
  const orderedBy: ForensicCoverage['orderedBy'] =
    subject.observedSha === null ? 'none' : anchorIndex !== null ? 'history' : anchorCommittedAt !== null ? 'date' : 'none';

  const candidates: Candidate[] = commits.map((commit) => {
    if (orderedBy === 'none') {
      return {
        ...commit,
        standing: 'unanchored',
        basis:
          `${subject.name} has never been observed on a clean working tree, so the graph cannot say ` +
          'whether it has run since this commit',
      };
    }
    if (subject.observedSha === commit.sha) {
      return { ...commit, standing: 'anchor', basis: `the commit ${subject.name} was last observed at` };
    }

    const after =
      orderedBy === 'history'
        ? commit.walkIndex !== null && commit.walkIndex < (anchorIndex as number)
        : commit.committedAt > (anchorCommittedAt as number);

    if (after) {
      return {
        ...commit,
        standing: 'unseen-since',
        basis:
          orderedBy === 'history'
            ? `landed after the commit the graph saw ${subject.name} run at — this change has never been ` +
              'observed running'
            : `committed ${day(commit.committedAt)}, later than the graph's last sighting of ` +
              `${subject.name} (${day(anchorCommittedAt as number)}) — this change has never been observed running`,
      };
    }
    return {
      ...commit,
      standing: 'seen-since',
      basis:
        orderedBy === 'history'
          ? `already in this history when the graph saw ${subject.name} run — it has run since`
          : `committed ${day(commit.committedAt)}, at or before that sighting — ${subject.name} has run since`,
    };
  });

  /*
   * Within a standing, the walk's own order — newest first — and a date only
   * for a commit that had no position. Sorting by date here would undo, in the
   * presentation, exactly the tie the standing was careful about.
   */
  candidates.sort(
    (a, b) =>
      STANDING_ORDER[a.standing] - STANDING_ORDER[b.standing] ||
      (a.walkIndex ?? Number.MAX_SAFE_INTEGER) - (b.walkIndex ?? Number.MAX_SAFE_INTEGER) ||
      b.committedAt - a.committedAt,
  );

  return {
    subject,
    candidates,
    coverage: {
      walked,
      capped,
      touching: candidates.length,
      inGraph: candidates.filter((c) => c.inGraph).length,
      anchored: orderedBy !== 'none',
      orderedBy,
      gitProblem: input.gitProblem ?? null,
    },
  };
}

/**
 * The coverage paragraph, which is the half a reader skips and should not.
 *
 * Written as sentences rather than a table because each one is a limit on the
 * claim above it, and a limit rendered as a number in a column is a limit
 * nobody reads.
 */
export function describeCoverage(result: Forensics): string[] {
  const { subject, coverage } = result;
  const lines: string[] = [];

  if (coverage.gitProblem) {
    lines.push(
      `No commit history was read: ${coverage.gitProblem}. Everything above comes from the graph alone.`,
    );
    return lines;
  }

  lines.push(
    `Read the last ${coverage.walked} commit${coverage.walked === 1 ? '' : 's'} of this checkout; ` +
      `${coverage.touching} touched ${subject.file}.`,
  );

  if (coverage.capped) {
    lines.push(
      'That walk stopped at its limit, so this is the recent history and not the whole of it — an older ' +
        'commit that changed this file was not looked at.',
    );
  }

  lines.push(
    `${coverage.inGraph} of those ${coverage.touching === 1 ? 'is a commit' : 'are commits'} the graph itself ` +
      'holds. It files one only when a recording or a pick arrives while that commit is checked out, so the ' +
      'graph’s own commit history is a sample of yours and not a copy of it — which is why the walk above ' +
      'is git’s and only the sighting is the graph’s.',
  );

  if (coverage.orderedBy === 'date') {
    lines.push(
      `The commit ${subject.name} was last observed at is older than this walk, so it has no position in ` +
        'it and the standings above were decided by comparing dates instead. That is the weaker of the two: ' +
        'git records a commit date to the second, so commits made inside one second — a rebase, or a fast ' +
        'afternoon — cannot be separated by it, and such a commit is reported as already seen rather than ' +
        'accused. Walking further back with a larger limit would restore the ordering.',
    );
  }

  if (!coverage.anchored) {
    lines.push(
      `${subject.name} has no clean-tree sighting to measure against: every observation of it was made with ` +
        'uncommitted changes in the tree, or it has never been observed at all. A dirty tree names a build ' +
        'that exists on no machine, so the graph stores no commit for it — see core/git. Until one clean ' +
        'observation lands, the commits above are history with nothing to divide them.',
    );
  }

  return lines;
}

/**
 * The whole answer, as the text a model reads.
 *
 * The refusal is printed last and unconditionally. It is the sentence that
 * stops a shortlist being read as a verdict, and a sentence that only appears
 * when the tool is unsure is one a reader learns to treat as noise.
 */
export function renderForensics(result: Forensics, limit = 20): string {
  const { subject, candidates, coverage } = result;
  const where = subject.line ? `${subject.file}:${subject.line}` : subject.file;

  const lines: string[] = [
    `${subject.name} — ${where}`,
  ];

  const seen: string[] = [];
  if (subject.frequency !== null) seen.push(`${subject.frequency}x observed`);
  if (subject.failureRate) seen.push(`${(subject.failureRate * 100).toFixed(1)}% failure rate`);
  if (subject.lastObservedAt) seen.push(`last seen ${day(subject.lastObservedAt)}`);
  if (seen.length) lines.push(seen.join('  '));

  if (!candidates.length) {
    lines.push(
      '',
      coverage.gitProblem
        ? 'No commits could be read.'
        : `No commit in the walk touched ${subject.file}.`,
      '',
      ...describeCoverage(result),
    );
    return lines.join('\n');
  }

  const unseen = candidates.filter((c) => c.standing === 'unseen-since');
  lines.push(
    '',
    unseen.length
      ? `${unseen.length} commit${unseen.length === 1 ? '' : 's'} changed this file after the graph last saw ` +
          `${subject.name} run. Those are first below; each row says what its standing is made of.`
      : `Commits that changed this file, newest first. None of them landed after the graph last saw ` +
          `${subject.name} run.`,
    '',
  );

  for (const candidate of candidates.slice(0, limit)) {
    lines.push(
      `  ${candidate.shortSha}  ${day(candidate.committedAt)}  ${candidate.author ?? 'unknown author'}  ` +
        `${candidate.subject}`,
      `      ${candidate.standing}: ${candidate.basis}`,
    );
  }
  if (candidates.length > limit) {
    lines.push(`  … and ${candidates.length - limit} older commit${candidates.length - limit === 1 ? '' : 's'}.`);
  }

  lines.push(
    '',
    ...describeCoverage(result),
    '',
    'None of these is a cause. A commit that changed the file is a commit worth reading first, and the ' +
      'mechanism here cannot tell a coincidence from a culprit — it compares dates, not behaviour. ' +
      'get_component_history says what the component has actually done; compare_flows_across_deploys ' +
      'compares two recordings made at two of these commits, which is the comparison that can.',
  );

  return lines.join('\n');
}

// ── Blast radius ─────────────────────────────────────────────────────────────

/** One component the graph resolved into a file, with what it was seen doing. */
export interface RadiusComponent {
  id: string;
  name: string;
  line: number | null;
  frequency: number;
  failureRate: number;
  /** Endpoints called and stores subscribed to, already labelled by the graph. */
  reaches: readonly { edge: string; label: string; frequency: number }[];
}

/**
 * What the runtime has observed depending on one file — and the narrower thing
 * that actually is.
 *
 * The roadmap's example is *"this change to `useCartStore.ts:42` currently
 * affects 7 rendered components"*, and the query underneath answers a
 * different question than that sentence: `maps_to` edges point from a component
 * to **the file it was written in**, so a store's own file resolves to the
 * components defined in it, which for a store file is usually none. Nothing in
 * a runtime graph sees an *import*; imports are a static fact and this is not a
 * static tool.
 *
 * So the claim is made at the size it is true at — components observed to have
 * been written in this file — and one hop is added, out of edges the graph
 * already holds, because "and here is what those components were seen calling
 * and reading" is the part that makes it actionable. A component that has never
 * been exercised in a recording does not appear at all, and the coverage line
 * says so, because a blast radius that silently omits the untested half is the
 * most dangerous possible form of this answer.
 */
/**
 * The limit on every blast-radius answer, written once.
 *
 * It appeared twice — once on the empty answer and once on the full one — and
 * drifted into two different sentences making one claim, which is how a caller
 * ends up believing the narrow reading applies only to the case they did not
 * get. One string, both branches.
 */
const RADIUS_LIMIT =
  'This counts components observed to have been *written in* this file, plus what each was seen ' +
  'calling and reading. It does not count files that import it — an import is a static fact and ' +
  'nothing in a runtime graph observes one — and a component this application has never exercised ' +
  'while DevFlow was watching does not appear here at all.';

export function renderBlastRadius(input: {
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  components: readonly RadiusComponent[];
  /** Whether the graph holds this file at all, as distinct from holding it empty. */
  fileKnown: boolean;
  limit?: number;
}): string {
  const { file, lineStart, lineEnd, components, fileKnown } = input;
  const limit = input.limit ?? 20;
  const range = lineStart !== null && lineEnd !== null ? `:${lineStart}-${lineEnd}` : '';

  if (!fileKnown) {
    return (
      `The graph has no source file matching ${file}. It knows a file only once a component has been ` +
      'resolved into it — by recording a flow that rendered one, or picking one in the DevTools panel. ' +
      'get_app_architecture lists the components it does hold, each with the file it was resolved to.'
    );
  }

  const lines = [`${file}${range}`];

  if (!components.length) {
    lines.push(
      '',
      range
        ? 'No component the graph has observed was resolved to a line in that range.'
        : 'The graph holds this file but no component currently resolves to it — a source file node ' +
            'survives a component row being merged away, so the file has been seen even though nothing ' +
            'points at it now.',
      '',
      RADIUS_LIMIT,
    );
    return lines.join('\n');
  }

  lines.push(
    '',
    `${components.length} component${components.length === 1 ? '' : 's'} the runtime has observed in this ` +
      `file${range ? ' and range' : ''}:`,
    '',
  );

  for (const component of [...components]
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, limit)) {
    lines.push(
      `  ${component.name}${component.line ? `:${component.line}` : ''}  ${component.frequency}x observed` +
        `${component.failureRate ? `, ${(component.failureRate * 100).toFixed(1)}% failing` : ''}  #${component.id}`,
    );
    for (const reach of component.reaches.slice(0, 6)) {
      lines.push(`      ${reach.edge}  ${reach.label}  ${reach.frequency}x`);
    }
  }
  if (components.length > limit) {
    lines.push(`  … and ${components.length - limit} more.`);
  }

  lines.push('', RADIUS_LIMIT);

  return lines.join('\n');
}
