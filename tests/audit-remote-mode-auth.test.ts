/**
 * `MCP_MODE=remote` binds `0.0.0.0`, and until this file nothing asked the
 * caller who they were.
 *
 * The Origin rule unit 01 tightened is the right boundary locally — a loopback
 * port is reachable from any page the user has open, and only the extension may
 * write. It is not a boundary at all over a network: a header is one line of
 * `curl` for anyone who can route to the host, and `GET /mcp` — the entire tool
 * surface, every flow, every body, every screenshot — never had even that much.
 * So remote mode gains a shared secret, `MCP_API_KEY`, checked *in addition to*
 * the Origin rule rather than instead of it.
 *
 * Three claims are worth a test each and all three are asserted below:
 *
 *   - with a key configured, every route that reads or writes recordings
 *     refuses a caller who does not present it;
 *   - the key is additive — presenting it does not buy past the Origin rule;
 *   - local mode is untouched, `MCP_API_KEY` set or not, because the boundary
 *     there is loopback plus Origin and a second thing to get right would only
 *     break sending.
 *
 * Driven against real spawned servers over real sockets, for the reason
 * `helpers/mcp-server.ts` gives: this guard has no typecheck over it and its
 * failure is invisible from anywhere but a live request. The remote harness is
 * a trimmed copy of `mcp-remote.test.ts`'s — that one needs a whole SSE client
 * to call a tool; this one only needs the status code of the first response.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, startServer, type McpSession } from './helpers/mcp-server.js';

const SERVER = fileURLToPath(new URL('../mcp-server/server.js', import.meta.url));

const KEY = 'test-key-1a2b3c4d5e6f';
const EXTENSION_ORIGIN = 'chrome-extension://test';

interface RemoteServer {
  readonly port: number;
  readonly home: string;
  /** Everything the process has written to stderr so far. */
  stderr(): string;
  stop(): void;
}

const remotes: RemoteServer[] = [];

/**
 * A server in remote mode, up and answering `/health`.
 *
 * `/health` is the readiness probe precisely because it is the one route with
 * no key check — a test that had to authenticate to find out whether the
 * process was listening could not then assert that authentication is required.
 */
