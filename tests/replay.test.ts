/**
 * What a replay's verdict claims, and the ways that claim goes wrong quietly.
 *
 * **Every non-answer must stay a non-answer.** A crashed runner, a run that
 * matched no files, and a report of some other shape all produce zero failures,
 * and the one-line change that folds them into `passed` breaks nothing visible:
 * the verdict still has a plausible status, an empty `failures` and a `ran` of
 * zero. What it breaks is the caller — a repair loop reads `passed` and concludes
 * its patch worked when nothing was ever executed. So the tests below assert the
 * status *by name* rather than asserting "no failures", and the crash cases
 * assert `not.toBe('passed')` on top of that.
 *
 * **The note is the only diagnosis that survives.** `unreadable` without the
 * runner's own words leaves whoever reads it with nowhere to go, so the crash
 * text is asserted to reach the note. Dropping it looks like tidying.
 *
 * **The sanitiser is a security control wearing a filename's clothes.** A flow
 * id arrives over loopback from any page the browser visited and becomes a path.
 * Letting `.` through still produces a sensible-looking `.devflow/replays/…`
 * path for every ordinary id, and a traversal for one crafted id, so the
 * traversal case is tested directly rather than trusted to the happy path.
 *
 * **A step number is worse wrong than missing.** `step` sends a reader at one
 * interaction; a guessed one sends them at the wrong interaction with the same
 * confidence, so both halves — parsed when named, absent when not — are asserted.
 */

import { describe, expect, it } from 'vitest';
import { planReplay, readReport,
  readRun } from '../src/core/replay/index.js';

/** The escape byte, spelled rather than embedded, so this file stays readable. */
const ESC = '\u001B';

const SPEC_FILE = '.devflow/replays/flow-1.spec.ts';

function passedResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workerIndex: 0,
    parallelIndex: 0,
    status: 'passed',
    duration: 812,
    errors: [],
    stdout: [],
    stderr: [],
    retry: 0,
    startTime: '2026-09-01T10:00:01.000Z',
    attachments: [],
    ...over,
  };
}

function failedResult(message: string): Record<string, unknown> {
  return passedResult({
    status: 'failed',
    error: { message, stack: `Error: ${message.split('\n')[0]}\n    at spec:5:7` },
    errors: [{ message }],
  });
}

function spec(title: string, results: unknown[]): Record<string, unknown> {
  return {
    title,
    ok: results.every((result) => (result as { status?: string }).status === 'passed'),
    tags: [],
    id: `id-${title}`,
    file: SPEC_FILE,
    line: 3,
    column: 1,
    tests: [
      {
        timeout: 30000,
        annotations: [],
        expectedStatus: 'passed',
        projectName: 'chromium',
        results,
        status: 'expected',
      },
    ],
  };
}

function fileSuite(specs: unknown[], suites: unknown[] = []): Record<string, unknown> {
  return { title: SPEC_FILE, file: SPEC_FILE, line: 0, column: 0, specs, suites };
}

function report(suites: unknown[], stats: Record<string, unknown> = {}): string {
  return JSON.stringify({
    config: { rootDir: '/repo', version: '1.47.0' },
    suites,
    errors: [],
    stats: {
      startTime: '2026-09-01T10:00:00.000Z',
      duration: 1200,
      expected: 0,
      unexpected: 0,
      flaky: 0,
      skipped: 0,
      ...stats,
    },
  });
}

/** A Playwright failure as it actually arrives: coloured, and quoting source. */
const REAL_FAILURE = [
  `${ESC}[31mError: ${ESC}[39mexpect(locator).toBeVisible() failed`,
  '',
  `Locator: ${ESC}[2mgetByRole('button', { name: 'Save' })${ESC}[22m`,
  'Expected: visible',
  'Timeout: 5000ms',
  '',
  '  3 |',
  '  4 |   // Step 3: Clicked "Save"',
  `> 5 |   await page.getByRole('button', { name: 'Save' }).click();`,
  '    |                                                   ^',
].join('\n');

