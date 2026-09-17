/**
 * Two saves of one recording, an aged-out store, and a contended graph.
 *
 * `report.md` §3.4 P1: each of `flow.json`, `flow.md` and `meta.json` is
 * written atomically, and nothing serialised two `saveFlow` calls sharing an
 * `id` — which the extension produces by design, not by accident. Stopping a
 * recording fires an auto-export that is deliberately not awaited
 * (`void autoExportToMcp(steps)`), while the review tab's **Send** reuses the
 * same id so that sending is an update rather than a second copy. Driven
 * against the real server at HEAD, twelve rounds of that pair produced twelve
 * broken flows: `flow.json` from one send beside `meta.json` from the other,
 * unparseable `flow.json`, and 500s from a `rename` of a temp path the other
 * request had already moved — the two saves share `flow.json.tmp`.
 *
 * §3.4 P2, §3.2 P2 and §3.2 P2 are the other three: no `busy_timeout` on the
 * ARKG connection, no age-based retention, and no server-side redaction to
 * back up the extension's own pass. All four are receiver behaviour, so all
 * four are asserted here the only way that proves anything about a standalone
 * script — over a real HTTP request to a real spawned server, reading what
 * actually landed on the disk it was pointed at.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

const SERVER_SOURCE = fs.readFileSync(
  fileURLToPath(new URL('../mcp-server/server.js', import.meta.url)),
  'utf8',
);

const sessions: McpSession[] = [];

afterAll(() => {
  for (const session of sessions) {
    session.stop();
    fs.rmSync(session.home, { recursive: true, force: true });
  }
});

async function server(env?: Record<string, string>): Promise<McpSession> {
  const session = await startServer(env ? { env } : {});
  sessions.push(session);
  return session;
}

interface Call {
  url: string;
  method: string;
  status: number;
  requestBody?: string;
  responseBody?: string;
}

function step(n: number, calls: Call[] = []): Record<string, unknown> {
  return {
    index: n,
    action: 'click',
    url: 'https://example.test/checkout',
    selector: `#button-${n}`,
    text: `Step ${n}`,
    networkCalls: calls,
  };
}

/** A recording of `steps` steps, padded so a save is not instantaneous. */
function flow(id: string, steps: number, name: string): Record<string, unknown> {
  return {
    id,
    name,
    timestamp: Date.now(),
    steps: Array.from({ length: steps }, (_, i) =>
      step(i + 1, [
        {
          url: 'https://api.example.test/cart',
          method: 'POST',
          status: 200,
          requestBody: JSON.stringify({ item: i, padding: 'x'.repeat(400) }),
        },
      ]),
    ),
  };
}

function onDisk(home: string, id: string): { json: Record<string, unknown>; meta: Record<string, unknown> } {
  const dir = path.join(home, 'flows', id);
  return {
    json: JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8')),
    meta: JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')),
  };
}

describe('two saves of one flow id', () => {
  it('leaves flow.json and meta.json describing the same recording', async () => {
    const session = await server();

    /*
     * The race as the extension makes it, not a hypothetical one: a thirty-step
     * auto-export in flight while a two-step Send reuses its id. Repeated,
     * because a lock that works by luck would pass once — at HEAD every one of
     * these rounds failed, most of them by leaving `flow.json` unparseable.
     */
    for (let round = 0; round < 6; round++) {
      const id = `same-id-${round}`;
      const [auto, send] = await Promise.all([
        session.post('/flows', JSON.stringify(flow(id, 30, 'auto-export on stop'))),
        session.post('/flows', JSON.stringify(flow(id, 2, 'explicit Send'))),
      ]);

      // Neither request may be told the save failed: at HEAD one of the two
      // renamed a temp file the other had already moved and answered 500.
      expect([auto.status, send.status]).toEqual([200, 200]);

      const { json, meta } = onDisk(session.home, id);

      // The assertion the audit named: one recording, described once. Whichever
      // of the two won, `list_flows`' step count is the one `get_flow` returns.
      expect(meta.stepCount).toBe((json.steps as unknown[]).length);
      expect(meta.name).toBe(json.name);
      expect([2, 30]).toContain(meta.stepCount);

      // And the walkthrough is the same recording's — a third file that could
      // have been won by the loser.
      const markdown = fs.readFileSync(path.join(session.home, 'flows', id, 'flow.md'), 'utf8');
      expect(markdown).toContain(String(json.name));
    }
  }, 60_000);

  it('is keyed on the flow id, so two recordings still save concurrently', async () => {
    const session = await server();

    /*
     * The shared resource is one directory — one `flow.json`, one `flow.md`,
     * one `meta.json`, and one `flow.json.tmp` — so the wait is per id. A lock
     * over `saveFlow` itself would serialise a recording behind megabytes of
     * somebody else's screenshots for nothing, which is why the key is asserted
     * at the call site as well as demonstrated below.
     */
    expect(SERVER_SOURCE).toMatch(/withFlowLock\(flow\.id,/);

    const ids = ['a-id', 'b-id', 'c-id', 'd-id'];
    const responses = await Promise.all(
      ids.map((id) => session.post('/flows', JSON.stringify(flow(id, 8, id)))),
    );

    for (const [i, response] of responses.entries()) {
      expect(response.status).toBe(200);
      const { json, meta } = onDisk(session.home, ids[i]);
      expect(meta.name).toBe(ids[i]);
      expect(meta.stepCount).toBe((json.steps as unknown[]).length);
    }
  }, 30_000);

  it('leaves an uncontended save exactly what it was — one request, one answer, one flow', async () => {
    const session = await server();

    const sent = flow('solo-id', 3, 'uncontended');
    const response = await session.post('/flows', JSON.stringify(sent));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, id: 'solo-id', name: 'uncontended' });

    const { json, meta } = onDisk(session.home, 'solo-id');
    expect(meta).toMatchObject({ id: 'solo-id', name: 'uncontended', stepCount: 3, errorCount: 0 });
    expect((json.steps as unknown[]).length).toBe(3);

    // Readable through the tool surface as well as on disk: nothing about the
    // save is deferred past the response the extension was given.
    const read = await session.call('get_flow', { id: 'solo-id' });
    expect(read).toContain('uncontended');
  }, 30_000);
});

