/**
 * `get_source_snippet` against the real server, over the real transport.
 *
 * Every other tool in `mcp-server/server.js` answers out of `~/.devflow/flows`
 * — the data the caller sent it in the first place. This one opens a file on
 * the developer's own machine, and the path it opens is `ComponentSource.source`
 * or `ComponentSource.absolutePath`: strings that came off a recorded page's
 * source map, delivered by an unauthenticated loopback POST that any page the
 * browser visits can make. A `..` in that string, or an absolute path, or a
 * symlink planted in the checkout, is the whole attack. The guard is
 * `contained()` run twice — once on `path.resolve`'s answer and once on
 * `realpath`'s — and it is the most important thing in this file.
 *
 * So the guard tests here are written against a specific wrong implementation:
 * `fs.readFile(path.join(root, candidate))`, which is what this tool looks like
 * if nobody is thinking about where the string came from. Each one asserts that
 * the secret file's *contents* are absent, not merely that the call was an
 * error — an error is easy to produce by accident, and a leak is not something
 * a truthy `isError` would have told anyone about.
 *
 * The other half is the ordinary product behaviour: a flow id and a step become
 * a file and a line, and each way that can fail gets its own sentence. Why this
 * is a spawned process rather than an import is in `tests/helpers/mcp-server.ts`.
 *
 * The windowing itself — gutters, marks, the tail of a short file — is
 * `src/core/source/snippet.ts` and is tested there. What is tested here is the
 * server's part: which root, which file, and what it says when there is neither.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

/** The string that must never appear in a response, in any test. */
const SECRET = 'SECRET-CONTENTS-b2f9-must-not-leak';

const NOW = 1_787_579_886_415;

/** The tool's own constants, so an assertion can name the number. */
const DEFAULT_RADIUS = 12;
const MAX_RADIUS = 100;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * `sandbox/` holds the project root and, deliberately beside it rather than in
 * it, the file a climbing path would reach.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-snippet-'));
const project = path.join(sandbox, 'project');
const elsewhere = path.join(sandbox, 'elsewhere');
const secretFile = path.join(sandbox, 'secret.txt');

let home: string;
let server: McpSession;

const call = (args: Record<string, unknown>): Promise<string> =>
  server.call('get_source_snippet', args);

