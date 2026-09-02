/**
 * `compare_flows_across_deploys`, from the outside — the join, not the pieces.
 *
 * `tests/deploy.test.ts` already hands `choosePair`, `suspectFiles` and
 * `renderDeployDiff` fixtures and checks what they answer. Everything those
 * three cannot see is here, and all of it lives in the handler: which two
 * recordings on disk are "the two builds", that a name and an id reach the same
 * pair, that a `sha` is rejected before it can reach a `git` argument list, that
 * the runtime half is `compare_flows` *relabelled* rather than reimplemented,
 * and — the reason the tool exists — that the shortlist is narrower than the
 * commit range because the graph and the recordings know which files have
 * actually been watched running.
 *
 * So the repositories are real, built with `git` per suite, and every recording
 * arrives by POST. A flow written straight into `flows/` would carry whatever
 * `git` field this file typed, and the stamp the pair is chosen by is precisely
 * the field only `saveFlow` can put there — `tests/mcp-git-stamp.test.ts` is the
 * model for that and for the helpers below.
 *
 * Servers are spawned fresh whenever a commit lands underneath one:
 * `readCheckout` memoises for five seconds, so a process that was running
 * before the commit would stamp the next recording with the build it read
 * first, and every "two builds" assertion here would then be one build twice.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type McpSession } from './helpers/mcp-server.js';

const sessions: McpSession[] = [];
const scratch: string[] = [];

afterAll(() => {
  for (const session of sessions) session.stop();
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

// ── A real repository, per suite ──────────────────────────────────────────────

/** `realpathSync` because macOS's `/var` is a symlink — see `mcp-git-stamp`. */
function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function initRepo(): string {
  const dir = tempDir('devflow-deploy-repo-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@devflow.invalid');
  git(dir, 'config', 'user.name', 'DevFlow Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function write(repo: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

/** Write the files, commit them all, and answer with the SHA git chose. */
function commit(repo: string, files: Record<string, string>, message: string): string {
  write(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

const short = (sha: string) => sha.slice(0, 10);

// ── A server pointed at one ───────────────────────────────────────────────────

interface ServeOptions {
  home?: string;
  env?: Record<string, string>;
}

async function serve(root: string | null, options: ServeOptions = {}): Promise<McpSession> {
  const home = options.home ?? tempDir('devflow-deploy-home-');
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  const session = await startServer({
    home,
    env: { ...(root ? { DEVFLOW_PROJECT_ROOT: root } : {}), ...options.env },
  });
  sessions.push(session);
  return session;
}

async function send(session: McpSession, body: unknown): Promise<void> {
  const posted = await session.post('/flows', JSON.stringify(body));
  expect(posted.status).toBe(200);
}

// ── One recording, as the extension sends it ──────────────────────────────────

interface FlowOptions {
  /** The file the one component was written in. */
  source?: string;
  /** What `POST /api/checkout` answered on this run. */
  status?: number;
  /** A console error only this run logs. */
  error?: string;
  /** Sorts the recordings; `choosePair` reads it, and so does `list_flows`. */
  timestamp?: number;
}

/**
 * The `action` carries the recording's id so two runs of one flow differ in the
 * content hash `ingestFlow` keys re-sends by — a byte-identical second POST
 * returns early, and the second build would then never reach the graph at all.
 */
function flow(id: string, name: string, options: FlowOptions = {}) {
  const at = options.timestamp ?? 1_700_000_000_000;
  return {
    id,
    name,
    timestamp: at,
    startUrl: 'http://localhost:5173/cart',
    schemaVersion: 1,
    react: {
      components: { cmp_cart: { name: 'CartButton', source: options.source ?? 'src/Cart.tsx', line: 12 } },
    },
    steps: [
      {
        type: 'click',
        url: 'http://localhost:5173/cart',
        timestamp: at,
        action: `Clicked "Buy" during ${id}`,
        stepNumber: 1,
        element: {
          tag: 'button',
          cssSelector: '#buy',
          react: { owner: 'cmp_cart', chain: ['cmp_cart'] },
        },
        networkCalls: [
          {
            url: 'http://localhost:5173/api/checkout',
            method: 'POST',
            status: options.status ?? 200,
            durationMs: 12,
            timestamp: at,
          },
        ],
        consoleLogs: options.error
          ? [{ level: 'error', args: [options.error], timestamp: at }]
          : [],
      },
    ],
  };
}

// ── Reading one section of the report ─────────────────────────────────────────

/**
 * The four sections are four different kinds of claim, so an assertion that
 * a file is *absent from the shortlist* has to look at the shortlist and not at
 * the whole page — the commit list above it prints subjects, and a subject that
 * happened to name a file would otherwise pass.
 */
function section(report: string, heading: string): string {
  const start = report.indexOf(heading);
  expect(start, `no "${heading}" section in:\n${report}`).toBeGreaterThanOrEqual(0);
  const rest = report.slice(start + heading.length);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

const SHIPPED = '## What shipped between the two builds';
const SHORTLIST = '## Of those, the files DevFlow has seen running';

// ── The graph, read the way `mcp-git-stamp.test.ts` reads it ──────────────────

const require = createRequire(path.join(process.cwd(), 'mcp-server', 'package.json'));
type Row = Record<string, unknown>;
const Database = require('better-sqlite3') as new (file: string) => {
  prepare(sql: string): { all(...params: unknown[]): Row[] };
  close(): void;
};

function query(home: string, sql: string, ...params: unknown[]): Row[] {
  const db = new Database(path.join(home, 'arkg.db'));
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════════

describe('one flow, recorded at two builds', () => {
  let repo: string;
  let first: string;
  let second: string;
  let session: McpSession;
  let report: string;

  beforeAll(async () => {
    repo = initRepo();
    first = commit(repo, { 'src/Cart.tsx': 'export const CartButton = () => null;\n' }, 'Add the cart button');

    const before = await serve(repo);
    const home = before.home;
    await send(before, flow('checkout-old', 'Checkout', { timestamp: 1_700_000_000_000 }));
    before.stop();

    /*
     * Three files, and only one of them has ever had code watched running in
     * it. That asymmetry is the whole feature: the range says three, the
     * shortlist must say one.
     */
    second = commit(
      repo,
      {
        'src/Cart.tsx': 'export const CartButton = () => { throw new Error("boom"); };\n',
        'src/Unrecorded.tsx': 'export const Nobody = () => null;\n',
        'docs/release-plan.md': '# how we ship\n',
      },
      'Make checkout answer 500',
    );

    // A fresh process, because `readCheckout` memoises across that commit.
    session = await serve(repo, { home });
    await send(
      session,
      flow('checkout-new', 'Checkout', {
        status: 500,
        error: 'Checkout failed: 500',
        timestamp: 1_700_000_100_000,
      }),
    );
    // A second flow, recorded once, for the "only one build" refusal below.
    await send(session, flow('solo-a', 'Solo', { timestamp: 1_700_000_200_000 }));

    report = await session.call('compare_flows_across_deploys', { flow: 'Checkout' });
  }, 60_000);

  it('names both builds by the commits the server stamped them with', () => {
    // Against the repository, not against a constant — the point of building a
    // real one is that nothing here gets to say what the answer should be.
    expect(report).toContain(short(first));
    expect(report).toContain(short(second));
    expect(report).toContain('Add the cart button');
  });

  it('reports the runtime difference the two recordings actually carry', () => {
    expect(report).toContain('POST /api/checkout: 200 → 500');
    expect(report).toContain('Checkout failed: 500');
  });

  it('lists what shipped between the two commits, from git and not from the payload', () => {
    const shipped = section(report, SHIPPED);
    expect(shipped).toContain('1 commit, 3 files changed.');
    expect(shipped).toContain(`\`${short(second)}\` Make checkout answer 500`);
  });

  it('shortlists the file the component lives in and not the files nothing was recorded in', () => {
    /*
     * The narrowing, which is the only thing here `git log` could not have
     * said. Three files changed; two of them no recording has ever run
     * through, and printing them would make this a re-print of
     * `git log --name-only` wearing a graph's clothes.
     */
    const shortlist = section(report, SHORTLIST);
    expect(shortlist).toContain('src/Cart.tsx');
    expect(shortlist).toContain('CartButton');
    expect(shortlist).not.toContain('src/Unrecorded.tsx');
    expect(shortlist).not.toContain('docs/release-plan.md');

    // Said in words, beside the list, rather than left to the reader.
    expect(shortlist).toContain('A shortlist, not a cause.');
  });

  it('resolves the id of one recording to the flow that recording is of', async () => {
    /*
     * A flow id names one recording made at one commit, so it cannot itself
     * have two builds — the handler looks the id's *name* up and compares the
     * builds of that. Either spelling therefore has to produce one answer.
     */
    const byId = await session.call('compare_flows_across_deploys', { flow: 'checkout-new' });
    expect(byId).toBe(report);
  });

  it('reads the two builds through the graph the recordings built', () => {
    // Not an assertion about the report: it is what makes the one above a test
    // of the intersection rather than of an empty graph falling back to the
    // recordings. Only the recorded file is a node at all.
    const files = query(session.home, 'SELECT id FROM arkg_source_files').map((row) => row.id);
    expect(files).toEqual(['src/Cart.tsx']);
  });

  describe('the labels', () => {
    /*
     * `compareFlows` gained a `labels` parameter for this tool, and the risk a
     * default parameter carries is that its default is not quite what the code
     * said before it existed. So the old caller is asserted against the exact
     * strings verbatim, and the new one against never using them: a report that
     * called the newer build "the broken run" would be asserting a fault
     * nobody observed.
     */
    it('leaves compare_flows saying "the working run" and "the broken run"', async () => {
      const compared = await session.call('compare_flows', {
        working: 'checkout-old',
        broken: 'checkout-new',
      });

      expect(compared).toContain('the working run');
      expect(compared).toContain('the broken run');
    });

    it('calls the two builds older and newer, and neither of them broken', () => {
      expect(report).toContain('the newer build');
      expect(report).toContain('the older build');
      expect(report).not.toContain('the broken run');
      expect(report).not.toContain('the working run');
    });
  });

  describe('refusals arrive as refusals', () => {
    /*
     * `isError`, not the wording. An MCP client reads the flag to tell "here is
     * your answer" from "I could not", and a refusal returned as a success is a
     * sentence the model treats as a finding.
     */
    it('refuses a sha that is not hex, and says what the constraint is', async () => {
      for (const sha of ['nothex', 'abc']) {
        const refused = await session.callRaw('compare_flows_across_deploys', { flow: 'Checkout', sha });
        expect(refused.isError, `"${sha}" was not refused`).toBe(true);
        expect(refused.text).toContain('hex');
        expect(refused.text).toContain(JSON.stringify(sha));
      }
    });

    it('refuses a sha shaped like a git option before it can reach an argv', async () => {
      /*
       * The security boundary. `sha` is the one argument here that would
       * otherwise be handed to a `git` argument list, and `--upload-pack=` is
       * the shape that turns a read into an execution. It is refused by the
       * character class, above every lookup, so nothing runs at all.
       */
      const refused = await session.callRaw('compare_flows_across_deploys', {
        flow: 'Checkout',
        sha: '--upload-pack=x',
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('hex');
      expect(refused.text).not.toContain(short(first));
    });

    it('refuses an otherSha that is not hex too, naming which of the two it is', async () => {
      const refused = await session.callRaw('compare_flows_across_deploys', {
        flow: 'Checkout',
        sha: first,
        otherSha: 'not-a-sha',
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('otherSha');
    });

    it('refuses a flow name nothing was recorded under, and says what was', async () => {
      const refused = await session.callRaw('compare_flows_across_deploys', { flow: 'Chekcout' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('Chekcout');
      expect(refused.text).toContain('"Checkout"');
    });

    it('refuses a flow that has only ever been recorded at one commit', async () => {
      const refused = await session.callRaw('compare_flows_across_deploys', { flow: 'Solo' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(short(second));
      expect(refused.text).toContain('record the flow again');
    });

    it('refuses an empty flow argument rather than guessing', async () => {
      const refused = await session.callRaw('compare_flows_across_deploys', { flow: '   ' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('list_flows');
    });
  });

  /*
   * Not a refusal, which is the finding worth pinning: the handler lowercases
   * before it validates, so an uppercase commit is normalised rather than
   * rejected — even though the tool's own description says "lowercase hex".
   * Nothing unsafe reaches git either way, because what is validated is what is
   * compared and only the *recording's* stamp is ever passed to a subprocess.
   */
  it('normalises an uppercase commit instead of refusing it', async () => {
    const upper = await session.call('compare_flows_across_deploys', {
      flow: 'Checkout',
      sha: first.toUpperCase(),
    });
    expect(upper).toBe(report);
  });
});

describe('three builds of one flow', () => {
  /*
   * With no commits named the tool answers "the latest two builds", which is
   * what somebody asking the question usually means. Naming two is how they ask
   * a different question, and this is the suite where the two answers differ —
   * with only two builds on disk every selection produces the same pair and the
   * SHAs would be provably doing nothing.
   */
  let repo: string;
  let one: string;
  let two: string;
  let three: string;
  let session: McpSession;

  beforeAll(async () => {
    repo = initRepo();

    one = commit(repo, { 'src/Cart.tsx': 'v1\n' }, 'the first build');
    const a = await serve(repo);
    const home = a.home;
    await send(a, flow('search-1', 'Search', { timestamp: 1_700_000_000_000 }));
    a.stop();

    two = commit(repo, { 'src/Cart.tsx': 'v2\n' }, 'the second build');
    const b = await serve(repo, { home });
    await send(b, flow('search-2', 'Search', { timestamp: 1_700_000_100_000 }));
    b.stop();

    three = commit(repo, { 'src/Cart.tsx': 'v3\n' }, 'the third build');
    session = await serve(repo, { home });
    await send(session, flow('search-3', 'Search', { status: 500, timestamp: 1_700_000_200_000 }));
  }, 60_000);

  /** The `**Older:**` / `**Newer:**` line, which is where the pair is stated. */
  const roleLine = (report: string, role: string): string => {
    const line = report.split('\n').find((l) => l.startsWith(`**${role}:**`));
    expect(line, `no ${role} line in:\n${report}`).toBeDefined();
    return line ?? '';
  };

  it('compares the latest two builds when no commit is named', async () => {
    const report = await session.call('compare_flows_across_deploys', { flow: 'Search' });
    expect(roleLine(report, 'Older')).toContain(short(two));
    expect(roleLine(report, 'Newer')).toContain(short(three));
  });

  it('compares the two builds the caller names, and not the latest pair', async () => {
    const report = await session.call('compare_flows_across_deploys', {
      flow: 'Search',
      sha: one,
      otherSha: three,
    });

    expect(roleLine(report, 'Older')).toContain(short(one));
    expect(roleLine(report, 'Older')).not.toContain(short(two));
    expect(roleLine(report, 'Newer')).toContain(short(three));

    // And the range widens to match: the middle commit is now inside it, which
    // is the half of the selection `choosePair` alone cannot demonstrate.
    const shipped = section(report, SHIPPED);
    expect(shipped).toContain('2 commits');
    expect(shipped).toContain('the second build');
    expect(shipped).toContain('the third build');
  });

  it('accepts a short prefix of each commit', async () => {
    const report = await session.call('compare_flows_across_deploys', {
      flow: 'Search',
      sha: one.slice(0, 7),
      otherSha: three.slice(0, 7),
    });
    expect(roleLine(report, 'Older')).toContain(short(one));
    expect(roleLine(report, 'Newer')).toContain(short(three));
  });

  it('refuses a well-formed commit no recording of this flow was made at', async () => {
    const absent = 'a'.repeat(40);
    const refused = await session.callRaw('compare_flows_across_deploys', {
      flow: 'Search',
      sha: absent,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(short(one));
    expect(refused.text).toContain(short(three));
  });
});

describe('an installation with no knowledge graph', () => {
  /*
   * `arkgTry` says every tool must survive a graph that will not load, and this
   * tool would be the easy one to get wrong: the shortlist is an intersection
   * with `getObservedFiles()`, and an intersection with nothing is nothing —
   * the tool would degrade to silently printing "None" rather than to printing
   * what the two recordings themselves say.
   *
   * Reached honestly rather than by mocking: the flows are the ones a server
   * really POSTed, copied into a home with no `arkg.db` beside them. The graph
   * is then genuinely absent — asserted below, not assumed — so anything the
   * shortlist names can only have come from the two recordings' own component
   * tables.
   */
  let repo: string;
  let first: string;
  let second: string;
  let session: McpSession;

  beforeAll(async () => {
    repo = initRepo();
    first = commit(repo, { 'src/Cart.tsx': 'v1\n' }, 'Add the cart button');

    const before = await serve(repo);
    await send(before, flow('bare-old', 'Bare', { timestamp: 1_700_000_000_000 }));
    before.stop();

    second = commit(
      repo,
      { 'src/Cart.tsx': 'v2\n', 'src/Unrecorded.tsx': 'v1\n' },
      'Make checkout answer 500',
    );

    const after = await serve(repo, { home: before.home });
    await send(after, flow('bare-new', 'Bare', { status: 500, timestamp: 1_700_000_100_000 }));
    after.stop();

    // The recordings, without the graph that was built beside them.
    const home = tempDir('devflow-nograph-home-');
    fs.cpSync(path.join(before.home, 'flows'), path.join(home, 'flows'), { recursive: true });
    session = await serve(repo, { home });
  }, 60_000);

  it('has no graph to read', () => {
    const db = path.join(session.home, 'arkg.db');
    const observed = fs.existsSync(db) ? query(session.home, 'SELECT id FROM arkg_source_files') : [];
    expect(observed).toHaveLength(0);
  });

  it('still shortlists the file the two recordings put the component in', async () => {
    const report = await session.call('compare_flows_across_deploys', { flow: 'Bare' });

    expect(report).toContain(short(first));
    expect(report).toContain(short(second));

    const shortlist = section(report, SHORTLIST);
    expect(shortlist).toContain('src/Cart.tsx');
    expect(shortlist).toContain('CartButton');
    expect(shortlist).not.toContain('src/Unrecorded.tsx');
  });
});
