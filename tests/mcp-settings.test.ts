/**
 * The precedence chain: **environment variable > config.json > per-flow >
 * default**, against the real server.
 *
 * This is the kind of rule that is written correctly and then quietly
 * reordered, because every layer of it produces a plausible-looking response on
 * its own — a walkthrough rendered under the wrong number is still a
 * walkthrough. So each layer is asserted while the ones below it hold a
 * *different* value: a test that only ever sets one layer at a time passes
 * against any ordering at all.
 *
 * Four settings carry the assertions because each is visible in a response
 * without measuring anything: `mcp.raw` (is the step JSON there), `mcp.maxImages`
 * (how many pictures came back), `mcp.maxConsoleEntries` (how many `⚠` lines a
 * step printed) and `mcp.maxResponseBody` (how much of a body was quoted).
 *
 * Three servers, because the environment of a process cannot be changed after
 * it has started — which is also exactly why the environment is the last word.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

/**
 * One flow, three steps, each with a screenshot, an error-heavy console and a
 * long response body — so every setting under test has something to bite on.
 *
 * `settings` is the per-flow layer: the stamp the extension writes into
 * `flow.json` from `renderedOverrides()`. Every value in it differs from this
 * build's default, so "the default won" and "the flow won" are never the same
 * answer.
 */
const STAMP = {
  'mcp.raw': true,
  'mcp.maxImages': 1,
  'mcp.maxConsoleEntries': 1,
  'mcp.maxResponseBody': 40,
};

/** Long enough that a 40-character cap and an 800-character one differ visibly. */
const BODY = JSON.stringify({ note: 'x'.repeat(600) });

function flow(id: string, settings: Record<string, unknown> | null) {
  const steps = [1, 2, 3].map((n) => ({
    type: 'click',
    url: 'https://app.example.com/orders',
    timestamp: 1_700_000_000_000 + n * 1000,
    action: `Clicked "Row ${n}"`,
    stepNumber: n,
    screenshotFile: `step-0${n}.png`,
    element: { tag: 'button', cssSelector: `#row-${n}`, xpath: `/html/body/button[${n}]` },
    consoleLogs: [1, 2, 3, 4, 5, 6, 7].map((i) => ({
      level: 'error',
      args: [`failure ${n}.${i}`],
      timestamp: 1_700_000_000_000,
    })),
    networkCalls: [
      {
        method: 'GET',
        url: 'https://api.example.com/orders',
        requestHeaders: {},
        requestBody: null,
        status: 500,
        responseHeaders: {},
        // A failed call keeps its body verbatim, so the body cap is the only
        // thing shortening it — a summarised body would prove nothing here.
        responseBody: BODY,
        durationMs: 12,
        timestamp: 1_700_000_000_000,
      },
    ],
  }));

  return {
    id,
    name: id,
    timestamp: 1_700_000_000_000,
    startUrl: 'https://app.example.com',
    errorCount: 3,
    schemaVersion: 1,
    ...(settings ? { settings } : {}),
    steps,
  };
}

/** One flow on disk, with the three screenshot files its steps name. */
function put(home: string, id: string, settings: Record<string, unknown> | null): void {
  const dir = writeFlow(home, flow(id, settings));
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  for (const n of [1, 2, 3]) {
    // A real PNG header, so nothing downstream has to pretend it is one. The
    // files have to exist: `get_flow_screenshots` skips one it cannot read, so a
    // missing file and a limit of zero produce the same empty reply.
    fs.writeFileSync(
      path.join(dir, 'screenshots', `step-0${n}.png`),
      Buffer.from('89504e470d0a1a0a', 'hex'),
    );
  }
}

/** A directory holding both flows and their screenshots. */
function makeHome(config?: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsnap-settings-'));

  put(home, 'plain', null);
  put(home, 'stamped', STAMP);

  if (config !== undefined) {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
    );
  }

  return home;
}

/** How many images a `get_flow_screenshots` reply actually carried. */
const imagesIn = (reply: string): number => (reply.match(/\*\*Step \d+\*\* — /g) ?? []).length;

