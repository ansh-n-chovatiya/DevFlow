/**
 * The one tool that reads this machine's own files, on a server that is not on
 * this machine.
 *
 * Every other tool answers out of `~/.devflow/flows` — data the caller sent in
 * the first place, so serving it back to whoever can reach the port is the
 * deployment's own decision and the README says so. `get_source_snippet` is
 * different in kind: it opens source off the disk the server runs on, and in
 * remote mode the caller is not the person sitting at that disk. So the tool is
 * off unless `DEVFLOW_PROJECT_ROOT` turns it on, and the `root` argument — which
 * would let the caller pick the directory — is ignored.
 *
 * That is a security decision with a branch behind it, and until this file
 * nothing exercised it: `server.js` connects the stdio transport only under
 * `if (!REMOTE)`, so `tests/helpers/mcp-server.ts` — which speaks stdio — cannot
 * reach a remote server at all. Hence the small SSE client below. It lives here
 * rather than in the helper because this is its only caller; move it when a
 * second file wants one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort } from './helpers/mcp-server.js';

const SERVER = fileURLToPath(new URL('../mcp-server/server.js', import.meta.url));

interface RemoteSession {
  call(name: string, args: Record<string, unknown>): Promise<string>;
  stop(): void;
}

/**
 * A server in remote mode, and enough of an SSE client to call one tool on it.
 *
 * The transport is the SDK's own: `GET /mcp` opens the stream and its first
 * event names the URL to post to, every reply arrives back on the stream. The
 * client is deliberately minimal — it answers one question, which is what a
 * remote caller gets back.
 */
async function startRemote(env: Record<string, string>): Promise<RemoteSession> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-remote-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  const port = await freePort();

  const server: ChildProcessWithoutNullStreams = spawn('node', [SERVER], {
    env: { ...process.env, MCP_MODE: 'remote', PORT: String(port), DEVFLOW_DIR: home, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let errors = '';
  server.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });

  // The port is bound at the top level, so it answers as soon as it answers;
  // polling `/health` beats a sleep that is either flaky or slow.
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (server.exitCode !== null) {
      throw new Error(`The remote server exited with ${server.exitCode}.\n${errors || '(nothing on stderr)'}`);
    }
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`The remote server never answered.\n${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const stream = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { Accept: 'text/event-stream' } });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /** The next `data:` payload on the stream, whatever event it belongs to. */
  async function nextData(): Promise<string> {
    for (;;) {
      const cut = buffer.indexOf('\n\n');
      if (cut >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (data) return data;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('The event stream closed before answering.');
      buffer += decoder.decode(value, { stream: true });
    }
  }

  const endpoint = await nextData();
  const post = `http://127.0.0.1:${port}${endpoint}`;

  let id = 0;
  async function request(method: string, params: Record<string, unknown>): Promise<{ content?: { text?: string }[] }> {
    const mine = ++id;
    await fetch(post, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }),
    });
    for (;;) {
      const message = JSON.parse(await nextData()) as { id?: number; result?: { content?: { text?: string }[] } };
      if (message.id === mine) return message.result ?? {};
    }
  }

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  });
  await fetch(post, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  return {
    call: async (name, args) => {
      const result = await request('tools/call', { name, arguments: args });
      return (result.content ?? []).map((part) => part.text ?? '').join('\n');
    },
    stop: () => {
      reader.cancel().catch(() => {});
      server.kill();
    },
  };
}

/** A project to read from, and a secret beside it that is nobody's to read. */
const SECRET = 'THE-DEPLOYMENT-SECRET';
let project: string;
let outside: string;

beforeAll(() => {
  const holder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-deploy-')));
  project = path.join(holder, 'app');
  outside = path.join(holder, 'private.txt');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'src', 'Cart.tsx'),
    Array.from({ length: 40 }, (_, i) => `const cartLine${i + 1} = true;`).join('\n'),
  );
  fs.writeFileSync(outside, SECRET);
});

describe('a server reachable over a network does not read its own disk', () => {
  let session: RemoteSession;

  beforeAll(async () => {
    session = await startRemote({});
  }, 30_000);

  afterAll(() => session?.stop());

  it('refuses to read a source file at all, and says why rather than failing blankly', async () => {
    const answer = await session.call('get_source_snippet', { file: 'src/Cart.tsx' });

    expect(answer).toContain('get_source_snippet is off on a remote server');
    expect(answer).toContain('DEVFLOW_PROJECT_ROOT');
  });

  it('does not let the caller name the directory to read, which is the whole of the problem', async () => {
    // An absolute path to the file, plus the root that would contain it. Both
    // halves are the caller's, and neither is honoured.
    const answer = await session.call('get_source_snippet', { file: outside, root: path.dirname(project) });

    expect(answer).not.toContain(SECRET);
    expect(answer).toContain('off on a remote server');
  });

  it('leaves every other tool working, so the refusal is scoped to the one that reads files', async () => {
    const answer = await session.call('list_flows', {});

    expect(answer).toContain('No flows recorded yet');
  });
});

describe('a deployment that has said where its source is', () => {
  let session: RemoteSession;

  beforeAll(async () => {
    session = await startRemote({ DEVFLOW_PROJECT_ROOT: project });
  }, 30_000);

  afterAll(() => session?.stop());

  it('reads source from the root the deployment named', async () => {
    const answer = await session.call('get_source_snippet', { file: 'src/Cart.tsx', line: 5, radius: 1 });

    expect(answer).toContain('>5 | const cartLine5 = true;');
  });

  /*
   * The assertion that matters most in this file. The caller names the file by
   * absolute path *and* names the root that contains it — so a server that
   * honoured either would hand back the secret. It is refused against the root
   * the deployment set, which is the only root there is.
   */
  it('still ignores a root the caller supplies, so the deployment keeps the choice', async () => {
    const answer = await session.call('get_source_snippet', {
      file: outside,
      root: path.dirname(project),
    });

    expect(answer).not.toContain(SECRET);
    expect(answer).toContain('resolves outside the project root');
  });
});
