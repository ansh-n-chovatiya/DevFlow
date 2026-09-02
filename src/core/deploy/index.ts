/**
 * Two recordings of one flow, made at two commits, lined up against each other.
 *
 * ## What was already here, and what was actually missing
 *
 * `compare_flows` has shipped for some time and it does the hard half: where
 * two runs stop doing the same thing, which endpoints answered differently,
 * what only one of them calls, which errors only one logs. The roadmap's
 * `compare_flows_across_deploys(flowId, sha1, sha2)` is that comparison plus a
 * **join on the commit**, and the join is all this module adds. Building a
 * second comparison beside a working one would have been the mistake this
 * repository has already made once with its markdown renderers.
 *
 * The roadmap's signature does not survive contact, and the correction is the
 * point rather than a detail. A `flowId` names *one recording*, made at *one*
 * commit — there is no recording that exists at two SHAs, so no id can be
 * asked for its two builds. What exists at two builds is a **flow by name**:
 * somebody recorded "Checkout" on Tuesday and again on Thursday. So the tool
 * takes a name (or an id, and uses that recording's name), and the two SHAs
 * select among the recordings that carry that name.
 *
 * ## Which of the four sections is a fact and which is a shortlist
 *
 * The output has four parts and they are not the same kind of claim, so they
 * are not run together:
 *
 *   1. **The two recordings**, and every caveat `core/git` attaches to a stamp.
 *      A comparison across builds is worthless if either stamp is a build that
 *      never existed, so the caveats go at the top and not in a footnote.
 *   2. **What changed at runtime** — `compare_flows`, unaltered. Observed.
 *   3. **What shipped between the two commits** — `git log`. Observed.
 *   4. **Changed files DevFlow has observations of** — the intersection, and a
 *      *shortlist*, said in those words. `core/diagnose` sets the precedent and
 *      the reason is the same: a file that changed in the range and renders a
 *      component that now behaves differently is worth reading first, and is
 *      not thereby the cause. The mechanism cannot tell a coincidence from a
 *      culprit and does not get to imply that it can.
 *
 * Section 4 is deliberately narrower than section 3. A deploy that touched
 * forty files may produce three suspects, because the other thirty-seven are
 * files no recording has ever run through — and *that* is the fact worth
 * printing, since it is the whole of what an accumulated runtime graph knows
 * that `git log` does not.
 */

import type { CommitChange, FlowCommit } from '../git/index.js';
import { commitCaveats, describeCommit, matchSourceFile, projectRelative, shaMatches } from '../git/index.js';

/** One recording, reduced to what choosing and describing a pair needs. */
export interface DeployRecording {
  id: string;
  name: string;
  /** When the recording was made — not when its commit was written. */
  timestamp: number;
  startUrl: string | null;
  git: FlowCommit;
}

export interface DeployPair {
  older: DeployRecording;
  newer: DeployRecording;
}

export type PairChoice = { pair: DeployPair } | { problem: string };

/** A file that changed in the range and that DevFlow has seen running. */
export interface Suspect {
  /** The source file as the graph and the recordings spell it, not as git does. */
  file: string;
  commits: { short: string; subject: string }[];
  components: string[];
}

const shortOf = (recording: DeployRecording) => recording.git.short;

/**
 * Older first, by the *commit* date and not the recording date.
 *
 * Somebody who records the old build second — checking out a tag to reproduce
 * something — would otherwise have the two builds reported backwards, and every
 * sentence downstream of that is then wrong in a way that reads fine. The
 * recording time is the tie-break, for two recordings at commits written in the
 * same second.
 */
function order(a: DeployRecording, b: DeployRecording): DeployPair {
  const byCommit = a.git.committedAt - b.git.committedAt;
  const delta = byCommit !== 0 ? byCommit : a.timestamp - b.timestamp;
  return delta <= 0 ? { older: a, newer: b } : { older: b, newer: a };
}

/** The most recent recording at a commit, out of the ones offered. */
const newestAt = (candidates: DeployRecording[], sha: string): DeployRecording | null =>
  candidates
    .filter((candidate) => candidate.git.sha === sha)
    .sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;

const listShas = (candidates: DeployRecording[]): string =>
  [...new Set(candidates.map(shortOf))].join(', ');

