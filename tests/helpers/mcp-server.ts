/**
 * Driving the real MCP server, over the real transport.
 *
 * The server is a standalone script with top-level side effects — it makes a
 * directory, reads `config.json` and binds a port on import — so it cannot be
 * unit-tested by importing a function out of it. It is also the one component
 * whose failure is invisible: `mcp-server/server.js` has no typecheck over it,
 * and every MCP client caps tool output by truncating the string, so a response
 * that outgrows the cap arrives cut mid-JSON with nothing anywhere saying so.
 * That is worth spawning a process for.
 *
 * Three test files need this now — `mcp-pagination` for the budget,
 * `mcp-settings` for the precedence chain and `mcp-config` for the endpoint
 * that writes it — and the second one needs to spawn *several* servers with
 * different environments, which is what turned the plumbing into a helper
 * rather than a copy.
 *
 * Flows are written straight into `FLOWSNAP_DIR` rather than POSTed, so the
 * receiver is only involved where a test is about the receiver. Each server
 * still gets its own port, so those tests can have one without hunting for it.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../mcp-server/server.js', import.meta.url));

/**
 * A port nothing is on, per server.
 *
 * It used to be a counter from 7900, which is fine until two test *files* want
 * servers: vitest runs them in separate processes, both counters start at the
 * same number, and the loser of the race logs "already taken" and carries on
 * without listening. Everything still passed, because the tests that noticed
 * were the ones that then posted to the winner — a different server, with a
 * different `FLOWSNAP_DIR`, quietly answering for it.
 *
 * Asking the operating system for a free one removes the shared number that
 * made that possible. The port is released before the server is spawned, so
 * there is a window; nothing else on the machine is handing out ephemeral ports
 * to this test run, and a collision would now be a loud one rather than a
 * silent redirection.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

export interface McpSession {
  /** Where this server's flows live. Write into `<home>/flows/<id>/`. */
  readonly home: string;
  /** The loopback port this server's receiver is on — see `post`. */
  readonly port: number;
  /**
   * One request to the HTTP receiver, as the extension makes it.
   *
   * Phase 5 added an endpoint that *writes*, so the receiver is no longer
   * something the settings tests can leave alone. The `Origin` is an extension
   * one by default because that is the caller the endpoints are for; a test of
   * the origin guard passes its own.
   */
  post(path: string, body: string, headers?: Record<string, string>): Promise<{
    status: number;
    body: string;
  }>;
  /** One tool call, with every text part joined. */
  call(name: string, args: Record<string, unknown>): Promise<string>;
  /** The whole tool list, for the descriptions that name a configured value. */
  tools(): Promise<string>;
  /** Everything the server has written to stderr so far. */
  stderr(): string;
  stop(): void;
}

export interface StartOptions {
  /** An existing directory to serve from. One is made if this is omitted. */
  home?: string;
  /** Extra environment for the process — the top of the precedence chain. */
  env?: Record<string, string>;
  /**
   * Start without `FLOWSNAP_PORT`, so `config.json` is what decides the port.
   *
   * The helper sets the variable for every other server, which is right — it is
   * how each one gets a port of its own — but it is also the top of the
   * precedence chain, so a test about the *file* moving the port cannot have it
   * set. Such a test takes a `freePort()`, writes it into the config it hands
   * to `home`, and passes the same number here.
   */
  portFromConfig?: number;
}

/**
 * Spawn a server and wait until it answers.
 *
 * A server that dies on startup must say so rather than time out: everything
 * below waits on a reply a dead process will never send, so a failure to launch
 * surfaced as `Hook timed out in 20000ms` with the reason — on stderr,
 * discarded — nowhere in the report.
 */
export async function startServer(options: StartOptions = {}): Promise<McpSession> {
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'flowsnap-test-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });

  const port = options.portFromConfig ?? (await freePort());
  const env: Record<string, string | undefined> = {
    ...process.env,
    FLOWSNAP_DIR: home,
    FLOWSNAP_PORT: String(port),
    ...options.env,
  };
  if (options.portFromConfig !== undefined) delete env.FLOWSNAP_PORT;

  const server: ChildProcessWithoutNullStreams = spawn('node', [SERVER], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 0;
  const pending = new Map<number, (message: { result: unknown }) => void>();

  let errors = '';
  server.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });

  const died = new Promise<never>((_resolve, reject) => {
    server.on('exit', (code) => {
      reject(
        new Error(
          `The MCP server exited with code ${code} instead of answering.\n` +
            `${errors.trim() || '(nothing on stderr)'}\n\n` +
            'If this is ERR_MODULE_NOT_FOUND, run `npm install` at the repo root — ' +
            'mcp-server/ is its own package, installed by the root `postinstall` hook. ' +
            'An install run with --ignore-scripts skips it; `npm --prefix mcp-server ci` ' +
            'fixes that by hand.',
        ),
      );
    });
  });

  let buffer = '';
  server.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let cut: number;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; result: unknown };
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });

  function request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve) => {
      const id = ++nextId;
      pending.set(id, (message) => resolve(message.result as T));
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  const ready = request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  });

  await Promise.race([ready, died]);
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    home,
    port,
    post: async (route, body, headers) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test', ...headers },
        body,
      });
      return { status: response.status, body: await response.text() };
    },
    call: async (name, args) => {
      const result = await request<ToolResult>('tools/call', {
        name,
        arguments: args,
      });
      return result.content.map((part) => part.text).join('\n');
    },
    tools: async () => JSON.stringify(await request('tools/list', {})),
    stderr: () => errors,
    stop: () => server.kill(),
  };
}

/** A flow on disk, as `saveFlow` would have left it. */
export function writeFlow(
  home: string,
  flow: { id: string; name: string; timestamp: number; steps: unknown[] } & Record<string, unknown>,
): string {
  const dir = path.join(home, 'flows', flow.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify(flow));
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      id: flow.id,
      name: flow.name,
      timestamp: flow.timestamp,
      stepCount: flow.steps.length,
      startUrl: flow.startUrl,
      errorCount: flow.errorCount,
    }),
  );
  return dir;
}
