/**
 * Re-running recorded flows against a change, and saying what the answer is
 * worth.
 *
 * ## What a CI run can observe, settled by measurement
 *
 * Work Stream 4.4 asks for a *semantic* diff — "not just pass/fail but what
 * changed: re-render counts, API latency, state sequence". Two of those three
 * are not available to a headless run, and that was established by running the
 * experiment rather than by reasoning about it:
 *
 *   - **Re-render counts and state sequence come from the extension**, which
 *     samples React's fibers from the MAIN world. A replay drives the page with
 *     Playwright and no extension, so nothing observes a render.
 *   - **The extension can be loaded into Playwright — but not headless.**
 *     `launchPersistentContext` with `--load-extension` registers DevFlow's MV3
 *     service worker in a *headed* Chromium and registers nothing at all in
 *     Playwright's headless one. So an extension-observed CI run needs a
 *     display (`xvfb-run` on Linux), which is a real requirement rather than a
 *     guess, and it is named as a gap in the roadmap rather than implied.
 *
 * What *is* available is the wire and the journey, and those are what this
 * compares.
 *
 * ## The mode decides what the diff can contain, and this is the whole design
 *
 * A recorded flow exports to a Playwright spec that installs `page.route`
 * handlers fulfilling each request with **the response the recording captured**.
 * That is right for "does this journey still complete" and it makes a wire diff
 * meaningless: the run's statuses and latencies are the recording's own, played
 * back. A comparison run in that mode would report perfect agreement on every
 * endpoint, forever, and be measuring its own mocks.
 *
 * So there are two modes and they are never blended:
 *
 *   - **`mocked`** — the recorded responses are served. A pass proves the
 *     journey through the interface completes. A fault living in the server is
 *     mocked out of the run by construction, and the report says so.
 *   - **`live`** — no mocks; the run talks to whatever the PR actually built.
 *     Now status codes and latencies are real and worth comparing, and a
 *     backend regression is visible.
 *
 * Every report names its mode on the first line. `core/replay`'s rule that
 * `no-tests` and `unreadable` are not degraded `passed` is extended here to the
 * run as a whole: a report resolves *away* from clean, never toward it.
 */

import type { ReplayVerdict } from '../replay/index.js';
import { matchSourceFile, normaliseSourcePath, projectRelative } from '../git/index.js';

export type RunMode = 'mocked' | 'live';

/** One request, as either the recording or the run saw it. */
export interface ObservedCall {
  method: string;
  url: string;
  status: number;
  durationMs: number;
}

/** One recorded flow, re-run. */
export interface FlowRun {
  flowId: string;
  flowName: string;
  verdict: ReplayVerdict;
  /** What the run's browser actually saw on the wire. Empty in `mocked` mode. */
  calls: readonly ObservedCall[];
  /** What the recording saw, for the same endpoints. */
  recorded: readonly ObservedCall[];
}

export type WireChangeKind = 'status' | 'slower' | 'faster' | 'only-now' | 'only-then';

export interface WireChange {
  kind: WireChangeKind;
  method: string;
  url: string;
  detail: string;
}

/**
 * How much slower an endpoint has to be before it is worth a line.
 *
 * Both bars, not either: a 40ms endpoint that becomes 60ms is 50% worse and
 * nobody cares, and an 8-second endpoint that becomes 8.4 is 400ms worse and
 * nobody cares either. Requiring both keeps the report to changes a person
 * would act on, and the numbers are printed with the finding so a reader can
 * see what bar it cleared.
 */
const LATENCY_FLOOR_MS = 100;
const LATENCY_FRACTION = 0.3;

/** An endpoint's identity for comparison: the method and the path, not the query. */
export function endpointKey(call: Pick<ObservedCall, 'method' | 'url'>): string {
  let path = call.url;
  try {
    path = new URL(call.url).pathname;
  } catch {
    // A relative or malformed URL compares as itself, which is still stable
    // across two runs of one recording and is what a key has to be.
    path = call.url.split('?')[0] ?? call.url;
  }
  return `${call.method.toUpperCase()} ${path}`;
}

