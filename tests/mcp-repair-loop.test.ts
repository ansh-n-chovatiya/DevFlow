/**
 * `replay_flow` and `diagnose_failure`, against the real server.
 *
 * These are Work Stream 2.4, and the v3.2.0 attempt at it was a hardcoded fake
 * diff in a file that did not parse. The two things that would make this the
 * same mistake in better prose:
 *
 *  1. **A replay that did not happen, reported as one that passed.** A repair
 *     loop asks this after a change and acts on the answer. A runner that
 *     crashed before it loaded a spec exits non-zero and prints a stack trace;
 *     a runner that matched no files prints a valid report of nothing. Both are
 *     silence, neither is a pass, and only a tool that counts failures rather
 *     than *runs* would call them one.
 *  2. **A diagnosis that names a cause.** `attributed` is temporal containment
 *     and `followed` is ordering; ranking those into "this is the fault" invents
 *     the one thing a reader most wants and least ought to be handed.
 *
 * The third thing, and the one this feature is actually for: "we have never
 * seen this fail" and "we have not seen it enough to say" are different
 * answers. They collapse into one the moment the standing sentence stops saying
 * which, and a reader handed the second as the first goes looking for a
 * regression that may not exist.
 *
 * A real replay needs Playwright in a real project, which this repo does not
 * have — so what is asserted here is every path that runs *before* the spawn,
 * including the two refusals, and the reading of a runner's output is covered
 * against fixtures in `tests/replay.test.ts`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

const BASE = Date.UTC(2026, 8, 1, 14, 0);

let home: string;
let project: string;
let server: McpSession;
let enabled: McpSession;

/** A recording with both kinds of failure in it, and a component to blame. */
function brokenFlow() {
  return {
    id: 'flow-broken',
    schemaVersion: 1,
    name: 'Checkout fails',
    timestamp: BASE,
    startUrl: 'https://shop.example.com/checkout',
    react: {
      detected: true,
      components: {
        cmp_pay: { name: 'PayButton', status: 'resolved', source: 'src/checkout/PayButton.tsx', line: 24 },
      },
    },
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/checkout',
        timestamp: BASE + 1000,
        action: 'Clicked "Place order"',
        stepNumber: 1,
        element: {
          tag: 'button',
          text: 'Place order',
          cssSelector: '#place-order',
          xpath: '//button',
          boundingBox: null,
          react: { chain: ['cmp_pay'], owner: 'cmp_pay' },
        },
        networkCalls: [
          {
            method: 'POST',
            url: 'https://api.example.com/orders',
            requestHeaders: {},
            requestBody: null,
            status: 500,
            responseHeaders: {},
            responseBody: '{"error":"card declined"}',
            durationMs: 210,
            timestamp: BASE + 1100,
          },
        ],
        consoleLogs: [
          { level: 'error', args: ['Order failed: POST /orders returned 500'], timestamp: BASE + 1200 },
        ],
      },
    ],
  };
}

/** A recording where nothing broke, so "no failures" has to be its own answer. */
function cleanFlow() {
  return {
    id: 'flow-clean',
    schemaVersion: 1,
    name: 'Checkout works',
    timestamp: BASE,
    startUrl: 'https://shop.example.com/checkout',
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/checkout',
        timestamp: BASE + 1000,
        action: 'Clicked "Place order"',
        stepNumber: 1,
        element: { tag: 'button', cssSelector: '#place-order', xpath: '//button', boundingBox: null },
      },
    ],
  };
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-repair-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-project-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });

  server = await startServer({ home, env: { DEVFLOW_PROJECT_ROOT: project } });
  // A second server with the switch thrown, so both sides of the gate are real
  // rather than one of them being argued for.
  enabled = await startServer({
    home,
    env: { DEVFLOW_PROJECT_ROOT: project, DEVFLOW_REPLAY: '1' },
  });

  writeFlow(home, brokenFlow());
  writeFlow(home, cleanFlow());
}, 40_000);