async function startRemote(env: Record<string, string> = {}): Promise<RemoteServer> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-remote-auth-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  const port = await freePort();

  const child: ChildProcessWithoutNullStreams = spawn('node', [SERVER], {
    env: { ...process.env, MCP_MODE: 'remote', PORT: String(port), DEVFLOW_DIR: home, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });

  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`The remote server exited with ${child.exitCode}.\n${errors || '(nothing on stderr)'}`);
    }
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`The remote server never answered.\n${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const server: RemoteServer = {
    port,
    home,
    stderr: () => errors,
    stop: () => child.kill(),
  };
  remotes.push(server);
  return server;
}

interface Reply {
  status: number;
  body: string;
}

/** One request, with full control over which headers are sent — including none. */
async function request(
  port: number,
  method: string,
  route: string,
  options: { body?: string; origin?: string; key?: string; header?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.origin !== undefined) headers.Origin = options.origin;
  if (options.key !== undefined) {
    headers[options.header ?? 'Authorization'] =
      (options.header ?? 'Authorization') === 'Authorization' ? `Bearer ${options.key}` : options.key;
  }
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers,
    body: options.body,
  });
  return { status: response.status, body: await response.text() };
}

/** A flow small enough that only `id`/`steps` — the fields the route checks — matter. */
function flow(id: string) {
  return { id, name: 'Remote key check', timestamp: Date.now(), steps: [] };
}

/** A minimal reading `buildArchitecture` accepts, matching `architecture.test.ts`'s fixture. */
const architectureReading = {
  url: 'https://app.example.com/cart',
  title: 'Cart',
  takenAt: Date.now(),
  roots: 1,
  capped: false,
  components: [{ id: 'app', name: 'App', instances: 1, depth: 0, reads: [] }],
  contexts: [],
};

/** Every route a recording can be written or deleted through. */
const writeRoutes: {
  name: string;
  method: string;
  route: (id: string) => string;
  body: (id: string) => string | undefined;
}[] = [
  { name: 'POST /flows', method: 'POST', route: () => '/flows', body: (id) => JSON.stringify(flow(id)) },
  {
    name: 'POST /arkg/ingest-component (the component-pick route)',
    method: 'POST',
    route: () => '/arkg/ingest-component',
    body: () => JSON.stringify({ name: 'KeyCheckComponent' }),
  },
  {
    name: 'POST /architecture',
    method: 'POST',
    route: () => '/architecture',
    body: () => JSON.stringify(architectureReading),
  },
  { name: 'DELETE /flows/:id', method: 'DELETE', route: (id) => `/flows/${id}`, body: () => undefined },
];

afterAll(() => {
  for (const server of remotes) {
    server.stop();
    fs.rmSync(server.home, { recursive: true, force: true });
  }
});

describe('a remote server started with MCP_API_KEY', () => {
  let server: RemoteServer;

  beforeAll(async () => {
    server = await startRemote({ MCP_API_KEY: KEY });
  }, 30_000);

  it('says it is authenticated, on the one route that needs no key to ask', async () => {
    const reply = await request(server.port, 'GET', '/health');

    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ mode: 'remote', auth: 'api-key' });
  });

  describe('GET /mcp — the SSE session, which is the whole tool surface', () => {
    it('refuses a caller presenting no key at all', async () => {
      const reply = await request(server.port, 'GET', '/mcp');

      expect(reply.status).toBe(401);
      expect(reply.body).toContain('MCP_API_KEY');
    });

    it('refuses a caller presenting the wrong key', async () => {
      const reply = await request(server.port, 'GET', '/mcp', { key: `${KEY}-nope` });

      expect(reply.status).toBe(401);
    });

    /*
     * A wrong key of a different length must be refused by the same path as a
     * wrong key of the right length — the digest comparison exists so the
     * length of the secret is not readable from the shape of the failure.
     */
    it('refuses a key of a different length identically, leaking nothing about the real one', async () => {
      const reply = await request(server.port, 'GET', '/mcp', { key: 'x' });

      expect(reply.status).toBe(401);
    });
  });

  it('accepts the key in X-DevFlow-Key too, for a caller that cannot set Authorization', async () => {
    const reply = await request(server.port, 'POST', '/flows', {
      body: JSON.stringify(flow('remote-header-variant')),
      origin: EXTENSION_ORIGIN,
      key: KEY,
      header: 'X-DevFlow-Key',
    });

    expect(reply.status).toBe(200);
  });

  describe.each(writeRoutes)('$name', ({ method, route, body }) => {
    it('refuses a request carrying no key, even with the extension’s own Origin', async () => {
      const id = 'remote-no-key';
      const reply = await request(server.port, method, route(id), {
        body: body(id),
        origin: EXTENSION_ORIGIN,
      });

      expect(reply.status).toBe(401);
    });

    it('refuses a request carrying the wrong key', async () => {
      const id = 'remote-wrong-key';
      const reply = await request(server.port, method, route(id), {
        body: body(id),
        origin: EXTENSION_ORIGIN,
        key: 'not-the-key',
      });

      expect(reply.status).toBe(401);
    });

    /*
     * The key is additive. A caller who has the deployment's secret but is not
     * the extension is still refused by the Origin rule unit 01 tightened —
     * otherwise this change would have quietly widened the local boundary in
     * the course of narrowing the remote one.
     */
    it('still applies the Origin rule to a caller who does have the key', async () => {
      const id = 'remote-key-no-origin';
      const reply = await request(server.port, method, route(id), { body: body(id), key: KEY });

      expect(reply.status).toBe(403);
    });

    it('accepts the extension with the right key — the normal path, not only the attack path', async () => {
      const id = 'remote-key-and-origin';
      const reply = await request(server.port, method, route(id), {
        body: body(id),
        origin: EXTENSION_ORIGIN,
        key: KEY,
      });

      expect(reply.status).toBe(200);
    });
  });

  it('refuses span ingest without the key, which has no Origin rule to fall back on', async () => {
    const reply = await request(server.port, 'POST', '/v1/traces', { body: '{}' });

    expect(reply.status).toBe(401);
  });
});

/*
 * On a server of its own, and last in the file for the same reason: an SSE
 * stream is a connection that never ends normally, so the client has to abandon
 * it, and an abandoned socket in the connection pool makes the *next* request to
 * that port fail with "other side closed" — a failure that reads as a broken
 * guard and is nothing of the kind. One session per server keeps that confined
 * to a port nothing else is using.
 */
describe('the stream a valid key opens', () => {
  it('is a real SSE session, so the 401s above are authentication and not an outage', async () => {
    const server = await startRemote({ MCP_API_KEY: KEY });
    const abort = new AbortController();

    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${KEY}` },
      signal: abort.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    // The first frame names the endpoint to post to — an SSE session by its
    // own protocol, not merely a 200 with an open socket behind it.
    const first = await response.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain('/mcp/message?sessionId=');
    abort.abort();
  }, 30_000);
});