/**
 * What the wire did differently, or an empty list with a reason.
 *
 * In `mocked` mode this returns nothing at all and it is not a bug: the run's
 * responses *are* the recording's, so any comparison would be the recording
 * against itself. The caller prints the reason rather than an empty section
 * that reads as agreement.
 */
export function compareWire(run: FlowRun, mode: RunMode): WireChange[] {
  if (mode === 'mocked') return [];
  /*
   * A live run that observed nothing is not a run in which nothing was called.
   * Comparing an empty set against the recording would mark every endpoint
   * `only-then` and read as a total outage — the most confident possible way
   * to be wrong about a passing branch. No observation, no comparison; the
   * report says the wire was not observed.
   */
  if (!run.calls.length) return [];

  const changes: WireChange[] = [];
  const then = new Map(run.recorded.map((call) => [endpointKey(call), call]));
  const now = new Map(run.calls.map((call) => [endpointKey(call), call]));

  for (const [key, current] of now) {
    const before = then.get(key);
    const [method, url] = key.split(' ');
    if (!before) {
      changes.push({
        kind: 'only-now',
        method,
        url,
        detail: `called during the run and not during the recording — answered ${current.status}`,
      });
      continue;
    }

    if (before.status !== current.status) {
      changes.push({
        kind: 'status',
        method,
        url,
        detail: `answered ${current.status}, and answered ${before.status} when this flow was recorded`,
      });
    }

    const delta = current.durationMs - before.durationMs;
    const overFloor = Math.abs(delta) >= LATENCY_FLOOR_MS;
    const overFraction = before.durationMs > 0 && Math.abs(delta) / before.durationMs >= LATENCY_FRACTION;
    if (overFloor && overFraction) {
      changes.push({
        kind: delta > 0 ? 'slower' : 'faster',
        method,
        url,
        detail:
          `${Math.round(before.durationMs)}ms → ${Math.round(current.durationMs)}ms ` +
          `(${delta > 0 ? '+' : ''}${Math.round(delta)}ms, ` +
          `${delta > 0 ? '+' : ''}${Math.round((delta / before.durationMs) * 100)}%)`,
      });
    }
  }

  for (const [key, before] of then) {
    if (now.has(key)) continue;
    const [method, url] = key.split(' ');
    changes.push({
      kind: 'only-then',
      method,
      url,
      detail: `the recording called this and the run did not — it answered ${before.status} then`,
    });
  }

  return changes;
}

/**
 * Which of a change's files the runtime graph has ever watched code run in.
 *
 * The same join `core/deploy`'s `suspectFiles` makes, and it carries the same
 * two claims. The shortlist is *narrower* than the diff on purpose: a PR
 * touching forty files may implicate three, and the other thirty-seven are
 * files no recording has ever run through. That gap is exactly what an
 * accumulated runtime graph knows and `git diff --name-only` does not, so the
 * number of unseen files is returned rather than dropped.
 *
 * And it is a shortlist, not a cause. A changed file the runtime has run
 * through is a file worth reading first when a flow regresses; nothing here
 * says it is the reason.
 */
export function implicatedFiles(input: {
  /** Repository-relative paths, as `git diff --name-only` prints them. */
  changed: readonly string[];
  /** Where the project sits inside the repository — see `core/git`. */
  prefix: string;
  /** Every source file the graph has observed. */
  observed: readonly string[];
}): { implicated: string[]; unseen: number } {
  const implicated: string[] = [];
  let unseen = 0;

  for (const file of input.changed) {
    const relative = projectRelative(input.prefix, file);
    const node = relative === null ? null : matchSourceFile(input.observed, relative);
    if (node) {
      if (!implicated.includes(node)) implicated.push(node);
    } else {
      unseen += 1;
    }
  }

  implicated.sort();
  return { implicated, unseen };
}

/**
 * The run's verdict, resolving away from clean.
 *
 * `core/replay`'s rule about a single report — that everything unrecognised
 * resolves away from `passed`, never toward it — applied to a set of them. A
 * run where one flow could not be read is not a passing run with a footnote;
 * the whole point of a regression gate is that it says no when it does not
 * know.
 */
export type RunVerdict = 'clean' | 'regressed' | 'inconclusive';