/**
 * The two recordings to compare, or the sentence saying why there are not two.
 *
 * Every refusal names what *is* available, because the caller's next move
 * differs for each and "not found" answers none of them: a flow nobody recorded
 * twice, a flow recorded ten times at one commit, and a SHA that names no
 * recording are three different situations and only the third is a typo.
 *
 * With no SHAs given this answers "the latest two builds of this flow", which
 * is what somebody asking the question usually means and saves them looking up
 * two hashes to ask it.
 */
export function choosePair(
  candidates: DeployRecording[],
  wanted: { sha?: string | null; otherSha?: string | null } = {},
): PairChoice {
  if (!candidates.length) {
    return {
      problem:
        'No recording of this flow carries a commit. A commit is stamped by this server at the ' +
        'moment a recording arrives, so recordings made before commit stamping existed — or made ' +
        'while the server was started outside a repository — do not have one.',
    };
  }

  const distinct = new Set(candidates.map((candidate) => candidate.git.sha));
  if (distinct.size < 2 && !(wanted.sha && wanted.otherSha)) {
    return {
      problem:
        `Every recording of this flow was made at ${listShas(candidates)}. Comparing a build ` +
        'against itself has nothing to say — record the flow again after the change you want to ' +
        'see the effect of.',
    };
  }

  const resolve = (prefix: string): DeployRecording | { problem: string } => {
    const matched = candidates.filter((candidate) => shaMatches(prefix, candidate.git.sha));
    const shas = new Set(matched.map((candidate) => candidate.git.sha));
    if (shas.size > 1) {
      return { problem: `${prefix} matches more than one commit here (${listShas(matched)}). Pass more of it.` };
    }
    if (!matched.length) {
      return {
        problem: `No recording of this flow was made at ${prefix}. There are recordings at ${listShas(candidates)}.`,
      };
    }
    return newestAt(matched, matched[0].git.sha) as DeployRecording;
  };

  if (wanted.sha && wanted.otherSha) {
    const a = resolve(wanted.sha);
    if ('problem' in a) return a;
    const b = resolve(wanted.otherSha);
    if ('problem' in b) return b;
    if (a.git.sha === b.git.sha) {
      return { problem: `Both of those name ${a.git.short}, so there is one build here and not two.` };
    }
    return { pair: order(a, b) };
  }

  const anchor = wanted.sha || wanted.otherSha;
  const newest = [...candidates].sort((a, b) => b.timestamp - a.timestamp);

  if (anchor) {
    const one = resolve(anchor);
    if ('problem' in one) return one;
    const other = newest.find((candidate) => candidate.git.sha !== one.git.sha);
    if (!other) {
      return { problem: `Every recording of this flow was made at ${one.git.short}, so there is no second build to compare it to.` };
    }
    return { pair: order(one, other) };
  }

  const [latest] = newest;
  const previous = newest.find((candidate) => candidate.git.sha !== latest.git.sha);
  // Unreachable while `distinct.size >= 2` holds above; kept because that guard
  // and this search are two statements about one thing, and only one of them is
  // where a later edit would go.
  if (!previous) return { problem: `Every recording of this flow was made at ${latest.git.short}.` };
  return { pair: order(latest, previous) };
}

/**
 * The changed files DevFlow has observations of, most-observed first.
 *
 * `observed` is source file → the components the graph or the recordings put in
 * it, and its keys are the whole candidate set: a path git printed reaches this
 * list only if `matchSourceFile` can put it on a file something was seen
 * running in, exactly or by an unambiguous suffix. That refusal is what keeps
 * this a shortlist rather than a re-print of `git log --name-only`.
 */
