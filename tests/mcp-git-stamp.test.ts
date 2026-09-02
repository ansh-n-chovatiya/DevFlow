/**
 * The commit stamp, from the one layer that can lose it.
 *
 * `core/git` is pure and has its own tests: `parseStatusBranch`, `readCheckout`
 * and `joinableSha` can each be handed three strings. None of that says the
 * stamp survives the journey it actually makes — `readStamp` reading a real
 * checkout, `saveFlow` copying flow-level fields **by name** into `meta.json`,
 * and `ingestFlow` writing a join key into four tables. A `git` field is
 * exactly the shape `saveFlow` drops silently, and a fixture written straight
 * into `flows/` cannot see that, because it never goes through the function
 * that would have dropped it. So every assertion here is made from what a POST
 * left on disk or in `arkg.db`, and never from a file this test wrote.
 *
 * The repository is real too, built with `execSync` per case. The thing under
 * test is a subprocess reading a working tree; a mocked `git` would test the
 * mock's idea of `--porcelain` and, in the two cases that matter most — a dirty
 * tree and a monorepo prefix — that idea is precisely what nobody should be
 * asked to reason about instead of measuring.
 *
 * Servers are spawned fresh whenever the tree changes underneath one, rather
 * than waited out: `readCheckout` in `mcp-server/git.js` memoises for five
 * seconds, so a test that commits and re-posts against the same process would
 * be asserting on a reading taken before the commit existed.
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

// ── A real repository, per test ───────────────────────────────────────────────

/**
 * `realpathSync` is not tidiness. On macOS `mkdtemp` hands back a path under
 * `/var`, which is a symlink to `/private/var`; `git rev-parse --show-toplevel`
 * answers with the resolved one, and `readCheckout` then computes a prefix that
 * climbs out of the repository and falls back to `''` — which would silently
 * turn the monorepo case below into a test of nothing.
 */
