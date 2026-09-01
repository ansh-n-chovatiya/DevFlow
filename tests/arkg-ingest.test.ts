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
function flow(id: string, names = { panel: 'CheckoutPanel', row: 'OrderRow' }) {
  // The component ids carry the flow's, so two flows do not arrive under one
  // id. That alone no longer makes them different components — the graph joins
  // on the name and the file, so a rebuild that re-hashes an id still
  // accumulates onto one node — so the retention case below varies the names
  // too, which is what a recording of a different app would look like anyway.
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
        [checkout]: { name: names.panel, source: `src/pages/${names.panel}.tsx`, line: 42 },
        [row]: { name: names.row, source: `src/pages/${names.row}.tsx`, line: 8 },
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

  /*
   * The claim at the top of this file, exercised rather than asserted about.
   *
   * A directory where the database file belongs is the cheapest way to make the
   * graph unavailable from outside the process, and it is indistinguishable
   * from inside it from the two failures that actually happen: a published
   * tarball that does not carry `arkg.js`, and a native addon built against
   * the wrong Node ABI. Every graph call in the server is behind one guarded
   * funnel, so if this degrades, all of them do.
   */
  it('degrades to no graph, with every other tool untouched', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-arkg-'));
    fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
    fs.mkdirSync(path.join(home, 'arkg.db'));
    const session = await startServer({ home });
    servers.push(session);

    expect(session.stderr()).toContain('no knowledge graph');
    expect(session.stderr()).toContain('every other tool are unaffected');

    // The recordings, which are what this server is for, are unaffected.
    expect(await session.post('/flows', JSON.stringify(flow('flow-degraded')))).toMatchObject({ status: 200 });
    expect(await session.call('list_flows', {})).toContain('Recording flow-degraded');
    expect(await session.call('get_latest_flow', {})).toContain('Clicked "Pay"');

    // The three graph tools say the graph is gone, which is a different answer
    // from an empty one and points at neither Send to Claude nor the panel.
    for (const tool of ['get_app_architecture', 'get_anomalies']) {
      expect(await session.call(tool, {})).toContain('arkg.db could not be opened');
    }
    expect(await session.call('get_component_history', { componentId: 'CheckoutPanel' }))
      .toContain('arkg.db could not be opened');

    // And a pick is answered, not errored: nobody is waiting on it.
    const posted = await session.post('/arkg/ingest-component', JSON.stringify({ name: 'Anything' }));
    expect(posted.status).toBe(200);
    expect(JSON.parse(posted.body)).toEqual({ ok: true, stored: false });
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
    expect(architecture).toContain('src/pages/CheckoutPanel.tsx');
    // The endpoint, with its ids collapsed to a pattern, and the call edge.
    expect(architecture).toContain('POST api.example.com/orders/:id');
    expect(architecture).toContain('calls POST api.example.com/orders/:id');

    // A save must not be able to fail on the index built from it.
    expect(JSON.parse(posted.body)).toMatchObject({ ok: true, id: 'flow-a' });
  });

  it('takes a component pick, and keys it by name and file rather than by what the caller says', async () => {
    const session = await server();
    // No flow first. A pick is evidence on its own, and a graph made only of
    // picks used to be invisible to every tool that reads it.
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

  /*
   * The join, end to end and over the wire, which is the only place it can be
   * seen the way a user meets it: the extension cannot compute the id a flow
   * carries — that hash is over compiled source that never leaves the page — so
   * the two halves of one component arrive under two different keys and the
   * server has to recognise them as one thing.
   */
  it('counts a component seen in a flow and picked in the panel once, flow first', async () => {
    const session = await server();
    await session.post('/flows', JSON.stringify(flow('flow-join-a')));

    const posted = await session.post(
      '/arkg/ingest-component',
      JSON.stringify({
        name: 'CheckoutPanel',
        sourceFile: 'src/pages/CheckoutPanel.tsx',
        sourceLine: 42,
      }),
    );
    expect(JSON.parse(posted.body)).toEqual({ ok: true, stored: true });

    const architecture = await session.call('get_app_architecture', {});
    // One line for it, and that line counts both sightings.
    expect(architecture.match(/CheckoutPanel /g)).toHaveLength(1);
    expect(architecture).toContain('CheckoutPanel  2x');

    // And it still knows the flow it appeared in, which is the thing a second
    // node keyed by the pick would have lost.
    const history = await session.call('get_component_history', { componentId: 'CheckoutPanel' });
    expect(history).toContain('2x seen');
    expect(history).toContain('Recording flow-join-a');
  });

  it('counts it once the other way round too, pick first', async () => {
    const session = await server();
    await session.post(
      '/arkg/ingest-component',
      JSON.stringify({
        name: 'CheckoutPanel',
        sourceFile: 'src/pages/CheckoutPanel.tsx',
        sourceLine: 42,
      }),
    );
    await session.post('/flows', JSON.stringify(flow('flow-join-b')));

    const architecture = await session.call('get_app_architecture', {});
    expect(architecture.match(/CheckoutPanel /g)).toHaveLength(1);
    expect(architecture).toContain('CheckoutPanel  2x');
    // The flow's own edges landed on the row the pick created.
    expect(architecture).toContain('calls POST api.example.com/orders/:id');
  });
});

