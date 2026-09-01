/**
 * Where a replay writes its spec, and what a runner's output actually means.
 *
 * ## Reading a report is the dangerous half, and "passed" is the dangerous word
 *
 * A replay exists to answer one question — *does the recorded journey still
 * work?* — and the answer is read by a repair loop that will keep patching until
 * it hears yes. So the failure that matters here is not a test that fails. It is
 * any output this module could mistake for success:
 *
 *   - the runner **crashed before running anything** and printed a stack trace
 *     where the JSON should have been;
 *   - the runner ran and **matched zero test files**, so nothing was checked;
 *   - the report **is JSON but not this shape**, and the walk finds nothing in
 *     it.
 *
 * All three produce an empty list of failures, and a harness that turns "no
 * failures" into `passed` reports every one of them as a green replay. That is
 * this module's worst possible bug: it tells a loop that a patch worked when
 * nothing ever ran. So the states are named separately — `no-tests` and
 * `unreadable` are not degraded `passed`, they are different answers — and
 * `passed` is reachable only from a report that parsed, walked, and contains at
 * least one test that actually ran and finished green. Everything unrecognised
 * resolves *away* from `passed`, never toward it: a result whose `status` is
 * missing or a word this does not know counts as a failure, because a runner
 * that stopped describing itself is not evidence of success.
 *
 * The `note` is the other half of that promise. `unreadable` with no note is a
 * dead end for whoever reads it, so the crash text itself — first ~120
 * characters, ANSI stripped, whitespace collapsed — is carried into the verdict.
 * The stack trace is usually the entire diagnosis.
 *
 * ## The report is a file on disk, so every field is guarded
 *
 * Nothing here trusts the shape. `suites` nest arbitrarily deep and a real one
 * is nested at least twice, so the walk recurses; every array, object and string
 * is checked before it is read, and the recursion has a depth cap so a
 * pathological file cannot take the stack out. JSON cannot contain a cycle, so
 * the cap is about depth alone.
 *
 * Two smaller decisions a reader should not have to reverse-engineer:
 *
 *   - **The last result wins.** Playwright appends a result per retry. A test
 *     that failed then passed on retry is reported as passed, which is what the
 *     runner itself concludes — but it means "flaky" reaches the caller as a
 *     pass, and the flakiness is not in this verdict.
 *   - **`stats` is a cross-check, not the answer.** The counts are computed by
 *     walking the suites, because that is where the titles and messages are. If
 *     the walk finds no test that ran while `stats` insists several did, the two
 *     halves of the report disagree and this is not the shape being read — that
 *     is `unreadable`, not `no-tests`.
 *
 * ## `step` is parsed, never guessed
 *
 * The compiler writes `// Step 3: Clicked "Save"` above each action and
 * Playwright quotes the surrounding source in its error snippet, so the step
 * number is usually somewhere in the error text — on a later line than the
 * message itself, which is why the whole error is searched and only the first
 * line becomes `message`. When no `Step <n>` appears, the field is absent. A
 * guessed step number sends a repair loop at the wrong interaction with full
 * confidence, which is worse than sending it at none.
 *
 * ## The flow id is sanitised, not trusted
 *
 * It arrives over loopback from any page the browser visited and is about to
 * become a filename. `../../etc/passwd` must not produce a path that climbs, so
 * `.` and `/` are not on the keep list at all rather than being special-cased.
 *
 * The executable is deliberately not named here: whether to spawn
 * `node_modules/.bin/playwright` is a filesystem question, and `npx playwright`
 * on a machine without Playwright installs it — a network write because a model
 * asked a question. The caller resolves the binary; this decides the arguments.
 *
 * Pure — no fs, no spawn, no clock, no randomness.
 */

/** The spec a replay writes, and the arguments that run it. */
export interface ReplayPlan {
  /** Where the spec goes, relative to the project root, POSIX separators. */
  specPath: string;
  /** Arguments to the runner. The executable is the caller's to resolve. */
  args: string[];
}

/** Where replays live, relative to the project root. */
const REPLAY_DIR = '.devflow/replays';

/** Long enough for a readable id, short enough for every filesystem. */
const MAX_ID_LENGTH = 64;

/** What a flow id with nothing filename-safe in it becomes. */
const FALLBACK_ID = 'replay';

/**
 * A flow id reduced to the characters a filename may safely hold.
 *
 * Allow-list rather than deny-list: a deny-list has to enumerate every way to
 * climb a directory, and it only takes missing one.
 */