function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** An empty repository with an identity, so `git commit` has an author to name. */
function initRepo(): string {
  const dir = tempDir('devflow-repo-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@devflow.invalid');
  git(dir, 'config', 'user.name', 'DevFlow Test');
  // A machine with commit signing on globally would otherwise prompt and hang.
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/** Write the files, commit them all, and answer with the SHA git chose. */
function commit(repo: string, files: Record<string, string>, message: string): string {
  write(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** The same, without the commit — which is the whole of what "dirty" means here. */
function write(repo: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

// ── A server pointed at one ───────────────────────────────────────────────────

interface ServeOptions {
  /** Reuse a `DEVFLOW_DIR`, so a second server reads the graph the first wrote. */
  home?: string;
  env?: Record<string, string>;
}

async function serve(root: string | null, options: ServeOptions = {}): Promise<McpSession> {
  const home = options.home ?? tempDir('devflow-home-');
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  const session = await startServer({
    home,
    env: { ...(root ? { DEVFLOW_PROJECT_ROOT: root } : {}), ...options.env },
  });
  sessions.push(session);
  return session;
}

/**
 * One recording, as the extension sends it: one component with a source file,
 * one step attributed to it.
 *
 * The step's text carries the flow's id, so two flows differ in the content
 * hash `ingestFlow` keys re-sends by — otherwise the second POST would return
 * before it touched a single node and every accumulation assertion below would
 * be measuring an early return.
 */
function flow(id: string, source = 'src/Cart.tsx', extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Recording ${id}`,
    timestamp: 1_700_000_000_000,
    startUrl: 'http://localhost:5173/cart',
    schemaVersion: 1,
    react: { components: { cmp_cart: { name: 'CartButton', source, line: 12 } } },
    steps: [
      {
        type: 'click',
        url: 'http://localhost:5173/cart',
        timestamp: 1_700_000_000_000,
        action: `Clicked "Buy" during ${id}`,
        stepNumber: 1,
        element: {
          tag: 'button',
          cssSelector: '#buy',
          react: { owner: 'cmp_cart', chain: ['cmp_cart'] },
        },
        networkCalls: [],
        consoleLogs: [],
      },
    ],
    ...extra,
  };
}

async function send(session: McpSession, body: unknown): Promise<Record<string, unknown>> {
  const posted = await session.post('/flows', JSON.stringify(body));
  expect(posted.status).toBe(200);
  return JSON.parse(posted.body) as Record<string, unknown>;
}

const read = (session: McpSession, id: string, file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(session.home, 'flows', id, file), 'utf8')) as Record<
    string,
    unknown
  >;

const metaOf = (session: McpSession, id: string) => read(session, id, 'meta.json');
const flowJsonOf = (session: McpSession, id: string) => read(session, id, 'flow.json');

// ── The graph, read the way `arkg-ingest.test.ts` reads it ────────────────────

const require = createRequire(path.join(process.cwd(), 'mcp-server', 'package.json'));
type Row = Record<string, unknown>;
const Database = require('better-sqlite3') as new (file: string) => {
  prepare(sql: string): { all(...params: unknown[]): Row[] };
  close(): void;
};

/** One query against a server's `arkg.db`, opened and closed around it. */
function query(home: string, sql: string, ...params: unknown[]): Row[] {
  const db = new Database(path.join(home, 'arkg.db'));
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

const one = (home: string, sql: string, ...params: unknown[]): Row => {
  const rows = query(home, sql, ...params);
  expect(rows).toHaveLength(1);
  return rows[0];
};

describe('a recording stamped from a clean checkout', () => {
  let repo: string;
  let head: string;
  let branch: string;
  let session: McpSession;

  beforeAll(async () => {
    repo = initRepo();
    head = commit(repo, { 'src/Cart.tsx': 'export const CartButton = () => null;\n' }, 'Add the cart button');
    branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    session = await serve(repo);
    await send(session, flow('clean-a'));
  }, 30_000);

  it('carries the real HEAD into meta.json', () => {
    const meta = metaOf(session, 'clean-a');
    const stamp = meta.git as Record<string, unknown>;

    // Against the repository, not against a constant: the point of building a
    // real one is that nothing here gets to say what the answer should be.
    expect(stamp.sha).toBe(head);
    expect(stamp.short).toBe(head.slice(0, 10));
    expect(stamp.branch).toBe(branch);
    expect(stamp.subject).toBe('Add the cart button');
    expect(stamp.dirty).toBe(false);
    expect(typeof stamp.committedAt).toBe('number');
  });

  it('carries it into flow.json too, which is the copy every tool reads', () => {
    // `list_flows` reads the index and every other tool reads the recording, so
    // a stamp in one file and not the other is a stamp half the server cannot
    // see. Both are written by `saveFlow`, from one object, by name.
    expect(flowJsonOf(session, 'clean-a').git).toEqual(metaOf(session, 'clean-a').git);
  });

  it('writes the same commit into the graph as a join key', () => {
    const home = session.home;
    expect(one(home, 'SELECT git_sha FROM arkg_components').git_sha).toBe(head);
    expect(one(home, 'SELECT git_sha FROM arkg_source_files').git_sha).toBe(head);
    expect(one(home, 'SELECT git_sha FROM arkg_named_flows').git_sha).toBe(head);
    expect(one(home, "SELECT git_sha FROM arkg_edges WHERE type = 'maps_to'").git_sha).toBe(head);
  });
});

describe('a recording made on a dirty working tree', () => {
  /*
   * The case the whole join-key rule exists for.
   *
   * `meta.json` keeps the whole truth — the SHA is still the most useful anchor
   * a developer has, and `dirty: true` beside it is what stops it being read as
   * a build — while the graph's `git_sha` columns stay empty, because a bare
   * column has no room beside it to carry the caveat and anything joining on it
   * would be told this node was seen at a commit it was not.
   */
  let repo: string;
  let head: string;
  let session: McpSession;

  beforeAll(async () => {
    repo = initRepo();
    head = commit(repo, { 'src/Cart.tsx': 'v1\n' }, 'Add the cart button');
    write(repo, { 'src/Cart.tsx': 'v1, plus an edit nobody has committed\n' });
    session = await serve(repo);
    await send(session, flow('dirty-a'));
  }, 30_000);

  it('still records the SHA on the flow, and says the tree was dirty', () => {
    const stamp = metaOf(session, 'dirty-a').git as Record<string, unknown>;
    expect(stamp.sha).toBe(head);
    expect(stamp.dirty).toBe(true);
    expect(flowJsonOf(session, 'dirty-a').git).toEqual(stamp);
  });

  it('writes no join key anywhere in the graph', () => {
    const home = session.home;

    // Asserted against a graph that is not empty, so a NULL here is the rule
    // working rather than an ingest that never happened.
    expect(one(home, 'SELECT id, git_sha FROM arkg_components').git_sha).toBeNull();
    expect(one(home, 'SELECT id, git_sha FROM arkg_source_files').git_sha).toBeNull();
    expect(one(home, 'SELECT id, git_sha FROM arkg_named_flows').git_sha).toBeNull();

    const edges = query(home, "SELECT type, git_sha FROM arkg_edges WHERE type <> 'changed_in'");
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) expect(edge.git_sha).toBeNull();
  });

  it('still knows the commit itself, which the dirt does not make untrue', () => {
    // The commit node is not a join key on an observation — it is a fact about
    // the repository — so it is written whatever the working tree looks like.
    expect(one(session.home, 'SELECT id FROM arkg_git_commits').id).toBe(head);
  });
});

describe('git_sha means the last commit a node was observed clean at', () => {
  it('is not erased by a later recording made on a dirty tree', async () => {
    const repo = initRepo();
    const first = commit(repo, { 'src/Cart.tsx': 'v1\n' }, 'First');
    const home = tempDir('devflow-home-');

    const clean = await serve(repo, { home });
    await send(clean, flow('coalesce-clean'));
    expect(one(home, 'SELECT git_sha FROM arkg_components').git_sha).toBe(first);
    clean.stop();

    // A fresh process rather than a wait: the checkout reading is memoised for
    // five seconds, and this changes the tree under it.
    write(repo, { 'src/Cart.tsx': 'v1, edited\n' });
    const dirty = await serve(repo, { home });
    await send(dirty, flow('coalesce-dirty'));
    dirty.stop();

    const component = one(home, 'SELECT git_sha, frequency FROM arkg_components');
    // The second ingest reached the row — so the SHA surviving is COALESCE
    // keeping a commit that was true, not an update that never ran.
    expect(component.frequency).toBe(2);
    expect(component.git_sha).toBe(first);
  }, 40_000);

  it('is replaced by a later clean recording at a newer commit', async () => {
    /*
     * The COALESCE on `git_sha` runs new-over-old, and the one on `source_file`
     * beside it runs old-over-new. That is deliberate and it is the pair most
     * likely to be "tidied" into agreement: a component keeps the file it
     * learned because a later sighting that lost the path learned nothing, and
     * takes the newer commit because the column's whole meaning is *last*
     * observed clean.
     */
    const repo = initRepo();
    const first = commit(repo, { 'src/Cart.tsx': 'v1\n' }, 'First');
    const home = tempDir('devflow-home-');

    const before = await serve(repo, { home });
    await send(before, flow('at-first'));
    before.stop();

    const second = commit(repo, { 'src/Cart.tsx': 'v2\n' }, 'Second');
    expect(second).not.toBe(first);

    const after = await serve(repo, { home });
    await send(after, flow('at-second'));
    after.stop();

    const component = one(home, 'SELECT git_sha, source_file, frequency FROM arkg_components');
    expect(component.frequency).toBe(2);
    expect(component.git_sha).toBe(second);
    expect(component.source_file).toBe('src/Cart.tsx');

    // Each flow keeps the commit it arrived at — a flow node is one recording,
    // and it was made once.
    expect(one(home, 'SELECT git_sha FROM arkg_named_flows WHERE id = ?', 'at-first').git_sha).toBe(first);
    expect(one(home, 'SELECT git_sha FROM arkg_named_flows WHERE id = ?', 'at-second').git_sha).toBe(second);
  }, 40_000);
});

describe('the commit node and the files it changed', () => {
  let repo: string;
  let head: string;
  let session: McpSession;
  let home: string;

  beforeAll(async () => {
    repo = initRepo();
    // One commit, two files. Only one of them is ever recorded.
    head = commit(
      repo,
      { 'src/Cart.tsx': 'v1\n', 'src/Ghost.tsx': 'v1\n' },
      'Touch the cart and something nobody records',
    );
    session = await serve(repo);
    home = session.home;
    await send(session, flow('commit-a'));
  }, 30_000);

  it('records the commit with its short sha, subject and author', () => {
    const row = one(home, 'SELECT * FROM arkg_git_commits');
    expect(row.id).toBe(head);
    expect(row.short_sha).toBe(head.slice(0, 10));
    expect(row.subject).toBe('Touch the cart and something nobody records');
    expect(row.author).toBe('DevFlow Test');
    expect(Number(row.committed_at)).toBeGreaterThan(0);
  });

  it('draws changed_in only for a file the graph already knows', () => {
    /*
     * Both ends must land on a node the graph already keys. `src/Ghost.tsx` was
     * in the same commit and no recording has ever mentioned it, so there is no
     * node to draw to — and inventing one would be claiming a commit changed a
     * file nobody has observed running.
     */
    const edge = one(home, "SELECT * FROM arkg_edges WHERE type = 'changed_in'");
    expect(edge.from_node_type).toBe('source_file');
    expect(edge.from_node_id).toBe('src/Cart.tsx');
    expect(edge.to_node_type).toBe('git_commit');
    expect(edge.to_node_id).toBe(head);

    expect(query(home, 'SELECT id FROM arkg_source_files')).toHaveLength(1);
  });

  it('does not accumulate on a second recording made at the same commit', async () => {
    /*
     * `insertFactEdge` against `upsertEdge`. A commit changed a file once, in
     * the past, and will not do it again — so `frequency` on a `changed_in`
     * edge counting the recordings made at that commit would be filing how
     * often somebody pressed Send as a fact about the repository. Every
     * ordinary edge beside it must go on counting, which is the half that says
     * this is a distinction and not a broken write.
     */
    expect(one(home, "SELECT frequency FROM arkg_edges WHERE type = 'maps_to'").frequency).toBe(1);

    await send(session, flow('commit-b'));

    const changed = one(home, "SELECT frequency FROM arkg_edges WHERE type = 'changed_in'");
    expect(changed.frequency).toBe(1);
    expect(one(home, "SELECT frequency FROM arkg_edges WHERE type = 'maps_to'").frequency).toBe(2);
  }, 30_000);
});

describe('a project root inside a larger repository', () => {
  it('still joins the commit to the file, through the prefix', async () => {
    /*
     * Git prints `packages/web/src/Cart.tsx` and a source map says
     * `src/Cart.tsx`. Without `prefix` the two never meet — in the shape most
     * likely to have an edge worth drawing.
     */
    const repo = initRepo();
    const head = commit(
      repo,
      { 'packages/web/src/Cart.tsx': 'v1\n', 'packages/api/src/routes.ts': 'v1\n' },
      'Ship the web cart and an API route',
    );
    const project = path.join(repo, 'packages', 'web');
    const session = await serve(project);
    await send(session, flow('mono-a'));

    const stamp = metaOf(session, 'mono-a').git as Record<string, unknown>;
    expect(stamp.sha).toBe(head);
    expect(stamp.dirty).toBe(false);

    const edge = one(session.home, "SELECT * FROM arkg_edges WHERE type = 'changed_in'");
    expect(edge.from_node_id).toBe('src/Cart.tsx');
    expect(edge.to_node_id).toBe(head);
    // The sibling package is outside the project and projects to nothing, which
    // is the other half of the prefix doing its job.
    expect(query(session.home, 'SELECT id FROM arkg_source_files')).toHaveLength(1);
  }, 30_000);
});

describe('nothing about git may fail a recording', () => {
  /** The flow saved, is readable, and simply has no commit on it. */
  async function savesWithoutAStamp(session: McpSession, id: string): Promise<void> {
    await send(session, flow(id));
    expect(metaOf(session, id).git).toBeUndefined();
    expect(flowJsonOf(session, id).git).toBeUndefined();
    expect(await session.call('list_flows', {})).toContain(`Recording ${id}`);
  }

  it('saves a flow when the project root is not a repository', async () => {
    const session = await serve(tempDir('devflow-plain-'));
    await savesWithoutAStamp(session, 'no-repo');
    expect(session.stderr()).toContain('no commit stamp (not-a-repo)');
  }, 30_000);

  it('saves a flow in a repository nobody has committed to', async () => {
    const empty = initRepo();
    write(empty, { 'src/Cart.tsx': 'v1\n' });
    const session = await serve(empty);
    await savesWithoutAStamp(session, 'no-commits');
    expect(session.stderr()).toContain('no commit stamp (no-commits)');
  }, 30_000);

  it('saves a flow with DEVFLOW_GIT=0, and runs no git at all', async () => {
    // The inverse of `replay.js`'s switch: reading a repository is the default
    // and opting out is the deliberate act. Opting out costs the stamp and
    // nothing else.
    const repo = initRepo();
    commit(repo, { 'src/Cart.tsx': 'v1\n' }, 'Add the cart button');
    const session = await serve(repo, { env: { DEVFLOW_GIT: '0' } });
    await savesWithoutAStamp(session, 'git-off');

    expect(session.stderr()).toContain('no commit stamp (off)');
    expect(query(session.home, 'SELECT id FROM arkg_git_commits')).toHaveLength(0);
    expect(one(session.home, 'SELECT git_sha FROM arkg_components').git_sha).toBeNull();
  }, 30_000);
});

describe('a payload that claims a commit of its own', () => {
  it('is stamped by the server and not by the sender', async () => {
    /*
     * The extension has no filesystem and no repository, so a `git` field on
     * the wire describes a checkout the page cannot see. `saveFlow` reads only
     * the fields it names, and this is the assertion that keeps it that way:
     * the stored stamp is the repository's, and the payload's is nowhere.
     */
    const repo = initRepo();
    const head = commit(repo, { 'src/Cart.tsx': 'v1\n' }, 'Add the cart button');
    const session = await serve(repo);

    const lie = {
      sha: 'f'.repeat(40),
      short: 'ffffffffff',
      branch: 'from-the-page',
      dirty: true,
      subject: 'a commit the browser invented',
      committedAt: 1,
    };
    await send(session, flow('lying-page', 'src/Cart.tsx', { git: lie }));

    const stamp = metaOf(session, 'lying-page').git as Record<string, unknown>;
    expect(stamp.sha).toBe(head);
    expect(stamp.branch).not.toBe('from-the-page');
    expect(stamp.subject).toBe('Add the cart button');
    expect(stamp.dirty).toBe(false);
    expect(flowJsonOf(session, 'lying-page').git).toEqual(stamp);

    // And the graph joined on the real one, not on forty f's.
    expect(one(session.home, 'SELECT git_sha FROM arkg_named_flows').git_sha).toBe(head);
    expect(one(session.home, 'SELECT git_sha FROM arkg_components').git_sha).toBe(head);
  }, 30_000);
});

describe('the same recording sent again, at a newer commit', () => {
  /*
   * A re-send is not a second observation of the application, and the commit
   * stamp is evidence rather than bookkeeping — so it moves only when the
   * evidence does.
   *
   * This shipped wrong once and the shape is worth keeping on the record. The
   * flow node is refreshed on *every* send, so that a recording renamed in the
   * viewer updates, and `git_sha` rode along inside that refresh. A
   * byte-identical recording POSTed again a week later therefore relabelled the
   * flow with today's commit while every component and source file inside it
   * kept the one it was actually recorded at — and the two columns then
   * disagreed about a single observation, precisely on the cross the column
   * exists for: the component read as last seen *before* a change that its own
   * flow now claimed to be after.
   */
  let repo: string;
  let first: string;
  let second: string;
  let home: string;

  beforeAll(async () => {
    repo = initRepo();
    first = commit(repo, { 'src/Cart.tsx': 'v1\n' }, 'the first build');

    const before = await serve(repo);
    home = before.home;
    await send(before, flow('resend'));
    before.stop();

    second = commit(repo, { 'src/Cart.tsx': 'v2\n' }, 'the second build');

    // A fresh server rather than a wait: `readCheckout` memoises for five
    // seconds, so the running one would answer with the commit it read first.
    const after = await serve(repo, { home });
    await send(after, flow('resend'));
  }, 30_000);

  it('leaves every commit column where the recording actually put it', () => {
    expect(one(home, 'SELECT git_sha FROM arkg_named_flows').git_sha).toBe(first);
    expect(one(home, 'SELECT git_sha FROM arkg_components').git_sha).toBe(first);
    expect(one(home, 'SELECT git_sha FROM arkg_source_files').git_sha).toBe(first);
  });

  it('files no commit node for a commit it observed nothing at', () => {
    // Every `git_sha` in the graph has a `git_commits` row to point at, and
    // this is the other half of that: a commit nothing was stamped with does
    // not get one. A node for the second build here would be the graph claiming
    // to have watched something run at a commit that had not existed when the
    // recording was made.
    const shas = query(home, 'SELECT id FROM arkg_git_commits').map((row) => row.id);
    expect(shas).not.toContain(second);
    expect(shas).toEqual([first]);
  });

  it('counts the re-send once, as it always did', () => {
    expect(one(home, 'SELECT frequency FROM arkg_components').frequency).toBe(1);
  });
});

describe('a changed recording sent at a newer commit', () => {
  /*
   * The other side of the rule above, and the reason it cannot simply be "never
   * move the stamp": genuinely new evidence at a newer build is exactly what
   * the column is for, and a rule that froze the first commit forever would
   * make every node permanently stale.
   */
  let repo: string;
  let first: string;
  let second: string;
  let home: string;

  beforeAll(async () => {
    repo = initRepo();
    first = commit(repo, { 'src/Cart.tsx': 'v1\n' }, 'the first build');

    const before = await serve(repo);
    home = before.home;
    await send(before, flow('changed'));
    before.stop();

    second = commit(repo, { 'src/Cart.tsx': 'v2\n' }, 'the second build');

    const after = await serve(repo, { home });
    // A different id is a different content hash, which is what makes this new
    // evidence rather than a re-send.
    await send(after, flow('changed-again'));
  }, 30_000);

  it('moves the component to the newer commit, because that is when it was last seen clean', () => {
    expect(one(home, 'SELECT git_sha FROM arkg_components').git_sha).toBe(second);
  });

  it('files the newer commit as a node, so the stamp has something to point at', () => {
    const shas = query(home, 'SELECT id FROM arkg_git_commits ORDER BY committed_at').map((r) => r.id);
    expect(shas).toEqual([first, second]);
  });
});

describe('every surface that prints the commit', () => {
  /*
   * **Count the renderers.** A field one tool prints is a field about that
   * tool, and this project has been bitten by exactly that before —
   * `sourceProvenance` was written to hold wherever a model reads a component
   * and held in one of three places.
   *
   * The commit has four surfaces, and each is here because it fails
   * differently: `list_flows` returns whole metas so it came free and could be
   * lost by a future projection; `get_flow` is the primary tool; `flow.md` is
   * the file on disk, whose own comment promises it and the walkthrough
   * describe one recording one way; and `compare_flows_across_deploys` has its
   * own suite. `get_flow_summary` is deliberately *not* here — its whole budget
   * answers "did this break", and a commit does not help with that.
   */
  let repo: string;
  let head: string;
  let session: McpSession;

  beforeAll(async () => {
    repo = initRepo();
    head = commit(repo, { 'src/Cart.tsx': 'v1\n' }, 'Add the cart button');
    session = await serve(repo);
    await send(session, flow('surfaces'));
  }, 30_000);

  it('names it in the walkthrough header', async () => {
    const walkthrough = await session.call('get_flow', { id: 'surfaces' });
    expect(walkthrough).toContain(`**Recorded at:** ${head.slice(0, 10)}`);
    expect(walkthrough).toContain('Add the cart button');
  });

  it('names it in flow.md, which the walkthrough must not disagree with', () => {
    const onDisk = fs.readFileSync(path.join(session.home, 'flows', 'surfaces', 'flow.md'), 'utf8');
    expect(onDisk).toContain(`Recorded at ${head.slice(0, 10)}`);
  });

  it('carries it through list_flows, which is where two builds are chosen', async () => {
    const listed = await session.call('list_flows', {});
    expect(listed).toContain(head);
  });

  /*
   * The caveat travels with the commit or the commit is worse than nothing: a
   * stamp read as "the build that was running" is actively wrong when the page
   * came off a host this machine does not serve, which is every recording made
   * against a deployed environment.
   */
  it('warns, on a recording this machine did not serve, that the commit is not that build', async () => {
    await send(
      session,
      flow('remote-page', 'src/Cart.tsx', { startUrl: 'https://staging.example.com/cart' }),
    );

    const walkthrough = await session.call('get_flow', { id: 'remote-page' });
    expect(walkthrough).toContain('a page this machine did not serve');
  });

  it('says nothing of the sort about a recording of localhost', async () => {
    const walkthrough = await session.call('get_flow', { id: 'surfaces' });
    expect(walkthrough).not.toContain('did not serve');
  });
});
