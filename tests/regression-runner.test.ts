/**
 * The parts of the regression check that touch a disk, an argv or a
 * subprocess — everything `tests/regression.test.ts` cannot reach.
 *
 * The CLI cases are about its two refusals. It runs the repository's own test
 * runner against the repository's own application, so it is behind
 * `DEVFLOW_REPLAY` exactly as `replay_flow` is; and it publishes nothing, ever,
 * because the credentials that could comment on a pull request belong to
 * whoever owns the repository and not to a tool a workflow file can point
 * anywhere.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generatePlaywrightTest } from '../src/core/export/playwright.js';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-regression-')));
  scratch.push(dir);
  return dir;
}

const SERVER = path.resolve(__dirname, '../mcp-server/server.js');

/**
 * `mcp-server/` is a second npm package with no types, so its shape is declared
 * where it is used — the same arrangement `tests/arkg.test.ts` makes, and for
 * the same reason: a `.d.ts` beside a published `.js` would be a second
 * description of one module to keep in step with it.
 */
interface Call {
  method: string;
  url: string;
  status: number;
  durationMs: number;
}

interface Regression {
  readFlows: (dir: string) => { id: string; name: string; steps: unknown[] }[];
  recordedCalls: (flow: unknown) => Call[];
  readObservedCalls: (report: unknown) => Call[];
}

const REGRESSION_URL = new URL('../mcp-server/regression.js', import.meta.url).href;
const regression = (await import(/* @vite-ignore */ REGRESSION_URL)) as Regression;

