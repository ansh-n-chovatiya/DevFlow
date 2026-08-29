/**
 * `POST /config` — the machine-wide settings channel, and what bounds it.
 *
 * The MCP server has two channels. The per-flow one travels inside a
 * recording and is covered by `mcp-settings.test.ts`; this is the other, and it
 * is the only path the port and the two retention caps have. It is also the
 * first endpoint FlowSnap has that *writes a file* on the strength of an
 * unauthenticated request to a loopback port that any page the user visits can
 * reach — so half of what follows is about the bounds rather than the feature.
 *
 * The four bounds, each with its own test below:
 *
 *   - the origin rule the receiver already had, unchanged;
 *   - a body ceiling of its own, three orders of magnitude under the flow cap;
 *   - one path, no part of which can come from the request;
 *   - three keys, taken from the extension's own field table.
 *
 * Driven against real spawned servers over real HTTP, for the reason
 * `helpers/mcp-server.ts` gives: this file's subject is a process with top-level
 * side effects and no typecheck over it, and its failures are invisible from
 * here in every other way.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MACHINE_KEYS } from '../src/features/settings/fields.js';
import { freePort, startServer, type McpSession } from './helpers/mcp-server.js';

const homes: string[] = [];
const servers: McpSession[] = [];

/**
 * A server with an optional starting `config.json`.
 *
 * `portFromConfig` is for the one test that needs the file to have decided the
 * port: everywhere else `FLOWSNAP_PORT` gives each server one of its own, and
 * being the top of the chain is exactly what that test cannot have.
 */
async function server(config?: unknown, portFromConfig?: number): Promise<McpSession> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsnap-config-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
    );
  }

  homes.push(home);
  const session = await startServer({ home, portFromConfig });
  servers.push(session);
  return session;
}

/** The file as the server left it. */
function configOf(session: McpSession): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(session.home, 'config.json'), 'utf8'),
  ) as Record<string, unknown>;
}

const send = (session: McpSession, body: unknown, headers?: Record<string, string>) =>
  session.post('/config', typeof body === 'string' ? body : JSON.stringify(body), headers);