export function suspectFiles(input: {
  range: CommitChange[];
  prefix: string;
  observed: Record<string, readonly string[]>;
}): Suspect[] {
  const known = Object.keys(input.observed);
  if (!known.length) return [];

  const byFile = new Map<string, Suspect>();

  for (const entry of input.range) {
    for (const file of entry.files) {
      const projectPath = projectRelative(input.prefix, file);
      if (!projectPath) continue;
      const node = matchSourceFile(known, projectPath);
      if (!node) continue;

      let suspect = byFile.get(node);
      if (!suspect) {
        suspect = { file: node, commits: [], components: [...(input.observed[node] ?? [])] };
        byFile.set(node, suspect);
      }
      // One commit may touch one file once, but a range holds many commits and
      // a file edited in three of them should say three.
      if (!suspect.commits.some((c) => c.short === entry.commit.sha.slice(0, 10))) {
        suspect.commits.push({ short: entry.commit.sha.slice(0, 10), subject: entry.commit.subject });
      }
    }
  }

  return [...byFile.values()].sort(
    (a, b) =>
      b.components.length - a.components.length ||
      b.commits.length - a.commits.length ||
      a.file.localeCompare(b.file),
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const when = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One recording's line at the top of the report. */
const describeRecording = (recording: DeployRecording, role: string): string =>
  `**${role}:** "${recording.name}" recorded ${when(recording.timestamp)} at ${describeCommit(recording.git)}`;

/**
 * The whole answer, assembled from four things already established.
 *
 * Pure, and the assembling is the part worth testing: which section is a fact
 * and which is a shortlist is a decision, and a decision made inside a tool
 * handler is one a test can only reach by spawning a server.
 */
export function renderDeployDiff(input: {
  pair: DeployPair;
  /** What `compare_flows` said about the two recordings. */
  runtimeDiff: string;
  /** `git log older..newer`, newest first — or null when git could not answer. */
  range: CommitChange[] | null;
  /** Why not, when `range` is null. */
  rangeProblem: string | null;
  /** How many commits run the other way, when `range` came back empty. */
  reversed: number | null;
  suspects: Suspect[];
}): string {
  const { older, newer } = input.pair;
  const lines: string[] = [
    `# "${newer.name}" across two builds`,
    '',
    describeRecording(older, 'Older'),
    describeRecording(newer, 'Newer'),
  ];

  const caveats = [
    ...commitCaveats(older.git, older.startUrl).map((sentence) => `Older: ${sentence}`),
    ...commitCaveats(newer.git, newer.startUrl).map((sentence) => `Newer: ${sentence}`),
  ];
  if (caveats.length) lines.push('', ...caveats.map((sentence) => `> ${sentence}`));

  lines.push('', '## What changed at runtime', '', input.runtimeDiff);

  lines.push('', '## What shipped between the two builds', '');
  if (input.range === null) {
    lines.push(
      input.rangeProblem ??
        'The commit range could not be read from the repository, so this is the runtime difference alone.',
    );
  } else if (!input.range.length) {
    lines.push(
      input.reversed
        ? `No commit leads from ${older.git.short} to ${newer.git.short}, but ${plural(input.reversed, 'commit')} ` +
          'lead the other way — these two builds are on branches that diverged rather than one being ahead of ' +
          'the other, so what separates them is not a single range.'
        : `Nothing was committed between ${older.git.short} and ${newer.git.short}. Whatever differs at ` +
          'runtime came from outside this repository — a backend deploy, a dependency, data, or the ' +
          'environment.',
    );
  } else {
    const files = new Set(input.range.flatMap((entry) => entry.files));
    lines.push(
      `${plural(input.range.length, 'commit')}, ${plural(files.size, 'file')} changed.`,
      '',
      ...input.range.slice(0, 20).map(
        (entry) => `- \`${entry.commit.sha.slice(0, 10)}\` ${entry.commit.subject}`,
      ),
    );
    if (input.range.length > 20) lines.push(`- …and ${input.range.length - 20} more.`);
  }

  lines.push('', '## Of those, the files DevFlow has seen running', '');
  if (!input.suspects.length) {
    lines.push(
      input.range?.length
        ? 'None. Every file in that range is one no recording has ever run through, so the graph has ' +
          'nothing to say about which of them the runtime difference came from.'
        : 'Nothing to cross — there is no commit range to cross with.',
    );
  } else {
    lines.push(
      '**A shortlist, not a cause.** These files changed in the range *and* DevFlow has watched code ' +
        'run in them. That makes them worth reading first; it does not make any of them the reason ' +
        'the two runs differ.',
      '',
    );
    for (const suspect of input.suspects.slice(0, 12)) {
      const who = suspect.components.length
        ? `observed in ${suspect.components.slice(0, 6).join(', ')}`
        : 'observed, with no component attributed to it';
      lines.push(
        `- \`${suspect.file}\` — ${who}; changed in ` +
          suspect.commits.map((c) => `\`${c.short}\` ${c.subject}`).join(', '),
      );
    }
    if (input.suspects.length > 12) lines.push(`- …and ${input.suspects.length - 12} more.`);
  }

  return lines.join('\n');
}
