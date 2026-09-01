/**
 * What the document did, from the payload the extension posts to the reply a
 * tool gives.
 *
 * Every other test of this feature builds its fixture at the layer it covers:
 * the collector is driven with a real observer over a jsdom document, the
 * budget with plain objects, and `get_step_detail` with a `flow.json` written
 * straight to disk. All three are the right shape for what they cover, and
 * between them they leave the one gap that has already eaten a shipped feature
 * — `saveFlow` copies a posted payload's flow-level fields **by name**, and
 * `state` was not one of them, so every real recording arrived with its stores
 * and had them dropped on the way to disk while every fixture kept them.
 *
 * `domChanges` is a *step* field and step fields are spread, so it should
 * survive that copy. "Should" is exactly what was believed about the last one.
 * So this starts at a `POST /flows` of the shape `buildPayload` produces and
 * ends at the tool output, owning none of the layers in between.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type McpSession } from './helpers/mcp-server.js';

const BASE = Date.UTC(2026, 8, 1, 10, 0);

let home: string;
let server: McpSession;

/**
 * A payload of the shape `features/mcp/send.ts` builds.
 *
 * Written out rather than imported from `buildPayload`, because a fixture built
 * by the code under test proves only that the code agrees with itself — and
 * what is being checked is whether two separately-shipped halves still agree
 * about a field.
 */
const payload = {
  schemaVersion: 1,
  id: 'flow-dom',
  name: 'Checkout',
  timestamp: BASE,
  startUrl: 'https://shop.example.com/checkout',
  steps: [
    {
      type: 'click',
      url: 'https://shop.example.com/checkout',
      timestamp: BASE + 1000,
      action: 'Clicked "Place order"',
      stepNumber: 1,
      element: {
        tag: 'button',
        label: 'Place order',
        cssSelector: '#place-order',
        xpath: '//button[@id="place-order"]',
        boundingBox: null,
      },
      // The cheap half of the same window, kept beside the structural half so
      // the reply has to show that neither is being printed as the other.
      domDelta: { before: 'Place order', after: 'Processing…' },
      domChanges: {
        changes: [
          {
            kind: 'added',
            where: 'main#checkout',
            what: 'div#toast[role=alert] "Card declined"',
          },
          { kind: 'removed', where: 'tbody#basket', what: 'tr "Blue mug"', count: 3 },
          { kind: 'attribute', where: '#place-order', what: 'disabled=""' },
        ],
        capped: true,
        more: 4,
      },
    },
    {
      type: 'click',
      url: 'https://shop.example.com/checkout',
      timestamp: BASE + 4000,
      action: 'Clicked "Dismiss"',
      stepNumber: 2,
      element: {
        tag: 'button',
        label: 'Dismiss',
        cssSelector: '#dismiss',
        xpath: '//button[@id="dismiss"]',
        boundingBox: null,
      },
    },
  ],
};

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-dom-e2e-'));
  server = await startServer({ home });

  const posted = await server.post('/flows', JSON.stringify(payload));
  expect(posted.status).toBe(200);
}, 30_000);

afterAll(() => {
  server?.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a posted recording keeps what the document did, all the way to disk', () => {
  it('writes the field rather than dropping it in the by-name copy', () => {
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'flows', 'flow-dom', 'flow.json'), 'utf8'),
    );

    // Read off disk, not out of the reply: a renderer that reconstructed this
    // from something else would answer correctly for a flow that lost it.
    expect(onDisk.steps[0].domChanges.changes).toHaveLength(3);
    expect(onDisk.steps[0].domChanges.capped).toBe(true);
    expect(onDisk.steps[0].domChanges.more).toBe(4);
  });

  it('prints each change on its own line, in the page and on the element', () => {
    return server
      .call('get_step_detail', { id: 'flow-dom', step: 1, include: ['dom'] })
      .then((answer) => {
        expect(answer).toContain('added in main#checkout: div#toast[role=alert] "Card declined"');
        // Folded repeats keep their count, and a removal points at the parent.
        expect(answer).toContain('removed ×3 in tbody#basket: tr "Blue mug"');
        /*
         * `on` rather than `in` for an attribute, because the selector means
         * two different things. Read as `in`, this says a node was added inside
         * the button rather than that the button was disabled.
         */
        expect(answer).toContain('attribute on #place-order: disabled=""');
      });
  });

  it('keeps the text delta and the structural changes as two answers', () => {
    return server
      .call('get_step_detail', { id: 'flow-dom', step: 1, include: ['dom'] })
      .then((answer) => {
        // Neither contains the other: the region read says what the button now
        // says, and none of the three changes is about the button's text.
        expect(answer).toContain('text before: Place order');
        expect(answer).toContain('text after:  Processing…');
        // The delta is two lines and the changes are three, with a blank line
        // between: one part, two observations, neither printed as the other.
        expect(answer).toContain('Processing…\n\nadded in main#checkout');
      });
  });

  it('says the observer stopped, rather than letting the list read as complete', () => {
    return server
      .call('get_step_detail', { id: 'flow-dom', step: 1, include: ['dom'] })
      .then((answer) => {
        /*
         * The claim this feature must never make silently. A step listing three
         * changes under a cut window listed three changes *before the observer
         * stopped*, and a reader with no way to tell reads it as all of them.
         */
        expect(answer).toContain('The observer stopped early on this step');
        expect(answer).toContain('This is not a claim that nothing else changed');
        // And the overflow is a different fact from the cut: these were seen
        // and did not fit, rather than never seen at all.
        expect(answer).toContain('4 more changes were observed');
      });
  });

  it('says nothing happened only when nothing did, and names both settings', () => {
    return server
      .call('get_step_detail', { id: 'flow-dom', step: 2, include: ['dom'] })
      .then((answer) => {
        expect(answer).toContain('No change was recorded on this step');
        expect(answer).toContain('were switched off when this flow was recorded');
      });
  });

  it('prices the part in the index the way the part reads', () => {
    return server.call('get_step_detail', { id: 'flow-dom', step: 1 }).then((index) => {
      // Both halves, because a reader deciding whether to spend on this part is
      // deciding about both of them.
      expect(index).toMatch(/^ {2}dom\s+a text change, 3 changes in the page/m);
    });
  });
});