describe('a remote server started without MCP_API_KEY', () => {
  let server: RemoteServer;

  beforeAll(async () => {
    server = await startRemote();
  }, 30_000);

  it('warns on stderr, naming the variable that fixes it', () => {
    expect(server.stderr()).toContain('MCP_API_KEY');
    expect(server.stderr()).toContain('no authentication');
  });

  it('reports the unauthenticated state at /health, where an operator can see it from outside', async () => {
    const reply = await request(server.port, 'GET', '/health');

    expect(JSON.parse(reply.body)).toMatchObject({ mode: 'remote', auth: 'none' });
  });

  /*
   * Unconfigured, the check is off rather than failing closed: `MCP_MODE=remote
   * npx devflow-server` is a documented command, and a silent hard failure is
   * how a security fix gets reverted instead of adopted. The warning above is
   * the migration notice; this test pins the deliberate behaviour so that
   * making the key mandatory later is a visible edit here rather than an
   * accident.
   */
  it('still serves, so the weaker default is the recorded decision rather than a surprise', async () => {
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      headers: { Accept: 'text/event-stream' },
      signal: abort.signal,
    });

    expect(response.status).toBe(200);
    abort.abort();
  });
});

describe('local mode', () => {
  const locals: McpSession[] = [];

  afterAll(() => {
    for (const session of locals) {
      session.stop();
      fs.rmSync(session.home, { recursive: true, force: true });
    }
  });

  async function local(env: Record<string, string> = {}): Promise<McpSession> {
    const session = await startServer({ env });
    locals.push(session);
    return session;
  }

  it('takes a flow with no key, because the boundary there is loopback plus Origin', async () => {
    const session = await local();
    const reply = await request(session.port, 'POST', '/flows', {
      body: JSON.stringify(flow('local-no-key')),
      origin: EXTENSION_ORIGIN,
    });

    expect(reply.status).toBe(200);
  });

  /*
   * MCP_API_KEY set locally must not start demanding one: the extension has no
   * way to know the value, so enforcing it here would break sending for anyone
   * who exports the variable in a shell that also launches Claude.
   */
  it('ignores MCP_API_KEY when it is set, rather than demanding a header the extension cannot send', async () => {
    const session = await local({ MCP_API_KEY: KEY });
    const reply = await request(session.port, 'POST', '/flows', {
      body: JSON.stringify(flow('local-key-set')),
      origin: EXTENSION_ORIGIN,
    });

    expect(reply.status).toBe(200);
  });

  it('says so at /health, so the mode and its boundary are legible from one place', async () => {
    const session = await local();
    const reply = await request(session.port, 'GET', '/health');

    expect(JSON.parse(reply.body)).toMatchObject({ mode: 'local', auth: 'local' });
  });
});
