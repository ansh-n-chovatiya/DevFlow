/**
 * What reaches the knowledge graph, and what the graph will say back.
 *
 * Three claims, and the first is the one that decides whether the other two are
 * worth anything: **the graph may never take the server down**. It is additive
 * intelligence — a missing, corrupt or unbuildable `arkg.db` has to degrade to
 * "no graph", never to an MCP server that does not start. The version of this
 * work being replaced failed exactly there, statically importing a module that
 * threw, and the whole server went with it.
 *
 * That is not a claim about a function, so it is not tested as one. Every case
 * below drives a real spawned server over the real transport, for the reason
 * `helpers/mcp-server.ts` gives: `mcp-server/server.js` has top-level side
 * effects, no typecheck over it, and a failure mode that is invisible from
 * inside the process.
 *
 * The other two: an unauthenticated write on a loopback port is bounded exactly
 * as the receiver's other writes are, and the three tools answer an empty graph
 * with what to do about it rather than with nothing.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startServer, type McpSession } from './helpers/mcp-server.js';

const servers: McpSession[] = [];

async function server(env?: Record<string, string>): Promise<McpSession> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-arkg-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  const session = await startServer({ home, env });
  servers.push(session);
  return session;
}

/**
 * One flow with everything the graph reads out of a recording: a component
 * table, a step attributed to one of those components, and a network call that
 * failed under it.
 */
function flow(id: string) {
  // The component ids carry the flow's, so two flows are two observations of
  // two different components rather than a second sighting of the same ones —
  // which is what the retention case below needs, and what a recording of a
  // different app would look like anyway.
  const checkout = `cmp_checkout_${id}`;
  const row = `cmp_row_${id}`;

  return {
    id,
    name: `Recording ${id}`,
    timestamp: 1_700_000_000_000,
    startUrl: 'https://app.example.com/orders',
    schemaVersion: 1,
    react: {
      components: {
        [checkout]: { name: 'CheckoutPanel', source: 'src/pages/Checkout.tsx', line: 42 },
        [row]: { name: 'OrderRow', source: 'src/pages/OrderRow.tsx', line: 8 },
      },
    },
    steps: [
      {
        type: 'click',
        url: 'https://app.example.com/orders',
        timestamp: 1_700_000_000_000,
        action: 'Clicked "Pay"',
        stepNumber: 1,
        element: {
          tag: 'button',
          cssSelector: '#pay',
          react: { owner: checkout, chain: [row, checkout] },
        },
        networkCalls: [
          {
            method: 'POST',
            url: 'https://api.example.com/orders/9182',
            status: 500,
            durationMs: 240,
          },
        ],
        consoleLogs: [],
      },
    ],
  };
}

afterAll(() => {
  for (const session of servers) session.stop();
});

describe('the server starts, and keeps its graph to itself', () => {
  it('boots and answers, with the graph opened beside the flows', async () => {
    const session = await server();
    expect(await session.call('list_flows', {})).toContain('No flows recorded yet');
    expect(session.stderr()).toContain('knowledge graph at');
    expect(fs.existsSync(path.join(session.home, 'arkg.db'))).toBe(true);
  });

  it('says how long it keeps observations, and takes that from the environment', async () => {
    const session = await server({ DEVFLOW_ARKG_RETENTION_DAYS: '30' });
    expect(session.stderr()).toContain('keeping 30 days');
  });
});

describe('what the graph is told', () => {
  it('takes a flow from the receiver, without a second POST to do it', async () => {
    const session = await server();
    const posted = await session.post('/flows', JSON.stringify(flow('flow-a')));
    expect(posted.status).toBe(200);

    const architecture = await session.call('get_app_architecture', {});
    expect(architecture).toContain('1 flow observed');
    expect(architecture).toContain('CheckoutPanel');
    expect(architecture).toContain('src/pages/Checkout.tsx');
    // The endpoint, with its ids collapsed to a pattern, and the call edge.
    expect(architecture).toContain('POST api.example.com/orders/:id');
    expect(architecture).toContain('calls POST api.example.com/orders/:id');

    // A save must not be able to fail on the index built from it.
    expect(JSON.parse(posted.body)).toMatchObject({ ok: true, id: 'flow-a' });
  });

  it('takes a component pick, and keys it by name and file rather than by what the caller says', async () => {
    const session = await server();
    // A flow first, because the graph summarises nothing until one has arrived
    // — and looking a component up by the name somebody has in front of them
    // goes through that summary. See `get_component_history`.
    await session.post('/flows', JSON.stringify(flow('flow-b')));

    const posted = await session.post(
      '/arkg/ingest-component',
      JSON.stringify({
        id: 'a-node-of-my-choosing',
        name: 'PickedOnly',
        sourceFile: 'src/widgets/PickedOnly.tsx',
        sourceLine: 12,
      }),
    );

    expect(posted.status).toBe(200);
    expect(JSON.parse(posted.body)).toEqual({ ok: true, stored: true });

    const history = await session.call('get_component_history', { componentId: 'PickedOnly' });
    expect(history).toContain('src/widgets/PickedOnly.tsx:12');
    expect(history).not.toContain('a-node-of-my-choosing');
    // Everything it knows came from the panel, and the reply says so rather
    // than showing an empty list of flows.
    expect(history).toContain('picking it in the DevTools panel');
  });
});