describe('planning where a replay writes its spec', () => {
  it('writes under .devflow/replays and runs the spec it just named', () => {
    expect(planReplay('flow-1a2b')).toEqual({
      specPath: '.devflow/replays/flow-1a2b.spec.ts',
      args: ['test', '.devflow/replays/flow-1a2b.spec.ts', '--reporter=json'],
    });
  });

  it('names no executable — resolving the runner is the caller\'s job', () => {
    const plan = planReplay('flow-1');
    // `npx playwright` on a machine without Playwright installs it. Nothing
    // here may nominate a binary, and `npx` least of all.
    expect(JSON.stringify(plan)).not.toContain('npx');
    expect(plan.args[0]).toBe('test');
  });

  it('does not let a flow id climb out of the replay directory', () => {
    const { specPath } = planReplay('../../etc/passwd');
    expect(specPath).toBe('.devflow/replays/etc-passwd.spec.ts');
    expect(specPath).not.toContain('..');
    expect(specPath).not.toContain('/etc/');
  });

  it('keeps every id to one path segment under the replay directory', () => {
    for (const hostile of ['../../etc/passwd', 'a/b/c', './../x', '\\..\\..\\win', '/abs/path']) {
      const { specPath } = planReplay(hostile);
      const rest = specPath.slice('.devflow/replays/'.length, -'.spec.ts'.length);
      expect(specPath.startsWith('.devflow/replays/')).toBe(true);
      expect(rest).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('falls back to a name when nothing in the id survives', () => {
    expect(planReplay('').specPath).toBe('.devflow/replays/replay.spec.ts');
    expect(planReplay('///').specPath).toBe('.devflow/replays/replay.spec.ts');
    expect(planReplay('   ').specPath).toBe('.devflow/replays/replay.spec.ts');
  });

  it('replaces a space and a quote rather than dropping them', () => {
    expect(planReplay('flow "one" two').specPath).toBe('.devflow/replays/flow-one-two.spec.ts');
  });

  it('collapses runs of replaced characters instead of stuttering', () => {
    expect(planReplay('a///b...c').specPath).toBe('.devflow/replays/a-b-c.spec.ts');
  });

  it('caps a long id at 64 characters', () => {
    const { specPath } = planReplay('x'.repeat(200));
    expect(specPath).toBe(`.devflow/replays/${'x'.repeat(64)}.spec.ts`);
  });

  it('leaves no trailing separator when the cap lands on one', () => {
    // 63 keepable characters, then a run that the cap would cut mid-separator.
    const { specPath } = planReplay(`${'a'.repeat(63)}   b`);
    expect(specPath).toBe(`.devflow/replays/${'a'.repeat(63)}.spec.ts`);
  });
});

describe('a report the runner never printed', () => {
  it('reads a crash as unreadable, never as passed, and keeps the crash text', () => {
    const crash = [
      'node:internal/modules/cjs/loader:1143',
      '  throw err;',
      '  ^',
      "Error: Cannot find module '@playwright/test'",
      '    at Module._resolveFilename (node:internal/modules/cjs/loader:1140:15)',
    ].join('\n');

    const verdict = readReport(crash);

    expect(verdict.status).toBe('unreadable');
    expect(verdict.status).not.toBe('passed');
    expect(verdict.ran).toBe(0);
    expect(verdict.failures).toEqual([]);
    expect(verdict.note).toContain('Cannot find module');
  });

  it('collapses the crash text and caps it so it cannot bury the verdict', () => {
    const verdict = readReport(`${ESC}[31mboom\n\n   at   somewhere\n${'y'.repeat(400)}`);

    expect(verdict.note).toContain('boom at somewhere');
    expect(verdict.note).not.toContain(ESC);
    expect(verdict.note?.length).toBeLessThan(200);
  });

  it('reads empty output as unreadable', () => {
    const verdict = readReport('');
    expect(verdict.status).toBe('unreadable');
    expect(verdict.status).not.toBe('passed');
  });

  it('reads JSON that is an array as unreadable, saying what it was', () => {
    const verdict = readReport('[{"suites":[]}]');
    expect(verdict.status).toBe('unreadable');
    expect(verdict.note).toContain('an array');
  });

  it('reads JSON that is a string as unreadable', () => {
    const verdict = readReport('"all good"');
    expect(verdict.status).toBe('unreadable');
    expect(verdict.status).not.toBe('passed');
    expect(verdict.note).toContain('a string');
  });

  it('reads JSON null as unreadable rather than as an empty report', () => {
    const verdict = readReport('null');
    expect(verdict.status).toBe('unreadable');
    expect(verdict.note).toContain('null');
  });

  it('refuses a report whose stats and suites disagree', () => {
    // Counts say three tests ran; the suites hold none of them. Calling that
    // `no-tests` would report a shape this cannot read as a run that checked
    // nothing, and a caller acts on those two differently.
    const verdict = readReport(report([], { expected: 3 }));

    expect(verdict.status).toBe('unreadable');
    expect(verdict.ran).toBe(0);
    expect(verdict.note).toContain('3 tests');
  });
});

describe('a report of a run that checked nothing', () => {
  it('reads an empty run as no-tests, not as passed', () => {
    const verdict = readReport(report([]));

    expect(verdict.status).toBe('no-tests');
    expect(verdict.status).not.toBe('passed');
    expect(verdict.ran).toBe(0);
    expect(verdict.failures).toEqual([]);
    expect(verdict.note).toContain('no test files');
  });

  it('reads an all-skipped run as no-tests and says how many were skipped', () => {
    // "matched nothing" and "matched two and ran neither" are different things
    // to have to fix, so the count is part of the note rather than the word
    // alone.
    const skipped = passedResult({ status: 'skipped', duration: 0 });
    const raw = report(
      [fileSuite([spec('one', [skipped]), spec('two', [skipped])])],
      { skipped: 2 },
    );
    const verdict = readReport(raw);

    expect(verdict.status).toBe('no-tests');
    expect(verdict.ran).toBe(0);
    expect(verdict.note).toContain('2 tests');
    expect(verdict.note).toContain('skipped');
    expect(verdict.note).not.toContain('no test files');
  });

  it('reads a test with no results at all as not having run', () => {
    const verdict = readReport(report([fileSuite([spec('DevFlow recorded flow', [])])]));
    expect(verdict.status).toBe('no-tests');
    expect(verdict.ran).toBe(0);
  });

  it('survives a report whose fields are the wrong types entirely', () => {
    const verdict = readReport(
      JSON.stringify({ suites: [{ specs: 'nope', suites: 7 }, null, 'x'], stats: 'gone' }),
    );
    expect(verdict.status).toBe('no-tests');
    expect(verdict.ran).toBe(0);
  });
});

describe('a report of a run that passed', () => {
  it('reads a green run as passed, with the count of what ran', () => {
    const raw = report(
      [
        fileSuite([
          spec('DevFlow recorded flow', [passedResult()]),
          spec('DevFlow recorded flow — checkout', [passedResult()]),
        ]),
      ],
      { expected: 2 },
    );
    const verdict = readReport(raw);

    expect(verdict).toEqual({ status: 'passed', failures: [], ran: 2 });
  });

  it('takes the last result, so a retry that went green is a pass', () => {
    const raw = report([
      fileSuite([spec('DevFlow recorded flow', [failedResult('flaked'), passedResult({ retry: 1 })])]),
    ]);

    expect(readReport(raw).status).toBe('passed');
  });
});

describe('a report of a run that failed', () => {
  it('reads a red run as failed, one entry per failing test', () => {
    const raw = report(
      [
        fileSuite([
          spec('DevFlow recorded flow', [failedResult(REAL_FAILURE)]),
          spec('DevFlow recorded flow — checkout', [passedResult()]),
        ]),
      ],
      { expected: 1, unexpected: 1 },
    );
    const verdict = readReport(raw);

    expect(verdict.status).toBe('failed');
    expect(verdict.ran).toBe(2);
    expect(verdict.failures).toEqual([
      {
        title: 'DevFlow recorded flow',
        message: 'Error: expect(locator).toBeVisible() failed',
        step: 3,
      },
    ]);
  });

  it('strips the runner\'s colour codes out of the message', () => {
    const raw = report([
      fileSuite([spec('t', [failedResult(`${ESC}[31mError: nope${ESC}[39m\nsecond line`)])]),
    ]);

    expect(readReport(raw).failures[0].message).toBe('Error: nope');
    expect(readReport(raw).failures[0].message).not.toContain(ESC);
  });

  it('keeps only the first line of the message', () => {
    const raw = report([fileSuite([spec('t', [failedResult('first\nsecond\nthird')])])]);
    expect(readReport(raw).failures[0].message).toBe('first');
  });

  it('caps a runaway message', () => {
    const raw = report([fileSuite([spec('t', [failedResult('E: '.concat('z'.repeat(500)))])])]);
    const { message } = readReport(raw).failures[0];

    expect(message.length).toBe(200);
    expect(message.startsWith('E: zzz')).toBe(true);
  });

  it('omits the step when the message names none, rather than guessing one', () => {
    const raw = report([
      fileSuite([spec('t', [failedResult('Error: net::ERR_CONNECTION_REFUSED\n  at line 4')])]),
    ]);
    const failure = readReport(raw).failures[0];

    expect(failure.step).toBeUndefined();
    expect('step' in failure).toBe(false);
  });

  it('finds the step in the quoted source, below the message line', () => {
    const raw = report([
      fileSuite([
        spec('t', [failedResult('Error: strict mode violation\n\n  7 |   // Step 12: Filled "Email"\n> 8 |   await page.fill();')]),
      ]),
    ]);

    expect(readReport(raw).failures[0].step).toBe(12);
  });

  it('reads a timeout, and an unknown status, as failures rather than passes', () => {
    const raw = report([
      fileSuite([
        spec('timed out', [failedResult('Test timeout of 30000ms exceeded.')]),
        spec('who knows', [passedResult({ status: 'interrupted' })]),
        spec('no status at all', [passedResult({ status: undefined })]),
      ]),
    ]);
    const verdict = readReport(raw);

    expect(verdict.status).toBe('failed');
    expect(verdict.failures.map((failure) => failure.title)).toEqual([
      'timed out',
      'who knows',
      'no status at all',
    ]);
  });

  it('says so when a failing test carried no message', () => {
    const raw = report([fileSuite([spec('t', [passedResult({ status: 'failed' })])])]);
    expect(readReport(raw).failures[0].message).toContain('no message');
  });

  it('finds tests nested inside describe blocks', () => {
    const raw = report([
      fileSuite(
        [],
        [
          {
            title: 'checkout',
            specs: [spec('outer', [passedResult()])],
            suites: [
              {
                title: 'with a coupon',
                specs: [spec('inner', [failedResult('Error: deep\n // Step 4: Clicked')])],
                suites: [],
              },
            ],
          },
        ],
      ),
    ]);
    const verdict = readReport(raw);

    expect(verdict.status).toBe('failed');
    expect(verdict.ran).toBe(2);
    expect(verdict.failures).toEqual([
      { title: 'inner', message: 'Error: deep', step: 4 },
    ]);
  });

  it('caps the failures listed and says how many more there were', () => {
    const specs = Array.from({ length: 25 }, (_, index) =>
      spec(`test ${index}`, [failedResult(`Error: ${index} broke`)]),
    );
    const verdict = readReport(report([fileSuite(specs)], { unexpected: 25 }));

    expect(verdict.status).toBe('failed');
    expect(verdict.ran).toBe(25);
    expect(verdict.failures).toHaveLength(20);
    expect(verdict.failures[19].title).toBe('test 19');
    expect(verdict.note).toBe('5 further failing tests are not listed.');
  });
});

/**
 * A whole run, not just a stream — which output is read, and in what order.
 *
 * Split out of `readReport` because the decision could not be reached from a
 * test where it first lived: it sat in the MCP server, behind a real Playwright
 * installation and a real spawn, and a mutation that deleted it left every
 * suite green. It is three inputs and an answer, and every one of the three
 * changes what the answer means.
 */
describe('reading a finished run', () => {
  const REPORT = JSON.stringify({
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [
      { title: 'a.spec.ts', specs: [{ title: 'flow', tests: [{ results: [{ status: 'passed' }] }] }] },
    ],
  });

  it('reads stdout when stdout is readable, and ignores noise on stderr', () => {
    /*
     * The fix in the other direction, and the reason stderr is a fallback
     * rather than an addition: runners write deprecation warnings to stderr all
     * the time, and a version that concatenated unconditionally would turn a
     * passing replay into an unreadable one.
     */
    const verdict = readRun({
      stdout: REPORT,
      stderr: 'Warning: an experimental feature was used\n',
    });

    expect(verdict.status).toBe('passed');
    expect(verdict.ran).toBe(1);
  });

  it('falls back to stderr when stdout said nothing, so a crash reaches the reader', () => {
    /*
     * A runner that dies before it loads a spec prints its stack trace on
     * stderr and leaves stdout empty. Reading stdout alone answers "unreadable
     * — nothing was printed", which is true and tells nobody what to fix.
     */
    const verdict = readRun({
      stdout: '',
      stderr: "Error: Cannot find module '@playwright/test'\n    at Module._resolveFilename",
    });

    expect(verdict.status).toBe('unreadable');
    expect(verdict.note).toContain('Cannot find module');
  });

  it('calls a killed run unreadable even when it printed a clean report', () => {
    /*
     * The case that would otherwise be the worst answer this module can give. A
     * runner killed mid-suite may already have printed a report of the tests
     * that passed before the timeout; reading it says "passed" about a journey
     * that never finished, and a repair loop acts on that.
     */
    const verdict = readRun({ stdout: REPORT, stderr: '', timedOut: true });

    expect(verdict.status).toBe('unreadable');
    expect(verdict.status).not.toBe('passed');
    expect(verdict.note).toContain('timeout');
  });

  it('answers rather than throwing when a run carries nothing at all', () => {
    const verdict = readRun({ stdout: '', stderr: '' });
    expect(verdict.status).toBe('unreadable');
    expect(verdict.ran).toBe(0);
  });
});
