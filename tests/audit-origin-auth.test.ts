/**
 * `extensionOrigin()` is the one guard every write route on the receiver
 * shares, and its own comment used to reason that a request with no `Origin`
 * at all was "a local tool like curl, which is not a page and cannot be
 * driven by a visited site" — true for the browser threat, but the code then
 * treated "not a page" as "trusted," which is a different and false claim:
 * any other local process can omit `Origin` exactly as easily, and in
 * `MCP_MODE=remote` (bound to `0.0.0.0`) so can anyone on the internet.
 * `saveFlow` validates only shape and `listAllFlows` sorts by the
 * caller-supplied `timestamp`, so a forged no-`Origin` request could
 * overwrite a real recording or permanently win `get_latest_flow` — a direct
 * indirect-prompt-injection vector into the coding agent this server feeds.
 *
 * Driven against a real spawned server over a real socket, for the reason
 * `helpers/mcp-server.ts` gives: this guard has no typecheck over it and its
 * failure is invisible from anywhere but a live request.
 */

import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { startServer, type McpSession } from './helpers/mcp-server.js';

const servers: McpSession[] = [];

afterAll(() => {
  for (const session of servers) {
    session.stop();
    fs.rmSync(session.home, { recursive: true, force: true });
  }
});

async function server(): Promise<McpSession> {
  const session = await startServer();
  servers.push(session);
  return session;
}

const EXTENSION_ORIGIN = 'chrome-extension://test';

/**
 * One request, with full control over whether `Origin` is sent at all.
 *
 * `McpSession.post` always carries an extension `Origin` by default — right
 * for every other test, wrong for this file, whose entire point is a request
 * that carries none. Built with `fetch` directly instead, the way
 * `mcp-remote.test.ts` and `mcp-config.test.ts` already reach a server this
 * helper doesn't expose an arbitrary method or header set for.
 */
async function request(
  port: number,
  method: string,
  route: string,
  body: string | undefined,
  origin?: string,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (origin !== undefined) headers.Origin = origin;
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers, body });
  return { status: response.status, body: await response.text() };
}

/** A flow small enough that only `id`/`steps` — the fields the route checks — matter. */
function flow(id: string) {
  return { id, name: 'Origin check', timestamp: Date.now(), steps: [] };
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

const routes: {
  name: string;
  method: string;
  route: (id: string) => string;
  body: (id: string) => string;
}[] = [
  { name: 'POST /flows', method: 'POST', route: () => '/flows', body: (id) => JSON.stringify(flow(id)) },
  {
    name: 'POST /pick (arkg/ingest-component)',
    method: 'POST',
    route: () => '/arkg/ingest-component',
    body: () => JSON.stringify({ name: 'OriginCheckComponent' }),
  },
  {
    name: 'POST /architecture',
    method: 'POST',
    route: () => '/architecture',
    body: () => JSON.stringify(architectureReading),
  },
  {
    name: 'DELETE /flows/:id',
    method: 'DELETE',
    route: (id) => `/flows/${id}`,
    body: () => '',
  },
];

describe.each(routes)('$name', ({ method, route, body }) => {
  it('rejects a request with no Origin header at all', async () => {
    const session = await server();
    const id = 'origin-none';
    const result = await request(session.port, method, route(id), body(id), undefined);

    expect([401, 403]).toContain(result.status);
  });

  it('still succeeds for the extension’s own Origin — the normal path, not just the attack path', async () => {
    const session = await server();
    const id = 'origin-extension';
    const result = await request(session.port, method, route(id), body(id), EXTENSION_ORIGIN);

    expect(result.status).toBe(200);
  });
});

describe('extensionOrigin() itself', () => {
  it('rejects a page origin exactly as it rejects no Origin at all', async () => {
    const session = await server();
    const id = 'origin-page';
    const result = await request(
      session.port,
      'POST',
      '/flows',
      JSON.stringify(flow(id)),
      'https://not-the-extension.example.com',
    );

    expect([401, 403]).toContain(result.status);
  });
});