/** The CLI, with its real exit code — never through a pipe. */
function cli(args: string[], env: Record<string, string> = {}): { out: string; code: number } {
  try {
    const out = execFileSync('node', [SERVER, 'regression', ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { out: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, code: failure.status ?? 1 };
  }
}

describe('the runner’s reads', () => {
  it('finds committed flows and skips a directory that will not parse', () => {
    const { readFlows } = regression;
    const dir = tempDir();

    fs.mkdirSync(path.join(dir, 'good'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'good/flow.json'),
      JSON.stringify({ id: 'good', name: 'Checkout', steps: [] }),
    );
    fs.mkdirSync(path.join(dir, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken/flow.json'), '{ not json');

    const flows = readFlows(dir);
    expect(flows.map((flow) => flow.id)).toEqual(['good']);
  });

  it('answers with no flows for a directory that does not exist, rather than throwing', () => {
    const { readFlows } = regression;
    expect(readFlows(path.join(tempDir(), 'nope'))).toEqual([]);
  });

  it('flattens a recording’s network calls and drops the ones with nothing to compare', () => {
    const { recordedCalls } = regression;
    const calls = recordedCalls({
      steps: [
        {
          networkCalls: [
            { url: 'https://a.test/x', method: 'POST', status: 201, durationMs: 12 },
            { url: 'https://a.test/y' },
            { method: 'GET', status: 200 },
          ],
        },
      ],
    });
    expect(calls).toEqual([{ method: 'POST', url: 'https://a.test/x', status: 201, durationMs: 12 }]);
  });

  /** A report shaped like Playwright's, with the attachment nested as deep as a real one. */
  const report = (attachmentFile: string | null) => ({
    suites: [
      {
        suites: [
          {
            specs: [
              {
                tests: [
                  {
                    results: [
                      {
                        attachments: attachmentFile
                          ? [{ name: 'devflow-calls', path: attachmentFile, contentType: 'application/json' }]
                          : [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  it('reads a missing, absent or malformed attachment as no observation, never as no requests', () => {
    const { readObservedCalls } = regression;
    const file = path.join(tempDir(), 'calls.json');

    expect(readObservedCalls(null)).toEqual([]);
    expect(readObservedCalls(report(null))).toEqual([]);
    // Named in the report and not on disk.
    expect(readObservedCalls(report(file))).toEqual([]);

    fs.writeFileSync(file, 'not json');
    expect(readObservedCalls(report(file))).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ nope: true }));
    expect(readObservedCalls(report(file))).toEqual([]);
  });

  it('finds the attachment however deep the report nests it', () => {
    const { readObservedCalls } = regression;
    const file = path.join(tempDir(), 'calls.json');
    fs.writeFileSync(
      file,
      JSON.stringify([{ method: 'GET', url: 'https://a.test/x', status: 200, durationMs: 9 }]),
    );
    expect(readObservedCalls(report(file))).toEqual([
      { method: 'GET', url: 'https://a.test/x', status: 200, durationMs: 9 },
    ]);
  });
});

describe('the generated spec, per mode', () => {
  const steps = [
    {
      type: 'click' as const,
      url: 'https://app.test/cart',
      timestamp: 1,
      action: 'Clicked "Buy"',
      stepNumber: 1,
      element: { tag: 'button', cssSelector: '#buy', text: 'Buy' },
      networkCalls: [
        {
          url: 'https://app.test/api/checkout',
          method: 'POST',
          status: 200,
          durationMs: 12,
          timestamp: 1,
          responseBody: '{"ok":true}',
          responseHeaders: { 'content-type': 'application/json' },
        },
      ],
    },
  ];

  it('serves the recorded responses by default, which is what an export has always done', () => {
    const spec = generatePlaywrightTest(steps as never, 'Checkout');
    expect(spec).toContain('page.route(');
    expect(spec).not.toContain('__devflowCalls');
  });

  it('serves nothing and collects the wire when mocks are off', () => {
    const spec = generatePlaywrightTest(steps as never, 'Checkout', { mocks: false });
    expect(spec).not.toContain('page.route(');
    expect(spec).toContain('Recorded responses are NOT served');
    expect(spec).toContain("page.on('response'");
    expect(spec).toContain("attach('devflow-calls'");
  });

  it('leaves the wire through an attachment, so `core/` bundles no filesystem access', () => {
    // `tests/react-server-guard.test.ts` asserts that mcp-server/core.js holds
    // no filesystem access at all, and a generated string containing `node:fs`
    // trips it — rightly, because the way that guard stops being useful is
    // somebody deciding their own occurrence is the harmless one.
    const spec = generatePlaywrightTest(steps as never, 'Checkout', { mocks: false });
    expect(spec).not.toContain('node:fs');
    expect(spec).not.toContain('import.meta');
  });
});

describe('the command', () => {
  it('refuses without DEVFLOW_REPLAY, on replay_flow’s own argument', () => {
    const { out, code } = cli([], { DEVFLOW_REPLAY: '' });
    expect(code).toBe(2);
    expect(out).toContain('executes your test runner against your');
    expect(out).toContain('DEVFLOW_REPLAY=1');
  });

  it('refuses a mode it does not have', () => {
    const { code } = cli(['--mode', 'nonsense'], { DEVFLOW_REPLAY: '1' });
    expect(code).toBe(2);
  });

  it('refuses an argument it does not know rather than ignoring it', () => {
    const { out, code } = cli(['--pretty-please'], { DEVFLOW_REPLAY: '1' });
    expect(code).toBe(2);
    expect(out).toContain('unknown argument');
  });

  it('reports an empty run as inconclusive and exits 0, or 1 under --strict', () => {
    const empty = tempDir();
    const relaxed = cli(['--flows', empty], { DEVFLOW_REPLAY: '1' });
    expect(relaxed.code).toBe(0);
    expect(relaxed.out).toContain('inconclusive');

    expect(cli(['--flows', empty, '--strict'], { DEVFLOW_REPLAY: '1' }).code).toBe(1);
  });

  it('says outright that it publishes nothing', () => {
    const { out } = cli(['--help'], { DEVFLOW_REPLAY: '1' });
    expect(out).toContain('Nothing is posted anywhere');
  });
});