afterAll(() => {
  server?.stop();
  enabled?.stop();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe('running a recorded journey again', () => {
  it('is declared, so a client can find it', async () => {
    expect(await server.tools()).toContain('replay_flow');
  });

  it('is off until somebody switches it on, and says how', async () => {
    const answer = await server.call('replay_flow', { id: 'flow-broken' });

    /*
     * The only tool here that executes code on the machine it runs on. Off by
     * default is the decision; saying so is what stops it being a capability
     * nobody discovers.
     */
    expect(answer).toContain('Replay is switched off');
    expect(answer).toContain('DEVFLOW_REPLAY=1');
  });

  it('writes nothing into the project while it is off', () => {
    // A refusal that had already written the spec would be a refusal in name.
    expect(fs.existsSync(path.join(project, '.devflow'))).toBe(false);
  });

  it('refuses a project with no runner rather than installing one', async () => {
    const answer = await enabled.call('replay_flow', { id: 'flow-broken' });

    /*
     * `npx playwright` on a machine without it downloads and installs it. A
     * tool call is not where that decision belongs, and a harness that
     * silently reached the network on somebody's laptop would be a worse
     * surprise than the one it was avoiding.
     */
    expect(answer).toContain('No @playwright/test');
    expect(answer).toContain('will not install one');
    expect(fs.existsSync(path.join(project, '.devflow'))).toBe(false);
  });
});

describe('what broke, assembled and not concluded', () => {
  it('is declared, so a client can find it', async () => {
    expect(await server.tools()).toContain('diagnose_failure');
  });

  it('names what failed, where it was written, and the evidence behind it', async () => {
    const answer = await server.call('diagnose_failure', { id: 'flow-broken' });

    expect(answer).toContain('POST');
    expect(answer).toContain('500');
    // The component resolved to a name and a file — an id alone is unreadable,
    // and the flow already carries the table.
    expect(answer).toContain('PayButton');
    expect(answer).toContain('src/checkout/PayButton.tsx:24');
    /*
     * Every link keeps the basis it rests on, as a *labelled field* and all the
     * way to the text a model reads — dropping it reads as a stronger claim
     * than the data supports. Matched as `<basis> — <detail>` at the start of a
     * line rather than as a loose word: the first version of this assertion
     * searched the whole reply for any of the four words and stayed green when
     * the label was deleted, because the surrounding prose says them too.
     */
    expect(answer).toMatch(/^\s+attributed — /m);
    expect(answer).toMatch(/^\s+named — /m);
  });

  it('does not report one event reached twice as two pieces of evidence', async () => {
    const answer = await server.call('diagnose_failure', { id: 'flow-broken' });

    /*
     * `causesOf` walks a graph, so the click that opened the step and the
     * request that step made both lead back to the same click. Printed as they
     * arrive, `step:1` appears twice under one failure and reads as two
     * independent pieces of evidence — which is exactly the inflation a
     * diagnosis must not do, in the one place a reader is counting.
     */
    const console_ = answer.slice(answer.indexOf('step 1  console'));
    const refs = console_.match(/^ {8}step:1\b/gm) ?? [];
    expect(refs).toHaveLength(1);
  });

  it('refuses to name a cause, and says what it is doing instead', async () => {
    const answer = await server.call('diagnose_failure', { id: 'flow-broken' });

    expect(answer).toContain('Assembled, not concluded');
    expect(answer).toContain('Nothing here names a cause');
  });

  it('separates "never failed before" from "not enough history to say"', async () => {
    const answer = await server.call('diagnose_failure', { id: 'flow-broken' });

    /*
     * The line this whole feature exists for, on a graph that has seen one
     * recording. One observation is not a baseline, and the honest answer is
     * that the graph cannot judge it — not that the failure is new.
     */
    expect(answer).toContain('standing: unknown');
    expect(answer).not.toContain('standing: new');
  });

  it('says nothing failed, and that a silent bug is invisible to it', async () => {
    const answer = await server.call('diagnose_failure', { id: 'flow-clean' });

    /*
     * "Nothing failed" is a fact about the recording, not about the app. A bug
     * that produces no error and no failed request leaves this tool with
     * nothing, and a reader told only "no failures" concludes the run was fine.
     */
    expect(answer).toContain('Nothing in this recording failed');
    expect(answer).toContain('invisible to this tool');
  });
});