describe('the graph ages out on the sweep that already exists', () => {
  /*
   * There is no second timer, and this is what says so: the only thing that
   * prunes is a flow arriving, because that is when the retention sweep runs.
   *
   * The rows are backdated through `arkg.db` directly, which is the one place
   * this file reaches past the graph module's own API — there is no other way
   * to have history without waiting ninety days for it. `better-sqlite3` is
   * resolved out of `mcp-server/`, which is its own package.
   */
  it('prunes observations older than the retention window when the next flow lands', async () => {
    const session = await server({ DEVFLOW_ARKG_RETENTION_DAYS: '1' });
    const posted = await session.post('/flows', JSON.stringify(flow('flow-old')));
    expect(posted.status).toBe(200);

    const require = createRequire(path.join(process.cwd(), 'mcp-server', 'package.json'));
    const Database = require('better-sqlite3') as new (file: string) => {
      exec(sql: string): void;
      close(): void;
    };
    const db = new Database(path.join(session.home, 'arkg.db'));
    db.exec('UPDATE arkg_components SET last_observed_at = 0');
    db.exec('UPDATE arkg_api_endpoints SET last_observed_at = 0');
    db.close();

    const second = await session.post('/flows', JSON.stringify(flow('flow-new')));
    expect(second.status).toBe(200);
    expect(session.stderr()).toMatch(/pruned \d+ node\(s\) older than 1 days/);
  });
});

describe('what bounds an unauthenticated write on a loopback port', () => {
  it('refuses a request carrying a web page’s origin', async () => {
    const session = await server();
    const posted = await session.post(
      '/arkg/ingest-component',
      JSON.stringify({ name: 'FromAPage' }),
      { Origin: 'https://not-the-extension.example.com' },
    );

    expect(posted.status).toBe(403);
    expect(posted.body).toContain('DevFlow extension');
  });

  it('has a ceiling of its own, far under the flow cap', async () => {
    const session = await server();
    const posted = await session.post(
      '/arkg/ingest-component',
      JSON.stringify({ name: 'Huge', sourceFile: 'x'.repeat(200_000) }),
    );

    expect(posted.status).toBe(413);
  });

  it('refuses a body with no name, rather than accumulating onto an empty one', async () => {
    const session = await server();
    expect((await session.post('/arkg/ingest-component', JSON.stringify({ sourceFile: 'a.tsx' }))).status).toBe(400);
    expect((await session.post('/arkg/ingest-component', JSON.stringify({ name: '   ' }))).status).toBe(400);
    expect((await session.post('/arkg/ingest-component', 'not json at all')).status).toBe(400);
  });
});

describe('what the tools say when there is nothing to say', () => {
  it('tells an empty graph what would fill it', async () => {
    const session = await server();
    const empty = await session.call('get_app_architecture', {});
    expect(empty).toContain('empty');
    expect(empty).toContain('Send to Claude');
  });

  it('does not report a young graph as a healthy one', async () => {
    const session = await server();
    const anomalies = await session.call('get_anomalies', {});
    expect(anomalies).toContain('last 24 hours');
    expect(anomalies).toContain('30 observations');
  });

  it('points a component nobody has heard of at the tool that lists them', async () => {
    const session = await server();
    const missing = await session.call('get_component_history', { componentId: 'NoSuchThing' });
    expect(missing).toContain('get_app_architecture');
  });

  it('says what a componentId is when it is asked without one', async () => {
    const session = await server();
    const asked = await session.call('get_component_history', {});
    expect(asked).toContain('componentId');
  });
});
