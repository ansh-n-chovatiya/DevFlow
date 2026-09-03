/**
 * `get_commit_candidates` and `get_blast_radius` from the outside.
 *
 * `tests/forensics.test.ts` hands the pure module fixtures and checks what it
 * decides. Everything it cannot see is here, and all of it is in the handler:
 * that a real `git log` reaches the walk at all, that a path git printed and a
 * path a source map wrote actually meet, that the sighting written into
 * `git_sha` by a clean-tree ingest is the one the standings are measured
 * against, and that a dirty tree therefore produces `unanchored` rather than a
 * confident ordering against nothing.
 *
 * The repositories are real and built with `git` per suite, and every recording
 * arrives by POST — a flow written straight into `flows/` would carry whatever
 * `git` field this file typed, and the stamp is precisely the field only
 * `saveFlow` can put there. `tests/mcp-deploy-diff.test.ts` is the model.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startServer, type McpSession } from './helpers/mcp-server.js';

const sessions: McpSession[] = [];
const scratch: string[] = [];

afterAll(() => {
  for (const session of sessions) session.stop();
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** `realpathSync` because macOS's `/var` is a symlink — see `mcp-git-stamp`. */
function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function initRepo(): string {
  const dir = tempDir('devflow-forensics-repo-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ada@devflow.invalid');
  git(dir, 'config', 'user.name', 'Ada Lovelace');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

async function serve(root: string | null, env: Record<string, string> = {}): Promise<McpSession> {
  const home = tempDir('devflow-forensics-home-');
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  const session = await startServer({
    home,
    env: { ...(root ? { DEVFLOW_PROJECT_ROOT: root } : {}), ...env },
  });
  sessions.push(session);
  return session;
}

/** One recording whose single component resolves to `source`. */
function flow(id: string, source: string | null = 'src/Cart.tsx') {
  const at = 1_700_000_000_000;
  return {
    id,
    name: `Recording ${id}`,
    timestamp: at,
    startUrl: 'http://localhost:5173/cart',
    schemaVersion: 1,
    react: {
      components: {
        cmp_cart: source
          ? { name: 'CartButton', source, line: 12 }
          : { name: 'CartButton' },
      },
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
            status: 200,
            durationMs: 12,
            timestamp: at,
          },
        ],
        consoleLogs: [],
      },
    ],
  };
}

async function send(session: McpSession, body: unknown): Promise<void> {
  const posted = await session.post('/flows', JSON.stringify(body));
  expect(posted.status).toBe(200);
}