describe('server-side secret scan', () => {
  it('masks secret-shaped bodies before they reach flow.json', async () => {
    const session = await server();

    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const sessionToken = 'sTok_live_9f8e7d6c5b4a3210';

    /*
     * Posted the way a process that never ran the extension's own pass would
     * post it — which is the whole point of the backstop. Small enough that
     * `compactBody` would have quoted it verbatim on the way out, and a failed
     * call so the diagnostic path is in play too.
     */
    await session.post(
      '/flows',
      JSON.stringify({
        id: 'secrets-id',
        name: 'raw bodies',
        timestamp: Date.now(),
        steps: [
          step(1, [
            {
              url: 'https://api.example.test/login',
              method: 'POST',
              status: 200,
              requestBody: `Authorization: Bearer ${jwt}`,
              responseBody: JSON.stringify({ session_token: sessionToken, user: 'ada' }),
            },
            {
              url: 'https://api.example.test/refresh',
              method: 'POST',
              status: 401,
              responseBody: JSON.stringify({ attempted_token: sessionToken, error: 'expired' }),
            },
          ]),
        ],
      }),
    );

    const stored = fs.readFileSync(path.join(session.home, 'flows', 'secrets-id', 'flow.json'), 'utf8');
    expect(stored).not.toContain(jwt);
    expect(stored).not.toContain(sessionToken);
    expect(stored).toContain('[redacted]');

    // Defence in depth, not a shredder: everything that was not secret-shaped
    // is still on disk, or the backstop would cost the reader the body.
    expect(stored).toContain('ada');
    expect(stored).toContain('expired');
  }, 30_000);
});

describe('age-based retention', () => {
  /** A flow written straight onto disk, dated. */
  function aged(home: string, id: string, daysAgo: number): string {
    return writeFlow(home, {
      id,
      name: id,
      timestamp: Date.now() - daysAgo * 24 * 60 * 60 * 1000,
      steps: [],
    });
  }

  it('evicts a flow older than the TTL even when the store is far inside every cap', async () => {
    const session = await server({ DEVFLOW_MAX_FLOW_AGE_DAYS: '7' });

    const old = aged(session.home, 'ancient', 40);
    const recent = aged(session.home, 'yesterday', 1);

    // Three flows and a few kilobytes: nowhere near `mcp.maxFlows`=200 or
    // `mcp.maxFlowBytes`=2GiB, which is the state the finding is about.
    const response = await session.post('/flows', JSON.stringify(flow('fresh', 2, 'fresh')));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).evicted).toEqual(['ancient']);

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(path.join(session.home, 'flows', 'fresh'))).toBe(true);
  }, 30_000);

  it('is off unless asked for — an old flow on an install that never set it stays', async () => {
    const session = await server();

    const old = aged(session.home, 'ancient', 400);
    const response = await session.post('/flows', JSON.stringify(flow('fresh', 2, 'fresh')));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).evicted).toBeUndefined();
    expect(fs.existsSync(old)).toBe(true);
  }, 30_000);
});

