/**
 * `DELETE /flows/:id` reaching the disk, over a real HTTP call.
 *
 * The route exists specifically because `deleteFlow` used to clear only
 * `chrome.storage` and never contact the server — a recording the user
 * deleted, perhaps because it captured a token, stayed in `~/.devflow/flows`
 * and was still handed to Claude by the next `list_flows`. Commenting out the
 * route's single `fs.rm` call and running the full suite produced **zero**
 * failures, because no test exercised server-side delete over HTTP at all —
 * every `deleteFlow` reference elsewhere in the suite turns out to be the
 * unrelated extension-side `chrome.storage` function. This file closes that
 * gap: a real request against a real spawned server, asserting the directory
 * is actually gone from disk afterward, not a mocked `fs.rm` call.
 */

import fs from 'node:fs';
import path from 'node:path';
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

async function deleteFlow(port: number, id: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/flows/${id}`, {
    method: 'DELETE',
    headers: { Origin: 'chrome-extension://test' },
  });
  return { status: response.status, body: await response.text() };
}

describe('DELETE /flows/:id', () => {
  it('removes the flow’s directory from disk, not just the index row', async () => {
    const session = await server();
    const id = 'delete-me';

    const posted = await session.post(
      '/flows',
      JSON.stringify({ id, name: 'To be deleted', timestamp: Date.now(), steps: [] }),
    );
    expect(posted.status).toBe(200);

    const dir = path.join(session.home, 'flows', id);
    expect(fs.existsSync(dir)).toBe(true);

    const deleted = await deleteFlow(session.port, id);
    expect(deleted.status).toBe(200);
    expect(JSON.parse(deleted.body)).toEqual({ ok: true, id });

    // The assertion a mocked `fs.rm` cannot fail: the directory itself, gone
    // from the real filesystem the server was told to write to.
    expect(fs.existsSync(dir)).toBe(false);

    const flows = await session.call('list_flows', {});
    expect(flows).not.toContain(id);
  });

  it('is idempotent — deleting a flow the server never received is a success, not an error', async () => {
    const session = await server();
    const dir = path.join(session.home, 'flows', 'never-sent');

    const deleted = await deleteFlow(session.port, 'never-sent');

    expect(deleted.status).toBe(200);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