describe('get_commit_candidates', () => {
  it('is declared, so a model can find it without being told', async () => {
    const session = await serve(null);
    const tools = await session.tools();
    expect(tools).toContain('get_commit_candidates');
    expect(tools).toContain('get_blast_radius');
  });

  it('names the commits that landed after the graph last watched the component run', async () => {
    const repo = initRepo();
    commit(repo, { 'src/Cart.tsx': 'export const CartButton = () => null;\n' }, 'add the cart');

    const session = await serve(repo);
    // Ingested on a clean tree, so the sighting reaches `git_sha`.
    await send(session, flow('flow-1'));

    const after = commit(repo, { 'src/Cart.tsx': 'export const CartButton = () => <b/>;\n' }, 'change the cart');

    const report = await session.call('get_commit_candidates', { componentId: 'CartButton' });

    expect(report).toContain('CartButton — src/Cart.tsx:12');
    expect(report).toContain('1 commit changed this file after the graph last saw CartButton run');
    expect(report).toContain(after.slice(0, 10));
    expect(report).toContain('unseen-since:');
    expect(report).toContain('anchor: the commit CartButton was last observed at');
    expect(report).toContain('Ada Lovelace');
  });

  it('refuses to name a cause even when it has one obvious candidate', async () => {
    const repo = initRepo();
    commit(repo, { 'src/Cart.tsx': 'a\n' }, 'first');
    const session = await serve(repo);
    await send(session, flow('flow-1'));
    commit(repo, { 'src/Cart.tsx': 'b\n' }, 'second');

    const report = await session.call('get_commit_candidates', { componentId: 'CartButton' });
    expect(report).toContain('None of these is a cause');
    expect(report).toContain('it compares dates, not behaviour');
  });

  it('ignores commits that did not touch the component’s file', async () => {
    const repo = initRepo();
    commit(repo, { 'src/Cart.tsx': 'a\n' }, 'the cart');
    const session = await serve(repo);
    await send(session, flow('flow-1'));
    commit(repo, { 'src/Other.tsx': 'x\n' }, 'something else entirely');

    const report = await session.call('get_commit_candidates', { componentId: 'CartButton' });
    expect(report).toContain('None of them landed after the graph last saw CartButton run');
    expect(report).not.toContain('something else entirely');
  });

  it('is unanchored when every observation was made with a dirty tree', async () => {
    const repo = initRepo();
    commit(repo, { 'src/Cart.tsx': 'a\n' }, 'the cart');
    // An untracked file is a dirty tree, and a dirty tree writes no `git_sha`.
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'wip\n');

    const session = await serve(repo);
    await send(session, flow('flow-1'));

    const report = await session.call('get_commit_candidates', { componentId: 'CartButton' });
    expect(report).toContain('unanchored:');
    expect(report).toContain('no clean-tree sighting');
  });

  it('says git could not be read rather than reporting an empty history', async () => {
    const repo = initRepo();
    commit(repo, { 'src/Cart.tsx': 'a\n' }, 'the cart');
    const session = await serve(repo, { DEVFLOW_GIT: '0' });
    await send(session, flow('flow-1'));

    const report = await session.call('get_commit_candidates', { componentId: 'CartButton' });
    expect(report).toContain('No commit history was read');
    expect(report).not.toContain('Read the last');
  });

  it('says a component was never resolved to a file, rather than that it has no commits', async () => {
    const repo = initRepo();
    commit(repo, { 'src/Cart.tsx': 'a\n' }, 'the cart');
    const session = await serve(repo);
    await send(session, flow('flow-1', null));

    const report = await session.call('get_commit_candidates', { componentId: 'CartButton' });
    expect(report.replace(/\s+/g, ' ')).toContain('never resolved to a source file');
    expect(report).toContain('source-mapping failure');
  });

  it('takes a file instead of a component', async () => {
    const repo = initRepo();
    commit(repo, { 'src/Cart.tsx': 'a\n' }, 'the cart');
    const session = await serve(repo);
    await send(session, flow('flow-1'));

    const report = await session.call('get_commit_candidates', { file: 'src/Cart.tsx' });
    expect(report).toContain('src/Cart.tsx');
    expect(report).toContain('the cart');
  });

  it('asks for an argument rather than guessing one', async () => {
    const session = await serve(null);
    const result = await session.callRaw('get_commit_candidates', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('needs a componentId');
  });
});

describe('get_blast_radius', () => {
  it('answers with the components the runtime observed in the file, and what they called', async () => {
    const repo = initRepo();
    commit(repo, { 'src/Cart.tsx': 'a\n' }, 'the cart');
    const session = await serve(repo);
    await send(session, flow('flow-1'));

    const report = await session.call('get_blast_radius', { file: 'src/Cart.tsx' });
    expect(report).toContain('CartButton:12');
    expect(report).toContain('POST');
    expect(report).toContain('/api/checkout');
    expect(report).toContain('does not count files that import it');
  });

  it('gives the query a reader — it was built, tested, and reachable from nothing', async () => {
    // The point of the tool, stated as a test: before this, `getBlastRadius`
    // existed in `mcp-server/arkg.js` with no MCP tool, no UI and no caller.
    const session = await serve(null);
    expect(await session.tools()).toContain('get_blast_radius');
  });

  it('bounds by a line range when given both bounds', async () => {
    const repo = initRepo();
    commit(repo, { 'src/Cart.tsx': 'a\n' }, 'the cart');
    const session = await serve(repo);
    await send(session, flow('flow-1'));

    expect(await session.call('get_blast_radius', { file: 'src/Cart.tsx', lineStart: 1, lineEnd: 20 }))
      .toContain('CartButton');
    expect(await session.call('get_blast_radius', { file: 'src/Cart.tsx', lineStart: 90, lineEnd: 99 }))
      .toContain('resolved to a line in that range');
  });

  it('refuses one bound alone rather than answering the whole file', async () => {
    const session = await serve(null);
    const result = await session.callRaw('get_blast_radius', { file: 'src/Cart.tsx', lineStart: 40 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('lineStart and lineEnd together or neither');
  });

  it('sends a caller somewhere useful when the file is unknown to the graph', async () => {
    const session = await serve(null);
    const report = await session.call('get_blast_radius', { file: 'src/Nowhere.tsx' });
    expect(report).toContain('no source file matching src/Nowhere.tsx');
    expect(report).toContain('get_app_architecture');
  });
});