/** How many console lines one step printed in the walkthrough. */
const consoleLinesIn = (reply: string): number => (reply.match(/^⚠ /gm) ?? []).length;

/** The longest quoted response body in a walkthrough. */
function longestBody(reply: string): number {
  const bodies = [...reply.matchAll(/^ {2}↳ res:\n```+\n([\s\S]*?)\n```+$/gm)].map(
    (match) => match[1].length,
  );
  return bodies.length === 0 ? 0 : Math.max(...bodies);
}

const homes: string[] = [];
const servers: McpSession[] = [];

async function server(options: { config?: unknown; env?: Record<string, string> } = {}) {
  const home = makeHome(options.config);
  homes.push(home);
  const session = await startServer({ home, env: options.env });
  servers.push(session);
  return session;
}

let bare: McpSession;
let configured: McpSession;
let overridden: McpSession;

beforeAll(async () => {
  [bare, configured, overridden] = await Promise.all([
    // Nothing above the flow.
    server(),
    // A machine that has been configured, with every value different again from
    // both the default and the stamp.
    server({
      config: {
        'mcp.raw': false,
        'mcp.maxImages': 3,
        'mcp.maxConsoleEntries': 4,
        'mcp.maxResponseBody': 300,
      },
    }),
    // The same machine, launched with an environment that disagrees with it.
    server({
      config: {
        'mcp.raw': false,
        'mcp.maxImages': 3,
        'mcp.maxConsoleEntries': 4,
        'mcp.maxResponseBody': 300,
      },
      env: {
        FLOWSNAP_RAW: 'true',
        FLOWSNAP_MAX_IMAGES: '2',
        FLOWSNAP_MAX_CONSOLE_ENTRIES: '2',
      },
    }),
  ]);
}, 30_000);

