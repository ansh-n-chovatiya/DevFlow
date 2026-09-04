/**
 * A Vue recording, from the payload the extension posts to the reply a tool gives.
 *
 * This test exists because the bug it guards was shipped and then found by
 * hand. `stepParts` was taught to render `flow.vue`, and `saveFlow` copies a
 * posted payload's flow-level fields **by name** — so the table arrived on
 * every real recording and was dropped on the way to disk, while every fixture
 * written straight onto disk kept it and passed. That is the same failure
 * `state` had before it, and the comment on that line in `mcp-server/server.js`
 * says in as many words that a reader added without its line there is the same
 * bug again.
 *
 * It was caught by building a real Vue application, driving the built extension
 * against it in a real Chromium, and asking the server what it saw. Nothing
 * cheaper would have caught it, which is why this starts at a `POST /flows` and
 * owns none of the layers in between.
 *
 * The payload's shape and its component ids are the ones that run produced.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type McpSession } from './helpers/mcp-server.js';

const BASE = Date.UTC(2026, 8, 4, 10, 0);

let home: string;
let server: McpSession;

/** As `features/mcp/send.ts` builds it, with the ids the real run minted. */
const payload = {
  schemaVersion: 1,
  id: 'flow-vue',
  name: 'Vue Real App — checkout',
  timestamp: BASE,
  startUrl: 'http://localhost:5175/',
  steps: [
    {
      type: 'click',
      url: 'http://localhost:5175/',
      timestamp: BASE + 1000,
      action: 'Clicked "Checkout"',
      stepNumber: 1,
      element: {
        tag: 'button',
        label: 'Checkout (0)',
        cssSelector: '#checkout',
        xpath: '//*[@id="checkout"]',
        boundingBox: null,
        // Outermost first, as the adapter produces it.
        frameworks: [
          { framework: 'vue', chain: ['3623646757', '5b1fc81e4e', 'da61a3be2e'] },
        ],
      },
    },
  ],
  vue: {
    detected: true,
    version: '3.5.42',
    build: 'development',
    components: {
      '3623646757': {
        name: 'App',
        status: 'resolved',
        via: 'debug-source',
        source: 'src/App.vue',
      },
      '5b1fc81e4e': {
        name: 'CartPanel',
        status: 'resolved',
        via: 'debug-source',
        source: 'src/components/CartPanel.vue',
      },
      'da61a3be2e': {
        name: 'CheckoutButton',
        status: 'resolved',
        via: 'debug-source',
        source: 'src/components/CheckoutButton.vue',
      },
    },
  },
};

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-fw-e2e-'));
  server = await startServer({ home });

  const posted = await server.post('/flows', JSON.stringify(payload));
  expect(posted.status).toBe(200);
}, 30_000);

afterAll(() => {
  server?.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a posted Vue recording keeps its component table, all the way to disk', () => {
  /*
   * Read off disk rather than out of a reply. A renderer that reconstructed the
   * names from the step's chain would answer correctly for a flow that had lost
   * the table entirely, which is precisely the state this guards against.
   */
  it('writes the flow-level table rather than dropping it in the by-name copy', () => {
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'flows', 'flow-vue', 'flow.json'), 'utf8'),
    );

    expect(onDisk.vue).toBeDefined();
    expect(onDisk.vue.detected).toBe(true);
    expect(onDisk.vue.build).toBe('development');
    expect(Object.keys(onDisk.vue.components)).toHaveLength(3);
    expect(onDisk.vue.components['da61a3be2e'].source).toBe('src/components/CheckoutButton.vue');
  });

  /* The step half travels separately, and losing either one loses the answer. */
  it('keeps the step’s chain, which is worthless without the table above', () => {
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'flows', 'flow-vue', 'flow.json'), 'utf8'),
    );
    expect(onDisk.steps[0].element.frameworks[0].framework).toBe('vue');
    expect(onDisk.steps[0].element.frameworks[0].chain).toHaveLength(3);
  });

  it('names the innermost component and its file, through the React renderer', async () => {
    const answer = await server.call('get_step_detail', {
      id: 'flow-vue',
      step: 1,
      include: ['component'],
    });

    expect(answer).toContain('vue: CheckoutButton');
    expect(answer).toContain('src/components/CheckoutButton.vue');
  });

  /*
   * Outermost first, matching `ElementReactRef.chain`'s order, so a reader does
   * not have to learn a second convention for a second framework.
   */
  it('prints the chain outermost first', async () => {
    const answer = await server.call('get_step_detail', {
      id: 'flow-vue',
      step: 1,
      include: ['component'],
    });

    expect(answer).toContain('vue chain, outermost first: App › CartPanel › CheckoutButton');
  });

  /*
   * The flow is not React and must not be described as one. Before this, a
   * recording with a full Vue table answered "this flow carries no React data",
   * which is true and useless.
   */
  it('does not answer a Vue flow with "no React data"', async () => {
    const answer = await server.call('get_step_detail', {
      id: 'flow-vue',
      step: 1,
      include: ['component'],
    });

    expect(answer).not.toContain('carries no React data');
  });
});