export function runVerdict(runs: readonly FlowRun[]): RunVerdict {
  if (!runs.length) return 'inconclusive';
  if (runs.some((run) => run.verdict.status === 'unreadable' || run.verdict.status === 'no-tests')) {
    return 'inconclusive';
  }
  if (runs.some((run) => run.verdict.status === 'failed')) return 'regressed';
  return 'clean';
}

/**
 * The report, as a PR comment or a terminal reads it.
 *
 * The mode is on the first line because every other line means something
 * different under each one, and the paragraph about what a pass proves is
 * printed unconditionally for `renderForensics`'s reason: a caveat that appears
 * only when a tool is unsure is one a reader learns to skip.
 */
export function renderRegressionReport(input: {
  mode: RunMode;
  runs: readonly FlowRun[];
  changedFiles: number;
  implicated: readonly string[];
  unseen: number;
  /** True when the extension was not loaded, which is always today — see the header. */
  observedRenders: boolean;
}): string {
  const { mode, runs, implicated, unseen } = input;
  const verdict = runVerdict(runs);

  const lines: string[] = [
    `DevFlow regression check — ${verdict} (${mode} mode, ${runs.length} flow${runs.length === 1 ? '' : 's'})`,
    '',
  ];

  if (!runs.length) {
    lines.push(
      'No recorded flows were found to run. A flow has to be committed to the repository for CI to ' +
        'replay it; a recording that lives only in the extension is not reachable from here.',
    );
    return lines.join('\n');
  }

  for (const run of runs) {
    const changes = compareWire(run, mode);
    lines.push(`${run.flowName}  ${run.verdict.status}  ${run.verdict.ran} test${run.verdict.ran === 1 ? '' : 's'} ran`);

    for (const failure of run.verdict.failures) {
      lines.push(`  failed  ${failure.title}${failure.step ? ` (step ${failure.step})` : ''}: ${failure.message}`);
    }
    if (run.verdict.note) lines.push(`  note  ${run.verdict.note}`);

    for (const change of changes) {
      lines.push(`  ${change.kind.padEnd(10)}${change.method} ${change.url}  ${change.detail}`);
    }
    if (mode === 'live' && !run.calls.length) {
      lines.push(
        '  the wire was not observed for this flow, so nothing about statuses or latencies is ' +
          'compared — an unobserved run is not a run in which nothing was called',
      );
    } else if (mode === 'live' && !changes.length && run.verdict.status === 'passed') {
      lines.push('  the wire did the same thing it did when this flow was recorded');
    }
    lines.push('');
  }

  if (implicated.length || unseen) {
    lines.push(
      `Of ${input.changedFiles} changed file${input.changedFiles === 1 ? '' : 's'}, ${implicated.length} ` +
        `${implicated.length === 1 ? 'is a file' : 'are files'} DevFlow has watched code run in:`,
    );
    for (const file of implicated) lines.push(`  ${file}`);
    if (unseen) {
      lines.push(
        `  ${unseen} changed file${unseen === 1 ? ' was' : 's were'} not implicated — no recording has ` +
          'ever run through them, which is what this knows and `git diff --name-only` does not. It is a ' +
          'shortlist to read first, not a cause.',
      );
    }
    lines.push('');
  }

  lines.push(
    mode === 'mocked'
      ? 'What a pass proves, in mocked mode: the journey through the interface completes. Each request ' +
          'was answered with the response the recording captured, so a fault living in the server is ' +
          'mocked out of this run by construction and no latency or status here is the application’s. ' +
          'Run in live mode to compare the wire.'
      : 'What a pass proves, in live mode: the journey completes against what this branch actually ' +
          'built, and the statuses and latencies above are real. It does not prove the pages looked ' +
          'right — nothing here compares pixels.',
  );

  if (!input.observedRenders) {
    lines.push(
      'Re-render counts and state changes are not compared. Those are observed by the DevFlow extension ' +
        'from React’s fibers, and a headless run has no extension: the MV3 service worker registers in a ' +
        'headed Chromium and does not register in Playwright’s headless one. An observed run therefore ' +
        'needs a display (xvfb on Linux) and is not what this check does.',
    );
  }

  return lines.join('\n');
}

/** Every source file a set of paths normalises to, for a stable comparison. */
export const normalisedFiles = (files: readonly string[]): string[] =>
  files.map((file) => normaliseSourcePath(file));