afterAll(() => {
  for (const session of servers) session.stop();
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

describe('what it writes', () => {
  it('persists the machine-wide settings and names the file it wrote', async () => {
    const session = await server();
    const reply = await send(session, { 'mcp.maxFlows': 12, 'mcp.maxFlowBytes': 1024 ** 3 });

    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body);
    expect(body.ok).toBe(true);
    expect(body.file).toBe(path.join(session.home, 'config.json'));
    expect(configOf(session)).toEqual({ 'mcp.maxFlows': 12, 'mcp.maxFlowBytes': 1024 ** 3 });
  });

  it('takes the body as the whole machine-wide half, so a reset removes a key', async () => {
    /*
     * The file is the settings file and holds overrides only. A key the user
     * has reset is absent from the body, and the server has to drop it rather
     * than keep the last value it was sent — otherwise "reset" would leave the
     * old number in force on the server forever, which is the worst available
     * reading of a control that says it has been reset.
     */
    const session = await server({ 'mcp.maxFlows': 12 });
    await send(session, { 'mcp.maxFlowBytes': 1024 ** 3 });

    expect(configOf(session)).toEqual({ 'mcp.maxFlowBytes': 1024 ** 3 });
  });

  it('leaves every key it does not own exactly where it found it', async () => {
    // A key from a newer version survives a round trip. The same rule holds
    // for a rendering key somebody set by hand — this endpoint writes three
    // keys and is not a licence to rewrite the file around them.
    const session = await server({ 'mcp.maxTokens': 9000, 'from.the.future': 'keep me' });
    await send(session, { 'mcp.maxFlows': 12 });

    expect(configOf(session)).toEqual({
      'mcp.maxTokens': 9000,
      'from.the.future': 'keep me',
      'mcp.maxFlows': 12,
    });
  });

  it('drops a key that is not machine-wide, and says which', async () => {
    /*
     * These settings already have a channel: they travel in the flow they
     * describe. Promoting one to machine-wide here would silently overrule
     * every recording this machine reads — including flows sent from another
     * browser profile that never asked — because the machine layer outranks the
     * per-flow one. Reported rather than refused: the write of the keys that
     * *are* machine-wide is still the right outcome.
     */
    const session = await server();
    const reply = await send(session, { 'mcp.port': 7734, 'mcp.raw': true, 'theme': 'dark' });

    expect(JSON.parse(reply.body).ignored).toEqual(['mcp.raw', 'theme']);
    expect(Object.keys(configOf(session))).toEqual(['mcp.port']);
  });

  it('writes only the three keys the field table marks machine-wide', () => {
    // The allow-list is `fields.ts`, imported into the server through
    // `core/mcp-bundle.ts`, so a key renamed there cannot leave the endpoint
    // accepting a name nothing reads.
    expect([...MACHINE_KEYS]).toEqual(['mcp.port', 'mcp.maxFlows', 'mcp.maxFlowBytes']);
  });
});

describe('what it says about a value that will not be used', () => {
  it('reports the clamp when the server would not accept the number', async () => {
    const session = await server();
    const reply = await send(session, { 'mcp.maxFlowBytes': 1 });
    const body = JSON.parse(reply.body);

    // Stored as sent — the file is the user's answer — and reported as
    // resolved, because `resolve` is the only validator and it is the resolved
    // number that governs the sweep.
    expect(body.applied['mcp.maxFlowBytes']).toBe(1);
    expect(body.effective['mcp.maxFlowBytes']).toBe(64 * 1024 * 1024);
    expect(session.stderr()).toContain('is out of range');
  });

  it('reports a key the environment outranks, rather than reporting success', async () => {
    /*
     * The whole write succeeded and the file says what was asked for, and the
     * value in force is still somebody else's — `FLOWSNAP_PORT` is set on a
     * process the user did not start, and env is the last word by design. This
     * is the exact "appears to work" failure the mechanism exists against, and
     * the extension can only say so if the server does.
     */
    const session = await server();
    const body = JSON.parse((await send(session, { 'mcp.port': 9100 })).body);

    expect(body.overridden).toEqual([
      { key: 'mcp.port', by: 'FLOWSNAP_PORT', using: session.port },
    ]);
  });

  it('says the port waits for a restart, because a bound socket does not move', async () => {
    // Started from the file rather than from `FLOWSNAP_PORT`, so nothing
    // outranks the new value — it is simply not something a running process can
    // act on. Which is the whole reason the reply says so.
    const listening = await freePort();
    const wanted = await freePort();
    const session = await server({ 'mcp.port': listening }, listening);
    const body = JSON.parse((await send(session, { 'mcp.port': wanted })).body);

    expect(body.overridden).toEqual([]);
    expect(body.restart).toContain(String(listening));
    expect(body.restart).toContain(String(wanted));
    expect(configOf(session)['mcp.port']).toBe(wanted);
  });
});

describe('what takes effect without a restart', () => {
  it('sweeps by the cap that was just posted, on the very next save', async () => {
    /*
     * The reason `MACHINE_RESOLVED` is re-read rather than captured at import.
     * A retention cap that only took effect at the next restart would have the
     * extension report success while the old number was still the one enforcing
     * — and for a stdio MCP server "the next restart" is the next Claude
     * session, which is a long way from the click that caused it.
     */
    const session = await server();
    for (const id of ['one', 'two']) {
      await session.post(
        '/flows',
        JSON.stringify({ id, name: id, timestamp: 1_700_000_000_000, steps: [] }),
      );
    }

    await send(session, { 'mcp.maxFlows': 1 });

    const posted = await session.post(
      '/flows',
      JSON.stringify({ id: 'three', name: 'three', timestamp: 1_700_000_300_000, steps: [] }),
    );
    expect(JSON.parse(posted.body).evicted).toEqual(expect.arrayContaining(['one', 'two']));
  });
});

describe('what bounds it', () => {
  it('refuses a caller that is not the extension', async () => {
    // The same guard the receiver and the delete endpoint already have. A page
    // the user visits cannot forge this header, and its `fetch` always sends
    // one — including a `no-cors` one, where it cannot read the reply either.
    const session = await server();
    const reply = await send(session, { 'mcp.maxFlows': 1 }, { Origin: 'https://evil.example' });

    expect(reply.status).toBe(403);
    expect(fs.existsSync(path.join(session.home, 'config.json'))).toBe(false);
  });

  it('refuses a body over its own ceiling before reading it all', async () => {
    // Far below the flow cap, because a settings file is a few kilobytes and
    // this one is read into memory before anything has vouched for it.
    const session = await server();
    const huge = `{"mcp.maxFlows":${'1'.repeat(70_000)}}`;
    const reply = await send(session, huge);

    expect(reply.status).toBe(413);
    expect(fs.existsSync(path.join(session.home, 'config.json'))).toBe(false);
  });

  it('refuses a body that is not a settings object', async () => {
    const session = await server();

    expect((await send(session, '{ "mcp.maxFlows": 1,, }')).status).toBe(400);
    expect((await send(session, [1, 2, 3])).status).toBe(400);
    expect((await send(session, 'null')).status).toBe(400);
    expect(fs.existsSync(path.join(session.home, 'config.json'))).toBe(false);
  });

  it('cannot be made to write anywhere but ~/.flowsnap/config.json', async () => {
    /*
     * The `SCREENSHOT_FILE` regex is the path-traversal guard on this
     * port, and the lesson taken from it here is stronger than a guard: no part
     * of the request participates in the path at all. `CONFIG_FILE` is built
     * from `HOME` at startup, and a key is either one of three known strings or
     * it is dropped — so there is no name to traverse with.
     *
     * Asserted by trying anyway, with every shape that would matter if a key or
     * a value ever did reach the filesystem.
     */
    const session = await server();
    const before = fs.readdirSync(session.home).sort();
    const outside = path.join(path.dirname(session.home), 'flowsnap-escaped');

    const reply = await send(session, {
      '../../../../tmp/flowsnap-escaped': 'no',
      '/etc/flowsnap': 'no',
      'mcp.maxFlows': '../../flowsnap-escaped',
      file: outside,
      path: outside,
      __proto__: { polluted: true },
    });

    expect(reply.status).toBe(200);
    expect(fs.readdirSync(session.home).sort()).toEqual([...before, 'config.json'].sort());
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync('/tmp/flowsnap-escaped')).toBe(false);
    // Nothing but the three keys survives, and `__proto__` is a key like any
    // other on the way in and dropped like any other on the way out.
    expect(configOf(session)).toEqual({ 'mcp.maxFlows': '../../flowsnap-escaped' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses to overwrite a config.json it cannot parse', async () => {
    /*
     * The server is already ignoring the file and saying so on stderr.
     * Replacing it here would throw away text a person wrote, to fix a problem
     * they can see and this cannot — and the keys this endpoint does not own
     * are exactly the ones that would be lost.
     */
    const session = await server('{ "mcp.maxFlows": 12,, }');
    const reply = await send(session, { 'mcp.maxFlows': 1 });

    expect(reply.status).toBe(409);
    expect(JSON.parse(reply.body).error).toContain('not valid JSON');
    expect(fs.readFileSync(path.join(session.home, 'config.json'), 'utf8')).toBe(
      '{ "mcp.maxFlows": 12,, }',
    );
  });

  it('is not there at all in remote mode', async () => {
    /*
     * Remote mode listens on 0.0.0.0, where "no Origin" is a stranger rather
     * than a local curl — and a deployment's port and disk budget belong to
     * whoever launched it, which is what environment variables are for. Spawned
     * by hand rather than through the helper: in remote mode MCP is served over
     * SSE, so there is no stdio transport for the helper to speak to.
     */
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsnap-remote-'));
    homes.push(home);
    const port = await freePort();
    const child = spawn('node', [fileURLToPath(new URL('../mcp-server/server.js', import.meta.url))], {
      env: { ...process.env, MCP_MODE: 'remote', PORT: String(port), FLOWSNAP_DIR: home },
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    try {
      await waitFor(() => fetch(`http://127.0.0.1:${port}/health`).then((res) => res.ok));

      const reply = await fetch(`http://127.0.0.1:${port}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://test' },
        body: JSON.stringify({ 'mcp.maxFlows': 1 }),
      });

      expect(reply.status).toBe(403);
      expect((await reply.json()).error).toContain('remote mode');
      expect(fs.existsSync(path.join(home, 'config.json'))).toBe(false);
    } finally {
      child.kill();
    }
  }, 20_000);
});

/** Poll until a server answers, rather than sleeping for a number chosen by feel. */
async function waitFor(ready: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await ready().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The server never answered on /health.');
}