function safeId(flowId: string): string {
  const trimmed = String(flowId ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_ID_LENGTH)
    // Again after the cap: slicing can leave the separator it was replacing.
    .replace(/-+$/, '');

  return trimmed || FALLBACK_ID;
}

/**
 * Where a replay writes its spec and what it runs.
 *
 * `flowId` is used in a filename, so it is sanitised here rather than trusted:
 * a flow id arrives over loopback from any page the browser visited.
 */
export function planReplay(flowId: string): ReplayPlan {
  const specPath = `${REPLAY_DIR}/${safeId(flowId)}.spec.ts`;
  return { specPath, args: ['test', specPath, '--reporter=json'] };
}

export type ReplayStatus = 'passed' | 'failed' | 'no-tests' | 'unreadable';

/** One replayed journey that did not do what the recording did. */
export interface ReplayFailure {
  /** The test's title, as the runner reported it. */
  title: string;
  /** The first line of the failure message, trimmed and capped. */
  message: string;
  /** The step number the message names, when it names one. */
  step?: number;
}

export interface ReplayVerdict {
  status: ReplayStatus;
  failures: ReplayFailure[];
  /** Tests the runner actually ran. Zero is what `no-tests` means. */
  ran: number;
  /** Why the report could not be read, or what is unusual about it. */
  note?: string;
}

/** Beyond this, a list of failures stops informing anyone. */
const MAX_FAILURES = 20;

/** One failure message, capped so a verdict stays readable. */
const MAX_MESSAGE = 200;

/** Enough of a crash to diagnose it, not so much that it buries the verdict. */
const MAX_NOTE_EXCERPT = 120;

/** A real report nests two or three deep; anything past this is not one. */
const MAX_SUITE_DEPTH = 50;

const UNTITLED = '(untitled test)';

// Control characters are the point: this is what a terminal's colour codes are.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A count from a report, which may be anything at all. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** What the runner printed, shortened enough to sit inside a note. */
function excerpt(raw: string): string {
  const text = cap(collapse(stripAnsi(raw)), MAX_NOTE_EXCERPT);
  return text || '(nothing at all)';
}

/** What a non-report JSON value is, in a word a reader can act on. */
function describeKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function unreadable(note: string): ReplayVerdict {
  return { status: 'unreadable', failures: [], ran: 0, note };
}

/** One test the runner finished, reduced to what a verdict needs. */
interface RanTest {
  title: string;
  failed: boolean;
  /** The whole error text, ANSI intact — trimmed to a message by the caller. */
  error: string;
}

interface Walk {
  ran: RanTest[];
  /** Tests present in the report that never produced a non-skipped result. */
  skipped: number;
}

/** The error text a result carries, wherever the reporter happened to put it. */
function errorOf(result: Record<string, unknown>): string {
  if (isRecord(result.error)) {
    const message = stringOf(result.error.message);
    if (message) return message;
    const stack = stringOf(result.error.stack);
    if (stack) return stack;
  }
  for (const entry of arrayOf(result.errors)) {
    if (!isRecord(entry)) continue;
    const message = stringOf(entry.message);
    if (message) return message;
  }
  return '';
}

/**
 * Every test in one suite and its children, folded into `walk`.
 *
 * A result whose status is absent or unrecognised is counted as a failure. The
 * alternative — treating what it cannot read as a pass — is exactly the bug this
 * module exists to not have.
 */
function walkSuite(suite: unknown, walk: Walk, depth: number): void {
  if (!isRecord(suite) || depth > MAX_SUITE_DEPTH) return;

  for (const spec of arrayOf(suite.specs)) {
    if (!isRecord(spec)) continue;
    const title = collapse(stripAnsi(stringOf(spec.title))) || UNTITLED;

    for (const test of arrayOf(spec.tests)) {
      if (!isRecord(test)) continue;

      const results = arrayOf(test.results)
        .filter(isRecord)
        .filter((result) => stringOf(result.status) !== 'skipped');

      const last = results[results.length - 1];
      if (!last) {
        walk.skipped += 1;
        continue;
      }

      walk.ran.push({
        title,
        failed: stringOf(last.status) !== 'passed',
        error: errorOf(last),
      });
    }
  }

  for (const child of arrayOf(suite.suites)) walkSuite(child, walk, depth + 1);
}

/** The step number an error names, or nothing. Never inferred from position. */
function stepOf(error: string): number | undefined {
  const found = /\bStep (\d+)\b/.exec(error);
  if (!found) return undefined;
  const step = Number(found[1]);
  return Number.isSafeInteger(step) ? step : undefined;
}