afterAll(() => {
  for (const session of servers) session.stop();
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

describe('a flow that carries no settings of its own', () => {
  it('is rendered at this build’s defaults', async () => {
    const page = await bare.call('get_flow', { id: 'plain' });
    const shots = await bare.call('get_flow_screenshots', { id: 'plain', steps: [1, 2, 3] });

    // `mcp.raw` false, `mcp.maxImages` 3, `mcp.maxConsoleEntries` 5.
    expect(page).not.toContain('```json');
    expect(imagesIn(shots)).toBe(3);
    expect(consoleLinesIn(page)).toBe(3 * 5 + 3);
  });
});

describe('per-flow beats the default', () => {
  it('renders the recording under the settings it was handed over with', async () => {
    const page = await bare.call('get_flow', { id: 'stamped' });
    const shots = await bare.call('get_flow_screenshots', { id: 'stamped', steps: [1, 2, 3] });

    expect(page).toContain('```json');
    expect(imagesIn(shots)).toBe(1);
    // One entry per step, plus each step's "+6 more".
    expect(consoleLinesIn(page)).toBe(3 * 1 + 3);
    expect(longestBody(page)).toBeLessThan(120);
  });

  it('says so in the header, so the reader knows why it looks like this', async () => {
    const page = await bare.call('get_flow', { id: 'stamped' });

    // A flow records the settings it was made under. A walkthrough quoting
    // forty characters of a body is not distinguishable from a broken capture
    // unless it says which it is.
    expect(page).toContain('Recorded with non-default settings');
    expect(page).toContain('Walkthrough body cap: 40 (default 800)');
  });

  it('leaves a flow with no stamp alone on the same server', async () => {
    // The stamp is per flow, not per server: one recording's preferences must
    // not follow the reader to the next recording they open.
    const page = await bare.call('get_flow', { id: 'plain' });

    expect(page).not.toContain('```json');
  });
});

describe('config.json beats per-flow', () => {
  it('overrides every value the flow asked for', async () => {
    const page = await configured.call('get_flow', { id: 'stamped' });
    const shots = await configured.call('get_flow_screenshots', {
      id: 'stamped',
      steps: [1, 2, 3],
    });

    // The flow asked for raw:true, 1 image, 1 console entry, a 40-char body.
    expect(page).not.toContain('```json');
    expect(imagesIn(shots)).toBe(3);
    expect(consoleLinesIn(page)).toBe(3 * 4 + 3);
    expect(longestBody(page)).toBeGreaterThan(120);
  });

  it('applies to a flow with no stamp as well', async () => {
    const page = await configured.call('get_flow', { id: 'plain' });

    expect(consoleLinesIn(page)).toBe(3 * 4 + 3);
  });
});

describe('the environment beats config.json', () => {
  it('has the last word, so a headless run is not steered by a synced file', async () => {
    const page = await overridden.call('get_flow', { id: 'stamped' });
    const shots = await overridden.call('get_flow_screenshots', {
      id: 'stamped',
      steps: [1, 2, 3],
    });

    // config.json said raw:false, 3 images, 4 console entries.
    expect(page).toContain('```json');
    expect(imagesIn(shots)).toBe(2);
    expect(consoleLinesIn(page)).toBe(3 * 2 + 3);
  });

  it('leaves the layers below it in force for a key it does not carry', async () => {
    // `FLOWSNAP_MAX_RESPONSE_BODY` is unset, so config.json's 300 still applies
    // — the chain is per key, not per layer. A layer that replaced the whole
    // object would silently reset the three settings it said nothing about.
    const page = await overridden.call('get_flow', { id: 'stamped' });

    expect(longestBody(page)).toBeGreaterThan(120);
  });
});

describe('an explicit argument still beats all four', () => {
  it.each([
    ['raw:false against a machine configured for raw', false, false],
    ['raw:true against one that is not', true, true],
  ])('%s', async (_label, raw, expected) => {
    const page = await overridden.call('get_flow', { id: 'stamped', raw });

    // The setting decides what an *omitted* argument means. A caller that says
    // what it wants is not asking for the configuration.
    expect(page.includes('```json')).toBe(expected);
  });
});

describe('what a bad value does', () => {
  it('clamps an out-of-range config value and says which value it used', async () => {
    const loud = await server({ config: { 'mcp.maxImages': 9_999 } });
    const shots = await loud.call('get_flow_screenshots', { id: 'plain', steps: [1, 2, 3] });

    expect(loud.stderr()).toContain('mcp.maxImages: 9999 is out of range — using 50');
    expect(imagesIn(shots)).toBe(3);
  });

  it('refuses an environment boolean that is neither, rather than guessing', async () => {
    // Every truthiness test in JavaScript reads `'maybe'` as `true`. Guessing
    // here would turn every response on this machine into a raw one, silently.
    const loud = await server({ env: { FLOWSNAP_RAW: 'maybe' } });
    const page = await loud.call('get_flow', { id: 'plain' });

    expect(loud.stderr()).toContain('ignoring FLOWSNAP_RAW=maybe');
    expect(page).not.toContain('```json');
  });

  it.each([
    ['false', false],
    ['0', false],
    ['off', false],
    ['1', true],
    ['yes', true],
  ])('reads FLOWSNAP_RAW=%s as a boolean', async (value, expected) => {
    const session = await server({ env: { FLOWSNAP_RAW: value } });
    const page = await session.call('get_flow', { id: 'plain' });

    expect(page.includes('```json')).toBe(expected);
  });

  it('clamps a retention cap from the file, and says which value it used', async () => {
    // The machine-wide keys go through the same `resolve` as everything else,
    // which is the point of routing them through the chain at all: a
    // hand-edited `config.json` asking for one byte is range-checked by the
    // rules the Settings screen enforces rather than by a second copy of them.
    const loud = await server({ config: { 'mcp.maxFlowBytes': 1 } });
    await loud.call('get_flow', { id: 'plain' });

    expect(loud.stderr()).toContain('mcp.maxFlowBytes: 1 is out of range — using 67108864');
  });

  it('ignores a malformed config.json and keeps serving', async () => {
    const broken = await server({ config: '{ "mcp.raw": true,, }' });
    const page = await broken.call('get_flow', { id: 'plain' });

    expect(broken.stderr()).toContain('is not valid JSON');
    // Not fatal: the flows on disk are still readable, and a client that cannot
    // start this server gets no error message at all.
    expect(page).toContain('### 1. ');
    expect(page).not.toContain('```json');
  });

  it('resolves a stamp the same way the Settings screen would', async () => {
    /*
     * `flow.json` arrives over an unauthenticated loopback POST that any page
     * the user visits can reach, so a stamp is exactly as trustworthy as the
     * rest of the flow. Going through `resolve` — the extension's own, bundled
     * in — is what makes that harmless, and the two rules it applies are
     * different and both matter here: a value of the wrong type falls back to
     * the default, because there is no nearest legal answer to guess at; a
     * number out of range is clamped, because there is.
     */
    const home = makeHome();
    put(home, 'hostile', { 'mcp.maxImages': 'lots', 'mcp.maxConsoleEntries': -3 });
    homes.push(home);
    const session = await startServer({ home });
    servers.push(session);

    const shots = await session.call('get_flow_screenshots', { id: 'hostile', steps: [1, 2, 3] });
    const page = await session.call('get_flow', { id: 'hostile' });

    expect(imagesIn(shots)).toBe(3);
    // Clamped to zero — and every step still says what the cap swallowed,
    // rather than reading as a step that logged nothing.
    expect(consoleLinesIn(page)).toBe(3);
    expect(page).toContain('… +7 more');
  });
}, 30_000);

describe('the machine-wide half of the chain', () => {
  /*
   * The three keys Phase 5 delivered. They are not visible in a rendered flow
   * the way the other six are — a port is either bound or it is not, and a
   * retention cap is a thing that happens on the next save — so they are
   * asserted on the two surfaces that can show them: the socket, and stderr.
   */

  it('binds the port config.json names', async () => {
    // Started with no FLOWSNAP_PORT at all, so the file is the only thing that
    // can have decided this. `/health` answering there is the whole assertion:
    // an extension that cannot reach the port sees exactly nothing.
    const port = await freePort();
    const home = makeHome({ 'mcp.port': port });
    homes.push(home);
    const session = await startServer({ home, portFromConfig: port });
    servers.push(session);

    const health = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.json());
    expect(health).toMatchObject({ service: 'flowsnap-mcp', mode: 'local' });
    expect(session.stderr()).toContain(`listening on ${port}`);
  });

  it('lets the environment beat the file on the port, as it does everywhere else', async () => {
    // The environment is the last word because a headless run must not be
    // steered by whatever a browser once synced. Asserted here because the port
    // is the one setting where losing that argument means nothing answers.
    const wanted = await freePort();
    const loud = await server({ config: { 'mcp.port': wanted } });

    expect(loud.stderr()).toContain(`listening on ${loud.port}`);
    expect(loud.stderr()).not.toContain(`listening on ${wanted}`);
  });

  it('evicts by the cap in the file rather than the shipped one', async () => {
    /*
     * `MAX_FLOWS` was `Number(process.env.FLOWSNAP_MAX_FLOWS) || 200` and
     * nothing else, which the plan calls effectively unreachable: setting it
     * meant editing the launcher of a process the user never starts by hand.
     *
     * The two flows `makeHome` writes are already on disk, so a cap of one and
     * a third flow arriving is enough to see the sweep choose.
     */
    const session = await server({ config: { 'mcp.maxFlows': 1 } });
    const posted = await session.post(
      '/flows',
      JSON.stringify({ id: 'newest', name: 'newest', timestamp: 1_700_000_100_000, steps: [] }),
    );

    expect(posted.status).toBe(200);
    expect(JSON.parse(posted.body).evicted).toEqual(expect.arrayContaining(['plain', 'stamped']));
    expect(await session.call('list_flows', {})).toContain('newest');
  });
}, 30_000);

describe('the tool descriptions name what this installation actually does', () => {
  it('quotes the configured image limit, not the compiled-in one', async () => {
    const listed = await overridden.tools();

    // The description is written once, at startup, for every flow at once — so
    // it can only honestly name the machine's answer. A hardcoded 3 would be a
    // number the server had stopped using.
    expect(listed).toContain('for at most 2 steps per call');
  });

  it('says raw is on where it is on', async () => {
    expect(await overridden.tools()).toContain('On by default here');
    expect(await bare.tools()).toContain('Off by default');
  });
});
