/**
 * The crash receiver, from the outside.
 *
 * `tests/telemetry.test.ts` drives the allow-list. This drives the endpoint,
 * and every case is a guard: off unless asked for, unreachable from a web page,
 * bounded before the body is trusted, and — the one that makes the feature
 * worth having rather than merely present — that an ingested issue reaches
 * `get_blast_radius` with its count visibly labelled as production events
 * rather than as observations DevFlow made.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startServer, type McpSession } from './helpers/mcp-server.js';

const sessions: McpSession[] = [];
afterAll(() => {
  for (const session of sessions) session.stop();
});

async function serve(env: Record<string, string> = {}): Promise<McpSession> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-webhook-')));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  const session = await startServer({ home, env });
  sessions.push(session);
  return session;
}

const crash = (issue = '4507', file = 'src/Cart.tsx') =>
  JSON.stringify({
    data: {
      event: {
        issue_id: issue,
        level: 'error',
        culprit: `CartButton(${file})`,
        count: 42,
        timestamp: 1_760_000_000,
        exception: {
          values: [
            {
              type: 'TypeError',
              value: 'Cannot read properties of undefined',
              stacktrace: { frames: [{ filename: file, lineno: 12, in_app: true }] },
            },
          ],
        },
      },
    },
  });

/** A recording, so the graph holds the source file a crash can be joined onto. */
const flow = (id: string, source = 'src/Cart.tsx') => ({
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
      element: { tag: 'button', cssSelector: '#buy', react: { owner: 'cmp_cart', chain: ['cmp_cart'] } },
      networkCalls: [],
      consoleLogs: [],
    },
  ],
});

describe('the switch', () => {
  it('is off by default, and says which variable turns it on', async () => {
    const session = await serve();
    const posted = await session.post('/webhooks/sentry', crash());
    expect(posted.status).toBe(404);
    expect(posted.body).toContain('DEVFLOW_WEBHOOKS=1');
  });

  it('accepts a delivery once it is on', async () => {
    const session = await serve({ DEVFLOW_WEBHOOKS: '1' });
    const posted = await session.post('/webhooks/sentry', crash());
    expect(posted.status).toBe(200);
    expect(JSON.parse(posted.body)).toMatchObject({ ok: true, id: 'sentry:4507' });
  });
});

describe('the guards', () => {
  it('is not reachable from a web page', async () => {
    const session = await serve({ DEVFLOW_WEBHOOKS: '1' });
    const posted = await session.post('/webhooks/sentry', crash(), { Origin: 'https://evil.example.com' });
    expect(posted.status).toBe(403);
  });

  it('refuses a body past its ceiling rather than reading it into memory', async () => {
    const session = await serve({ DEVFLOW_WEBHOOKS: '1' });
    const posted = await session.post('/webhooks/sentry', 'x'.repeat(300 * 1024));
    expect(posted.status).toBe(413);
  });

  it('says why it refused, so a working relay and a broken one are distinguishable', async () => {
    const session = await serve({ DEVFLOW_WEBHOOKS: '1' });

    const notJson = await session.post('/webhooks/sentry', 'not json');
    expect(notJson.status).toBe(400);
    expect(JSON.parse(notJson.body).reason).toBe('not-json');

    const noIssue = await session.post('/webhooks/sentry', JSON.stringify({ data: { event: {} } }));
    expect(JSON.parse(noIssue.body).reason).toBe('no-issue-id');
  });
});

describe('what reaches the graph', () => {
  it('joins a crash to a file the graph has watched code run in, and shows it before a change', async () => {
    const session = await serve({ DEVFLOW_WEBHOOKS: '1' });

    expect((await session.post('/flows', JSON.stringify(flow('flow-1')))).status).toBe(200);
    const posted = await session.post('/webhooks/sentry', crash());
    expect(JSON.parse(posted.body).files).toBe(1);

    const radius = await session.call('get_blast_radius', { file: 'src/Cart.tsx' });
    expect(radius).toContain('1 production issue reach');
    expect(radius).toContain('TypeError in CartButton');
    expect(radius).toContain('42 events in production');
  });

  it('never adds a production count to an observation count', async () => {
    const session = await serve({ DEVFLOW_WEBHOOKS: '1' });
    await session.post('/flows', JSON.stringify(flow('flow-1')));
    await session.post('/webhooks/sentry', crash());

    const radius = await session.call('get_blast_radius', { file: 'src/Cart.tsx' });
    // The component was observed once; the issue has 42 production events.
    expect(radius).toContain('1x observed');
    expect(radius).toContain('42 events in production');
    expect(radius).toContain('different units and are never added');
  });

  it('draws no edge onto a file the graph has never seen, rather than guessing one', async () => {
    const session = await serve({ DEVFLOW_WEBHOOKS: '1' });
    await session.post('/flows', JSON.stringify(flow('flow-1', 'src/Cart.tsx')));

    const posted = await session.post('/webhooks/sentry', crash('999', 'vendor/chunk-8fa21c.js'));
    expect(JSON.parse(posted.body)).toMatchObject({ ok: true, files: 0 });
  });

  it('does not multiply a re-delivered issue’s count', async () => {
    // A provider re-delivers with a cumulative total, so summing would multiply
    // it by however many times the relay fired.
    const session = await serve({ DEVFLOW_WEBHOOKS: '1' });
    await session.post('/flows', JSON.stringify(flow('flow-1')));
    for (let i = 0; i < 3; i += 1) await session.post('/webhooks/sentry', crash());

    const radius = await session.call('get_blast_radius', { file: 'src/Cart.tsx' });
    expect(radius).toContain('42 events in production');
    expect(radius).not.toContain('126 events');
  });
});
