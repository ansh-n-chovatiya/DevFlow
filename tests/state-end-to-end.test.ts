/**
 * State, from the payload the extension posts to the answer a tool gives.
 *
 * Every other test of this feature builds its fixture at the layer it is
 * testing: the reader is driven with hand-made fibers, the differ with plain
 * objects, and `get_state_patch` with a `flow.json` written straight to disk.
 * All three are the right shape for what they cover, and between them they left
 * one gap wide enough to lose the whole feature through — `saveFlow` listed the
 * fields it copies out of a posted payload by name, `state` was not one of
 * them, and so every real recording arrived with its stores intact and had them
 * dropped on the way to disk. Nothing failed. `get_state_patch` answered "this
 * recording carries no application state at all" for a recording that carried
 * plenty, which is one of the four answers it exists to give and was, in that
 * moment, the wrong one.
 *
 * So this file starts where the extension does — a `POST /flows` of the exact
 * shape `buildPayload` produces — and ends where Claude Code does, at the tool
 * output. It is deliberately the only test here that owns none of the layers in
 * between: a fixture that skips one of them cannot see it drop a field.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type McpSession } from './helpers/mcp-server.js';

const BASE = Date.UTC(2026, 7, 20, 9, 30);

let home: string;
let server: McpSession;

/**
 * A payload of the shape `features/mcp/send.ts` builds, state and all.
 *
 * Written out rather than imported from `buildPayload`, because a fixture built
 * by the code under test proves only that the code agrees with itself — and the
 * thing being checked here is precisely whether two separately-shipped halves
 * still agree about a field.
 */
function payload(id: string) {
  return {
    schemaVersion: 1,
    id,
    name: `Recording ${id}`,
    timestamp: BASE,
    startUrl: 'https://shop.example.com/cart',
    react: {
      detected: true,
      build: 'development',
      components: {
        cmp_badge: { name: 'CartBadge', status: 'resolved', source: 'src/CartBadge.tsx', line: 4 },
      },
    },
    state: {
      read: true,
      stores: [
        { id: 'redux:0', kind: 'redux', label: 'ReactRedux', subscribers: ['cmp_badge'] },
        { id: 'context:1', kind: 'context', label: 'ThemeContext' },
      ],
    },
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/cart',
        timestamp: BASE + 1000,
        action: 'Clicked "Add to cart"',
        stepNumber: 1,
        element: {
          tag: 'button',
          cssSelector: 'button.add',
          react: { chain: ['cmp_badge'], owner: 'cmp_badge' },
        },
        consoleLogs: [],
        networkCalls: [],
        state: [
          {
            store: 'redux:0',
            patch: [
              { op: 'replace', path: '/cart/count', value: 1 },
              { op: 'add', path: '/cart/items/-', value: { sku: 'W-1' } },
            ],
          },
        ],
      },
      {
        type: 'click',
        url: 'https://shop.example.com/cart',
        timestamp: BASE + 2000,
        action: 'Clicked "Checkout"',
        stepNumber: 2,
        element: { tag: 'button', cssSelector: 'button.checkout' },
        consoleLogs: [],
        networkCalls: [],
        state: [
          {
            store: 'redux:0',
            patch: [{ op: 'replace', path: '/checkout/status', value: 'pending' }],
            bounded: true,
            collapsed: 3,
          },
        ],
      },
    ],
  };
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-state-e2e-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  server = await startServer({ home });

  const posted = await server.post('/flows', JSON.stringify(payload('flow-state')));
  expect(posted.status).toBe(200);
});

afterAll(() => {
  server?.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a posted recording keeps its state all the way to disk', () => {
  it('writes the store roster into flow.json rather than dropping it', () => {
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'flows', 'flow-state', 'flow.json'), 'utf8'),
    ) as { state?: { read?: boolean; stores?: { id: string }[] } };

    // The assertion the whole file exists for: `saveFlow` copies named fields
    // out of the payload, and a field it forgets is lost in silence.
    expect(onDisk.state?.read).toBe(true);
    expect(onDisk.state?.stores?.map((store) => store.id)).toEqual(['redux:0', 'context:1']);
  });

  it('keeps each step\'s own patch, beside the images it moved out', () => {
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'flows', 'flow-state', 'flow.json'), 'utf8'),
    ) as { steps: { state?: { store: string; patch: unknown[] }[] }[] };

    expect(onDisk.steps[0]?.state?.[0]?.store).toBe('redux:0');
    expect(onDisk.steps[0]?.state?.[0]?.patch).toHaveLength(2);
  });
});

describe('and the tool answers from it', () => {
  it('returns the patch a real posted recording carried', async () => {
    const answer = await server.call('get_state_patch', { id: 'flow-state', step: 1 });

    expect(answer).toContain('/cart/count');
    // Not the "this recording carries no application state at all" branch,
    // which is what a dropped field produces and what reads as an answer.
    expect(answer).not.toMatch(/no application state/i);
  });

  it('surfaces the caveats the recording set, not defaults of its own', async () => {
    const answer = await server.call('get_state_patch', { id: 'flow-state', step: 2 });

    expect(answer).toMatch(/bounded/i);
    // Folded, never dropped — a reader told operations were dropped believes
    // the patch has holes in it, and it does not.
    expect(answer).toMatch(/fold/i);
    // The tool does use the word — in "Nothing was dropped", which is the
    // sentence that matters. What must never appear is the claim that
    // operations *were* dropped, which tells a reader the patch has holes.
    expect(answer).toMatch(/nothing was dropped/i);
    expect(answer).not.toMatch(/operations were dropped/i);
  });

  it('shows a component the stores it was observed reading', async () => {
    const answer = await server.call('get_component_history', { componentId: 'CartBadge' });

    /*
     * `getComponent` has returned a component's edges since the graph was
     * built and no tool printed one, so a `subscribes_to` edge was reachable
     * only by opening the database by hand — which from outside is the same
     * thing as never having written it. This is the assertion that the write
     * and the reader are one deliverable.
     */
    expect(answer).toMatch(/Reads these stores/);
    expect(answer).toMatch(/observed/);
    expect(answer).toMatch(/state_store/);
  });

  it('answers the same whether the component is named or hashed', async () => {
    const byName = await server.call('get_component_history', { componentId: 'CartBadge' });
    const byId = await server.call('get_component_history', { componentId: '#cmp_badge' });

    // Both lookups go through `getComponent`, so both carry the edges. The
    // assertion is that they still do — an answer that depends on which of two
    // equivalent arguments the caller happened to type is a difference nobody
    // can see the reason for.
    expect(byId).toBe(byName);
  });

  it('reaches the knowledge graph, and the graph says so out loud', async () => {
    const answer = await server.call('get_app_architecture', {});

    /*
     * `ingestFlow` is handed the posted object rather than the file, so this
     * would have passed even with the write bug above — which is why it is a
     * separate assertion and not a proxy for the one that matters.
     *
     * What it does catch is the other half of the same class of mistake: the
     * keys reached the database and no tool printed them, which is a node type
     * nobody can read and therefore, from outside, one that does not exist.
     */
    expect(answer).toMatch(/State keys/);
    expect(answer).toMatch(/\bcart\b/);
    expect(answer).toMatch(/\bcheckout\b/);
  });
});