// ── The knowledge graph under a second process ───────────────────────────────

const require = createRequire(fileURLToPath(new URL('../mcp-server/package.json', import.meta.url)));

/** `better-sqlite3` resolves from `mcp-server/node_modules`, or this is skipped. */
function sqlite(): string | null {
  try {
    return require.resolve('better-sqlite3');
  } catch {
    return null;
  }
}

/**
 * A second process holding the database's write lock for `ms`, already held by
 * the time this resolves.
 *
 * A second *process* rather than a second connection, because that is the only
 * way to reproduce what the timeout is for: better-sqlite3 is synchronous, so a
 * holder inside this process could never release the lock while the waiter is
 * waiting for it.
 */
async function holdWriteLock(module: string, file: string, ms: number): Promise<() => void> {
  const holder = spawn(
    'node',
    [
      '-e',
      `const D = require(${JSON.stringify(module)});
       const db = new D(${JSON.stringify(file)});
       db.exec('BEGIN IMMEDIATE');
       db.exec('CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER PRIMARY KEY)');
       db.prepare('INSERT INTO lock_probe (id) VALUES (1)').run();
       process.stdout.write('held\\n');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});
       db.exec('COMMIT');
       db.close();`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );

  await new Promise<void>((resolve) => {
    holder.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('held')) resolve();
    });
  });

  return () => holder.kill();
}

describe('ARKG under a second concurrent process', () => {
  it('sets busy_timeout on the connection it opens', () => {
    // The pragma is set where the handle is, so a graph that fails to open is
    // still one `log` line and no graph — never a server that will not start.
    expect(SERVER_SOURCE).toMatch(/openArkg\(ARKG_DB\)/);
    expect(SERVER_SOURCE).toMatch(/pragma\?\.\(`busy_timeout = \$\{ARKG_BUSY_TIMEOUT_MS\}`\)/);

    const declared = SERVER_SOURCE.match(/const ARKG_BUSY_TIMEOUT_MS = (\d+);/);
    expect(declared).not.toBeNull();
    const ms = Number(declared?.[1]);
    // A few seconds: long enough that a transaction's worth of contention is
    // never dropped, short enough that a stuck process cannot hold a tool call.
    expect(ms).toBeGreaterThanOrEqual(2000);
    expect(ms).toBeLessThanOrEqual(30_000);
  });

  it('waits out a lock another process holds instead of failing at once', async () => {
    const module = sqlite();
    if (!module) return; // No native addon on this machine — the server has no graph either.

    const Database = require('better-sqlite3') as new (file: string) => {
      exec(sql: string): void;
      pragma(sql: string): void;
      prepare(sql: string): { run(...args: unknown[]): void };
      close(): void;
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-busy-'));
    const file = path.join(dir, 'arkg.db');
    const seed = new Database(file);
    seed.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
    seed.close();

    const release = await holdWriteLock(module, file, 500);
    const ms = Number(SERVER_SOURCE.match(/const ARKG_BUSY_TIMEOUT_MS = (\d+);/)?.[1]);

    const impatient = new Database(file);
    impatient.pragma('busy_timeout = 0');
    expect(() => impatient.prepare('INSERT INTO t (v) VALUES (?)').run('no wait')).toThrow(
      /database is locked/,
    );
    impatient.close();

    // The same write, on a connection configured the way the server configures
    // its own: the collision is transient, so it is waited out rather than
    // reported as a graph that could not be written to.
    const patient = new Database(file);
    patient.pragma(`busy_timeout = ${ms}`);
    expect(() => patient.prepare('INSERT INTO t (v) VALUES (?)').run('waited')).not.toThrow();
    patient.close();

    release();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('ingests a posted flow while another process holds the graph lock', async () => {
    const module = sqlite();
    if (!module) return;

    const session = await server();
    if (session.stderr().includes('no knowledge graph')) return;

    const release = await holdWriteLock(module, path.join(session.home, 'arkg.db'), 600);

    const before = session.stderr().length;
    const response = await session.post('/flows', JSON.stringify(flow('contended', 1, 'contended')));
    release();

    expect(response.status).toBe(200);

    /*
     * The line this is about. `arkgTry` catches `SQLITE_BUSY` and falls back
     * cleanly, so at HEAD the save "succeeded" and the recording was never in
     * the graph — announced only as one line of stderr nobody reads, 27ms after
     * a lock that was released 600ms later.
     */
    expect(session.stderr().slice(before)).not.toMatch(/ingest failed \(database is locked\)/);
  }, 30_000);
});