/** A numbered file whose every line says which line it is. */
function writeSource(file: string, lines: number, label: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${Array.from({ length: lines }, (_, i) => `line ${i + 1} of ${label}`).join('\n')}\n`,
  );
}

/**
 * The fixture tree, built while this file is being collected rather than in
 * `beforeAll`.
 *
 * `it.skipIf` is evaluated as the suite is collected, so a flag `beforeAll` sets
 * is always still false when the symlink test asks about it — and that test
 * skipping silently is exactly the failure it exists to catch. Building the tree
 * here is synchronous and cheap; only the server needs `await`.
 */
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(secretFile, `${SECRET}\n`);
/** `project` after `realpath` — what the server prints, since it resolves first. */
const projectReal = fs.realpathSync(project);

writeSource(path.join(project, 'src/checkout/PayButton.tsx'), 60, 'PayButton.tsx');
writeSource(path.join(project, 'src/long/Ledger.tsx'), 400, 'Ledger.tsx');

// A second root, so the `root` argument can be shown selecting one.
writeSource(path.join(elsewhere, 'src/Other.tsx'), 20, 'Other.tsx');

// Bigger than the tool will open, by a margin no rounding closes.
fs.writeFileSync(path.join(project, 'src/bundle.js'), 'x'.repeat(MAX_SOURCE_BYTES + 1024));

/**
 * A symlink inside the root pointing at the file outside it — the test that
 * separates a real guard from a prefix check on the string. Not every platform
 * grants one, and there the test says it skipped rather than passing.
 */
const symlinked = ((): boolean => {
  try {
    fs.symlinkSync(secretFile, path.join(project, 'src/checkout/planted.tsx'));
    return true;
  } catch {
    return false;
  }
})();

/** The body of the one fenced block in a snippet response. */
function fenced(answer: string): string[] {
  const block = /```\n([\s\S]*?)\n```/.exec(answer);
  expect(block, `no code fence in:\n${answer}`).not.toBeNull();
  return (block?.[1] ?? '').split('\n');
}

/**
 * One recording, carrying every shape of component the tool has to tell apart:
 * one resolved, one that was never located, one whose source climbs out of the
 * checkout, one whose repo-relative path has moved but whose absolute path has
 * not, one naming a line past the end of the file, and one whose absolute path
 * is outside the root.
 */
function writeShopFlow(): void {
  const step = (n: number, owner?: string) => ({
    type: 'click',
    url: 'https://shop.example.com/cart',
    timestamp: NOW + n * 1000,
    action: `Clicked "Step ${n}"`,
    stepNumber: n,
    element: {
      tag: 'button',
      cssSelector: `button.step-${n}`,
      xpath: `/html/body/button[${n}]`,
      ...(owner ? { react: { chain: [owner], owner } } : {}),
    },
    consoleLogs: [],
    networkCalls: [],
  });

  writeFlow(home, {
    id: 'flow-shop',
    name: 'Checkout',
    timestamp: NOW,
    startUrl: 'https://shop.example.com',
    errorCount: 0,
    schemaVersion: 1,
    react: {
      detected: true,
      components: {
        // `via` is set deliberately, and it is the negative half of the
        // provenance pair below. A fixture with no `via` at all reads
        // identically under the correct rule and under one that labels every
        // path, so it proves nothing about either.
        pay: {
          name: 'PayButton',
          status: 'resolved',
          via: 'bundle-search',
          source: 'src/checkout/PayButton.tsx',
          line: 34,
        },
        stamped: {
          name: 'StampedButton',
          status: 'resolved',
          via: 'plugin',
          source: 'src/checkout/PayButton.tsx',
          line: 34,
        },
        lazy: {
          name: 'LazyPanel',
          status: 'no-map',
          detail: 'It is in a lazy chunk that was never loaded',
        },
        escaped: {
          name: 'EscapedButton',
          status: 'resolved',
          source: '../secret.txt',
          line: 1,
        },
        moved: {
          name: 'MovedButton',
          status: 'resolved',
          source: 'src/checkout/Renamed.tsx',
          line: 34,
          absolutePath: path.join(projectReal, 'src/checkout/PayButton.tsx'),
        },
        stale: {
          name: 'StaleButton',
          status: 'resolved',
          source: 'src/checkout/PayButton.tsx',
          line: 900,
        },
        leaky: {
          name: 'LeakyButton',
          status: 'resolved',
          source: 'src/checkout/Gone.tsx',
          line: 3,
          absolutePath: secretFile,
        },
      },
    },
    steps: [
      step(1, 'pay'),
      step(2),
      step(3, 'lazy'),
      step(4, 'escaped'),
      step(5, 'moved'),
      step(6, 'stale'),
      step(7, 'leaky'),
      step(8, 'stamped'),
    ],
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-test-'));
  writeShopFlow();

  server = await startServer({ home, env: { DEVFLOW_PROJECT_ROOT: project } });
}, 20_000);

afterAll(() => {
  server?.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true });
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('a path that came off a web page stays under the project root', () => {
  it('refuses a relative path that climbs out of the root', async () => {
    const answer = await call({ file: '../secret.txt' });

    expect(answer).toContain('resolves outside the project root');
    expect(answer).toContain(projectReal);
    expect(answer).not.toContain(SECRET);
  });

  it('refuses a deeper climb that starts by looking like it stays inside', async () => {
    const answer = await call({ file: 'src/../../secret.txt' });

    expect(answer).toContain('resolves outside the project root');
    expect(answer).not.toContain(SECRET);
  });

  it('refuses an absolute path outside the root rather than letting it win', async () => {
    // `path.resolve(root, "/abs")` is `/abs` — which is why containment is
    // checked on the result and not on the input.
    const answer = await call({ file: secretFile });

    expect(answer).toContain('resolves outside the project root');
    expect(answer).not.toContain(SECRET);
  });

  it('refuses /etc/hosts, and returns none of it', async () => {
    const answer = await call({ file: '/etc/hosts' });

    expect(answer).toContain('resolves outside the project root');

    const hosts = fs.existsSync('/etc/hosts') ? fs.readFileSync('/etc/hosts', 'utf8') : '';
    for (const line of hosts.split('\n')) {
      const body = line.trim();
      if (body.length > 8) expect(answer).not.toContain(body);
    }
  });

  /*
   * The escape and the missing file are two sentences, and a reader acts on
   * them differently: one says this checkout is not the application that was
   * recorded, the other says to point at a different root. So a path that
   * climbs out is refused as a climb even when there is nothing at the end of
   * it — which is the one case where only the written path can say so, because
   * there is no real path to canonicalise.
   */
  it('calls a climb out of the root an escape even when nothing is there', async () => {
    const answer = await call({ file: '../no-such-file-anywhere.tsx' });

    expect(answer).toContain('resolves outside the project root');
    expect(answer).not.toContain('was not found under the project root');
  });

  it.skipIf(!symlinked)(
    'refuses a symlink inside the root that points at a file outside it',
    async () => {
      // Resolving and prefix-checking the *path* passes this one; only asking
      // `realpath` where the file actually is catches it.
      const answer = await call({ file: 'src/checkout/planted.tsx' });

      expect(answer).toContain('resolves outside the project root');
      expect(answer).not.toContain(SECRET);
    },
  );

  /*
   * A directory is refused by its own sentence rather than by the escape one or
   * the missing one. Both of those send the reader somewhere: the first says
   * this checkout is not the application that was recorded, the second says to
   * pass a different root. Neither is true of a path that is simply not a file,
   * and acting on either wastes the move.
   */
  it('says the root is the root, rather than calling it a path that escaped', async () => {
    const answer = await call({ file: '.' });

    expect(answer).toContain('the project root itself, not a source file');
    expect(answer).not.toContain('resolves outside the project root');
  });

  it('says a directory inside the root is a directory, not a file that is missing', async () => {
    const answer = await call({ file: 'src/checkout' });

    expect(answer).toContain('is a directory, not a source file');
    expect(answer).not.toContain('was not found under the project root');
  });

  it('returns a file that genuinely is inside the root, so the guard is a guard', async () => {
    const answer = await call({ file: 'src/checkout/PayButton.tsx' });

    expect(answer).toContain('src/checkout/PayButton.tsx:1');
    expect(answer).toContain(`${projectReal}/src/checkout/PayButton.tsx`);
    // No `line`, so the window is centred on line 1 at the default radius.
    expect(answer).toContain(`lines 1–${1 + DEFAULT_RADIUS} of 60`);
    expect(answer).toMatch(/^> 1 \| line 1 of PayButton\.tsx$/m);
  });

  it('refuses a file too large to be source rather than reading it', async () => {
    const answer = await call({ file: 'src/bundle.js' });

    expect(answer).toContain('which is a bundle rather than a source file');
    expect(answer).toMatch(/src\/bundle\.js is \d+KB/);
  });

  it('says the root is missing rather than blaming the file, when it is', async () => {
    const answer = await call({
      file: 'src/checkout/PayButton.tsx',
      root: path.join(sandbox, 'no-such-root'),
    });

    expect(answer).toContain('does not exist, so there is nowhere to read');
    expect(answer).toContain('src/checkout/PayButton.tsx');
  });

  it('reads under the root it is given, when one is given', async () => {
    const answer = await call({ file: 'src/Other.tsx', line: 5, radius: 1, root: elsewhere });

    expect(answer).toContain('lines 4–6 of 20');
    expect(answer).toContain('line 5 of Other.tsx');
    // The file is not in the root the server was started with.
    expect(answer).not.toContain('PayButton');
  });
});

describe('a recording names the source to read', () => {
  it('shows the lines around the component the step happened in', async () => {
    const answer = await call({ id: 'flow-shop', step: 1 });

    expect(answer).toContain('src/checkout/PayButton.tsx:34 — PayButton, step 1');
    expect(answer).toContain(`${projectReal}/src/checkout/PayButton.tsx`);
    // The component's own line is the centre, at the default radius.
    expect(answer).toContain(
      `lines ${34 - DEFAULT_RADIUS}–${34 + DEFAULT_RADIUS} of 60`,
    );
    expect(answer).toMatch(/^>34 \| line 34 of PayButton\.tsx$/m);
    expect(answer).toContain('line 22 of PayButton.tsx');
    expect(answer).not.toContain('line 21 of PayButton.tsx');
    expect(answer).not.toContain('line 47 of PayButton.tsx');
  });

  it('centres on an explicit line instead, when one is passed', async () => {
    const answer = await call({ id: 'flow-shop', step: 1, line: 10, radius: 1 });

    expect(answer).toContain('src/checkout/PayButton.tsx:10 — PayButton, step 1');
    expect(answer).toContain('lines 9–11 of 60');
    expect(answer).toMatch(/^>10 \| line 10 of PayButton\.tsx$/m);
  });

  /*
   * The heading names the build stamp, and only for the build stamp.
   *
   * This tool is the one that turns an attribution into the *contents* of a
   * file, so a reader about to trust these lines is the reader entitled to know
   * the line number came out of a build step in the recorded application rather
   * than out of DevFlow. `ROADMAP_AND_PHASES.md` §1.1 rule 3.
   */
  it('names the build stamp in the heading when the stamp is what answered', async () => {
    const answer = await call({ id: 'flow-shop', step: 8, radius: 1 });

    expect(answer).toContain('src/checkout/PayButton.tsx:34 — StampedButton, step 8 (build stamp)');
  });

  it("says nothing about provenance for DevFlow's own paths", async () => {
    const answer = await call({ id: 'flow-shop', step: 1, radius: 1 });

    // Same file, same line, resolved by a bundle search: the heading is bare.
    expect(answer).toContain('src/checkout/PayButton.tsx:34 — PayButton, step 1\n');
    expect(answer).not.toContain('build stamp');
    expect(answer).not.toContain('bundle search');
    expect(answer).not.toContain('source map');
  });

  it('finds a component by name, for a reader who has one and not a step', async () => {
    const answer = await call({ id: 'flow-shop', component: 'PayButton', radius: 1 });

    expect(answer).toContain('src/checkout/PayButton.tsx:34 — PayButton');
    expect(answer).not.toContain('step');
    expect(answer).toContain('lines 33–35 of 60');
  });

  it('repeats why a component was never located, rather than saying there is no file', async () => {
    const answer = await call({ id: 'flow-shop', step: 3 });

    expect(answer).toContain('LazyPanel was never resolved to a source file');
    // The whole point: the sentence that says what to do about it.
    expect(answer).toContain('It is in a lazy chunk that was never loaded');
  });

  it('names no component call when a step has none, and says what to pass instead', async () => {
    const answer = await call({ id: 'flow-shop', step: 2 });

    expect(answer).toContain('has no component attributed to it');
    expect(answer).toContain('"file"');
    expect(answer).toContain('get_flow_step');
  });

  it('guards a path that arrived inside the recording, not only one typed in', async () => {
    // `EscapedButton.source` is `../secret.txt`, which is what a source map from
    // a page built somewhere else looks like — and what an attacker's looks like.
    const answer = await call({ id: 'flow-shop', step: 4 });

    expect(answer).toContain('resolves outside the project root');
    expect(answer).toContain("came from the recorded page's own source map");
    expect(answer).not.toContain(SECRET);
  });

  it('falls back to the absolute path the map recorded when the relative one misses', async () => {
    const answer = await call({ id: 'flow-shop', step: 5, radius: 1 });

    expect(answer).toContain(`${projectReal}/src/checkout/PayButton.tsx`);
    expect(answer).toContain('lines 33–35 of 60');
  });

  it('puts that absolute path through the same guard, and leaks nothing', async () => {
    const answer = await call({ id: 'flow-shop', step: 7 });

    expect(answer).not.toContain(SECRET);
    // The relative candidate missed and the absolute one was refused, so what
    // the reader is told about is the file the recording actually named.
    expect(answer).toContain('src/checkout/Gone.tsx was not found under the project root');
  });

  it('refuses with what the tool needs when neither a file nor an id is given', async () => {
    const answer = await call({});

    expect(answer).toContain('get_source_snippet needs either a "file"');
    expect(answer).toContain('"id"');
    expect(answer).toContain('"step"');
  });

  /*
   * The flag, not only the sentence. An MCP client reads `isError` to tell an
   * answer from a refusal, so a refusal sent as a success is a sentence the
   * model treats as a finding — and every assertion on the text alone passes
   * either way.
   */
  it('sends a refused read as an error, so it cannot be read as source', async () => {
    const escaped = await server.callRaw('get_source_snippet', { file: '../secret.txt' });

    expect(escaped.isError).toBe(true);
  });

  it('says how many steps there are when the step number is past the end', async () => {
    const answer = await call({ id: 'flow-shop', step: 99 });

    expect(answer).toContain('"Checkout" has no step 99');
    expect(answer).toContain('It has 8 steps, numbered 1 to 8');
  });

  it('says a flow is not there when the id names nothing', async () => {
    const answer = await call({ id: 'flow-nope', step: 1 });

    expect(answer).toContain('Flow "flow-nope" not found');
    expect(answer).toContain('list_flows');
  });

  it('says a component is not in the recording when the name is unknown', async () => {
    const answer = await call({ id: 'flow-shop', component: 'NoSuchButton' });

    expect(answer).toContain('records no component called "NoSuchButton"');
    expect(answer).toContain('get_flow');
  });
});

describe('how much of the file comes back', () => {
  it('honours a radius, so a reader can ask for the function or the file', async () => {
    const answer = await call({ file: 'src/long/Ledger.tsx', line: 200, radius: 2 });

    expect(answer).toContain('lines 198–202 of 400');
    expect(fenced(answer)).toHaveLength(5);
  });

  it('clamps a radius past the maximum rather than refusing it', async () => {
    const answer = await call({ file: 'src/long/Ledger.tsx', line: 200, radius: 5_000 });

    expect(answer).toContain(`lines ${200 - MAX_RADIUS}–${200 + MAX_RADIUS} of 400`);
    expect(fenced(answer)).toHaveLength(MAX_RADIUS * 2 + 1);
  });

  it('says the checkout is not the build that was recorded when the line is past the end', async () => {
    const answer = await call({ id: 'flow-shop', step: 6 });

    expect(answer).toContain('Line 900 is past the end of this file');
    expect(answer).toContain('was made against a different build of this application');
    // The tail of the file, which is the evidence — not silently the wrong lines.
    expect(answer).toContain(`lines ${60 - DEFAULT_RADIUS}–60 of 60`);
    expect(answer).toContain('line 60 of PayButton.tsx');
  });
});