function failureOf(test: RanTest): ReplayFailure {
  const error = stripAnsi(test.error);
  const firstLine = collapse(error.split(/\r?\n/)[0] ?? '');
  const step = stepOf(error);

  return {
    title: test.title,
    message: cap(firstLine, MAX_MESSAGE) || '(the runner reported no message)',
    ...(step === undefined ? {} : { step }),
  };
}

/** A Playwright `--reporter=json` report, read into a verdict. */
export function readReport(raw: string): ReplayVerdict {
  const text = typeof raw === 'string' ? raw : '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unreadable(`The runner did not print JSON. It printed: ${excerpt(text)}`);
  }

  if (!isRecord(parsed)) {
    return unreadable(
      `The runner printed JSON, but ${describeKind(parsed)} rather than a report: ${excerpt(text)}`,
    );
  }

  const walk: Walk = { ran: [], skipped: 0 };
  for (const suite of arrayOf(parsed.suites)) walkSuite(suite, walk, 0);

  const ran = walk.ran.length;

  if (ran === 0) {
    // The two halves of the report disagree: the counts say tests ran and the
    // suites hold none of them. Calling that `no-tests` would report a report
    // this cannot read as a run that checked nothing, and both of those are
    // things a caller acts on differently.
    const stats = isRecord(parsed.stats) ? parsed.stats : {};
    const claimed = countOf(stats.expected) + countOf(stats.unexpected) + countOf(stats.flaky);
    if (claimed > 0) {
      return unreadable(
        `The report's stats say ${claimed} test${claimed === 1 ? '' : 's'} ran, ` +
          `but its suites contain none — this is not the shape being read.`,
      );
    }

    return {
      status: 'no-tests',
      failures: [],
      ran: 0,
      ...(walk.skipped > 0
        ? {
            note:
              `The runner matched ${walk.skipped} test${walk.skipped === 1 ? '' : 's'} ` +
              `and skipped every one of them, so nothing was replayed.`,
          }
        : { note: 'The runner matched no test files, so nothing was replayed.' }),
    };
  }

  const failed = walk.ran.filter((test) => test.failed);
  if (failed.length === 0) return { status: 'passed', failures: [], ran };

  const failures = failed.slice(0, MAX_FAILURES).map(failureOf);
  const over = failed.length - failures.length;

  return {
    status: 'failed',
    failures,
    ran,
    ...(over > 0
      ? { note: `${over} further failing test${over === 1 ? ' is' : 's are'} not listed.` }
      : {}),
  };
}

/** One finished run, as the process left it. */
export interface ReplayRun {
  stdout: string;
  stderr: string;
  /** The run was killed for taking too long, so nothing it printed is complete. */
  timedOut?: boolean;
}

/**
 * A whole run read into a verdict — which stream, and in which order.
 *
 * Its own function rather than a line at the call site, because it is a
 * *decision* and the call site is `mcp-server/server.js`, where nothing can
 * reach it without a Playwright installation and a real spawn. Here it is three
 * inputs and an answer.
 *
 * stdout first, stderr only as a fallback. A runner that crashed before it
 * loaded anything prints its stack trace on **stderr** and leaves stdout empty,
 * so reading stdout alone gives `unreadable` with a note saying nothing was
 * printed — correct, and useless to whoever has to fix it. Concatenating the two
 * unconditionally is the wrong fix in the other direction: a runner that writes
 * a deprecation warning to stderr and a valid report to stdout would then parse
 * as neither, and a passing replay would come back unreadable.
 *
 * A timed-out run is `unreadable` whatever it printed, and that is the whole
 * point of handling it here: a runner killed mid-suite may well have printed a
 * report of the tests that had passed so far, and reading it would answer
 * "passed" about a journey that never finished.
 */
export function readRun(run: ReplayRun): ReplayVerdict {
  if (run.timedOut) {
    return {
      status: 'unreadable',
      failures: [],
      ran: 0,
      note: 'the runner was still going when the timeout struck and was killed, so whatever it had printed describes an unfinished run',
    };
  }

  const fromStdout = readReport(run.stdout ?? '');
  if (fromStdout.status !== 'unreadable') return fromStdout;

  const stderr = String(run.stderr ?? '').trim();
  return stderr ? readReport(`${run.stdout ?? ''}\n${stderr}`) : fromStdout;
}
