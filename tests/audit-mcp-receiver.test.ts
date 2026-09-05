/**
 * What the HTTP receiver does with bytes, and what a tool says when a flow is
 * not there.
 *
 * Both are about the same class of defect: a wrong answer that looks exactly
 * like a right one. A body decoded chunk by chunk still parses as JSON, still
 * counts the right number of bytes, and differs from the truth only inside a
 * string somebody reads later. A tool that answers a missing flow with a
 * successful result carrying an `ENOENT` string still returns text, and differs
 * from a refusal only in the flag an MCP client reads to tell them apart.
 *
 * Driven against a real spawned server over a real socket, for the reason
 * `helpers/mcp-server.ts` gives: this is a process with top-level side effects
 * and no typecheck over it, and neither failure is visible from anywhere else.
 */

import net from 'node:net';
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

/**
 * POST a body split at a byte offset, in two writes.
 *
 * `fetch` hands the whole body to the socket at once, so it cannot produce the
 * thing under test. The split is placed *inside* a multi-byte character, which
 * is what a TCP boundary does to a large flow perfectly often — the receiver
 * reads whatever the socket gives it.
 */
function postSplit(port: number, route: string, body: Buffer, at: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `POST ${route} HTTP/1.1\r\nHost: localhost\r\nOrigin: chrome-extension://test\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n` +
          'Connection: close\r\n\r\n',
      );
      socket.write(body.subarray(0, at));
      setTimeout(() => socket.write(body.subarray(at)), 40);
    });

    let response = '';
    socket.on('data', (chunk) => (response += chunk.toString()));
    socket.on('error', reject);
    socket.on('close', () => resolve(response));
  });
}

describe('a body split inside a multi-byte character', () => {
  /*
   * The failure this is against: `body += chunk` decoded each socket read on
   * its own, so the two halves of a `£` each became U+FFFD. Nothing threw — the
   * JSON still parsed — and the corruption sat inside the response body a
   * reader is later shown as evidence.
   */
  it('stores the text the extension sent, not a pair of replacement characters', async () => {
    const session = await server();

    const flow = {
      id: 'utf8flow',
      name: 'Checkout — naïve café 🚀',
      timestamp: Date.now(),
      startUrl: 'https://shop.example/checkout',
      steps: [
        {
          type: 'click',
          action: 'Click Pay',
          url: 'https://shop.example/checkout',
          timestamp: Date.now(),
          element: { tag: 'button', cssSelector: 'button.pay', text: 'Pay £42.00' },
          consoleLogs: [
            { level: 'error', args: ['Total mismatch — expected £42.00, got €39,50'], timestamp: Date.now() },
          ],
          networkCalls: [],
        },
      ],
    };

    const body = Buffer.from(JSON.stringify(flow), 'utf8');
    // Inside the first `£`: it is two bytes, so land between them.
    const pound = body.indexOf(Buffer.from('£', 'utf8'));
    expect(pound).toBeGreaterThan(0);

    const response = await postSplit(session.port, '/flows', body, pound + 1);
    expect(response).toContain('200');

    const stored = JSON.parse(
      fs.readFileSync(`${session.home}/flows/utf8flow/flow.json`, 'utf8'),
    ) as { name: string; steps: { consoleLogs: { args: string[] }[] }[] };

    expect(stored.name).toBe('Checkout — naïve café 🚀');
    expect(stored.steps[0].consoleLogs[0].args[0]).toBe(
      'Total mismatch — expected £42.00, got €39,50',
    );
    expect(JSON.stringify(stored)).not.toContain('�');
  });
});

describe('get_backend_trace on a flow that is not there', () => {
  /*
   * Every other tool answers a bad id through `readFailure`. This one returned
   * `text(error.message)`: a *successful* result whose text was
   * `ENOENT: no such file or directory, open '/…/flows/nope/flow.json'` — no
   * `isError` for the client, an absolute path off this machine, and no mention
   * of `list_flows`.
   */
  it('refuses, rather than answering with a filesystem error as a success', async () => {
    const session = await server();
    const result = await session.callRaw('get_backend_trace', { id: 'no-such-flow' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('list_flows');
    expect(result.text).not.toContain('ENOENT');
    expect(result.text).not.toContain(session.home);
  });
});