describe('a graph made only of picks', () => {
  /*
   * `getAppArchitecture` used to answer null whenever no flow had been
   * ingested, which made every pick invisible to all three tools — and
   * `get_component_history` looked names up *through* that summary, so a picked
   * component was unreachable even in principle. Both of those are the same
   * bug seen from two ends.
   */
  it('is reported rather than called empty', async () => {
    const session = await server();
    await session.post(
      '/arkg/ingest-component',
      JSON.stringify({ name: 'SoloWidget', sourceFile: 'src/SoloWidget.tsx', sourceLine: 3 }),
    );

    const architecture = await session.call('get_app_architecture', {});
    expect(architecture).not.toContain('The knowledge graph is empty');
    expect(architecture).toContain('no recorded flow yet');
    expect(architecture).toContain('1 component seen by picking');
    expect(architecture).toContain('SoloWidget');
    // And it says what the missing half would add, rather than reading as all
    // there is to know.
    expect(architecture).toContain('Send a recording');
  });

  it('is reachable by name, without a flow to look the name up through', async () => {
    const session = await server();
    await session.post(
      '/arkg/ingest-component',
      JSON.stringify({ name: 'SoloWidget', sourceFile: 'src/SoloWidget.tsx', sourceLine: 3 }),
    );

    // Lower case: a caller is quoting a name, not a key.
    const history = await session.call('get_component_history', { componentId: 'solowidget' });
    expect(history).toContain('SoloWidget');
    expect(history).toContain('src/SoloWidget.tsx:3');
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

    const second = await session.post(
      '/flows',
      // Different components, not the same ones under new ids: the graph joins
      // on name and file now, so re-sending CheckoutPanel would refresh the row
      // that was just backdated and there would be nothing old left to prune.
      JSON.stringify(flow('flow-new', { panel: 'ShipPanel', row: 'ShipRow' })),
    );
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

  /**
   * "Nothing is known yet" and "nothing is wrong" are the same empty array out
   * of `getAnomalies`, and they are opposite answers to somebody deciding
   * whether the app is healthy.
   *
   * `getAnomalyReport` is the shape that separates them, and it is only worth
   * having if the *tool* spends it — the graph knowing the difference privately
   * is the same as not knowing it. So this asserts on the sentence, from a
   * spawned server, which is the only layer where the loss was visible: the
   * module's own tests passed throughout while the tool said neither number.
   */
  it('says an empty graph knows nothing yet, not that nothing is wrong', async () => {
    const session = await server();
    const anomalies = await session.call('get_anomalies', {});
    expect(anomalies).toContain('nothing is known yet');
    expect(anomalies).not.toContain('Nothing is behaving unusually');
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

describe('a graph old enough to be judged', () => {
  /**
   * `MIN_OBSERVATIONS` recordings of one flow, which is the bar an entity has
   * to clear before anything is said about it. The fixture's call fails every
   * time, so the endpoint crosses the failure threshold as well — giving both
   * halves of the answer to assert on: what was found, and what was looked at.
   */
  async function judged(): Promise<McpSession> {
    const session = await server();
    for (let i = 0; i < 30; i++) {
      expect(await session.post('/flows', JSON.stringify(flow(`flow-${i}`)))).toMatchObject({ status: 200 });
    }
    return session;
  }

  it('reports how many entities it had the history to judge', async () => {
    const session = await judged();
    const anomalies = await session.call('get_anomalies', {});

    // The failing endpoint is found, and it is named a threshold rather than a
    // baseline — the graph holds one rolling rate per entity and no
    // distribution of rates to take a σ of, and the sentence has to say so.
    expect(anomalies).toContain('high failure rate');
    expect(anomalies).toContain('a threshold and not a baseline');

    // And the count that makes an empty answer readable is spent here too.
    expect(anomalies).toMatch(/Out of \d+ entit(y|ies) with enough history to judge/);
  });
});
