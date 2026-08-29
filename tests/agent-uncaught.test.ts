// @vitest-environment jsdom
/**
 * Errors the page never printed.
 *
 * An uncaught exception and an unhandled promise rejection are reported to
 * devtools by Chrome, not by the page calling `console.error`, so the agent's
 * console interception never saw either one. A recording made *because* the app
 * threw came back with an empty console and a step that read as fine — which is
 * the worst answer available, because someone acts on it.
 *
 * Loaded for its side effects, like tests/agent-network.test.ts: importing the
 * agent is what installs the listeners.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT_MESSAGE_SOURCE } from '../src/shared/constants.js';

interface LogMessage {
  __flowsnap_source__: string;
  kind: string;
  level: string;
  args: string[];
}

const seen: LogMessage[] = [];

/** The first captured entry whose text contains `needle`, once it arrives. */
async function entryMatching(needle: string): Promise<LogMessage> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = seen.find(
      (message) => message.kind === 'log' && message.args.join(' ').includes(needle),
    );
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no console entry mentioning ${needle}`);
}

beforeAll(async () => {
  window.fetch = () => Promise.resolve(new Response('{}', { status: 200 }));

  window.addEventListener('message', (event: MessageEvent<LogMessage>) => {
    if (event.data?.__flowsnap_source__ === AGENT_MESSAGE_SOURCE) seen.push(event.data);
  });

  await import('../src/injected/agent.js');
});

describe('an uncaught exception', () => {
  it('is recorded, with the message and the frames under it', async () => {
    const error = new Error('total is undefined');
    error.stack = [
      'Error: total is undefined',
      '    at CartService.total (src/services/cart.ts:88:11)',
      '    at CartPanel.render (src/features/cart/CartPanel.tsx:41:7)',
    ].join('\n');

    window.dispatchEvent(
      new ErrorEvent('error', {
        error,
        message: 'Uncaught Error: total is undefined',
        filename: 'src/services/cart.ts',
        lineno: 88,
        colno: 11,
      }),
    );

    const entry = await entryMatching('total is undefined');
    const body = entry.args.join(' ');

    expect(entry.level).toBe('error');
    // Marked, so a reader can tell a crash from a message the app chose to print.
    expect(body).toContain('[uncaught]');
    expect(body).toContain('Error: total is undefined');
    // The frames are the reason this is worth capturing at all.
    expect(body).toContain('src/services/cart.ts:88:11');
    expect(body).toContain('src/features/cart/CartPanel.tsx:41:7');
  });

  it('falls back to the event when there is no Error object', async () => {
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'Script error.',
        filename: 'https://cdn.example.com/app.js',
        lineno: 1,
        colno: 4242,
      }),
    );

    const body = (await entryMatching('Script error.')).args.join(' ');

    // A cross-origin script gives nothing but this, and where it happened is
    // still worth more than silence.
    expect(body).toContain('[uncaught]');
    expect(body).toContain('https://cdn.example.com/app.js:1:4242');
  });

  it('ignores a failed resource load, which is not a crash', async () => {
    const image = document.createElement('img');
    document.body.appendChild(image);

    const before = seen.length;
    // A broken <img> fires `error` on the element and bubbles to window with no
    // `error` object. It is already a failed network call; filing it as a crash
    // would report a bug for a missing favicon.
    image.dispatchEvent(new Event('error', { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.slice(before).filter((m) => m.args.join(' ').includes('[uncaught]'))).toEqual([]);
  });
});

describe('an unhandled promise rejection', () => {
  it('is recorded with the reason it carried', async () => {
    const reason = new Error('payment declined');
    reason.stack = ['Error: payment declined', '    at pay (src/pay.ts:12:3)'].join('\n');

    // jsdom does not fire this on its own, and the listener is what is under
    // test — the event, not the engine that would raise it.
    window.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason, promise: Promise.resolve() }),
    );

    const body = (await entryMatching('payment declined')).args.join(' ');

    expect(body).toContain('[unhandled rejection]');
    expect(body).toContain('src/pay.ts:12:3');
  });

  it('records a rejection that carried something other than an Error', async () => {
    window.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), {
        reason: { code: 'E_NO_STOCK', sku: 'SKU-9' },
        promise: Promise.resolve(),
      }),
    );

    const body = (await entryMatching('E_NO_STOCK')).args.join(' ');

    // `throw "nope"` and `Promise.reject({...})` are both real and both used to
    // be invisible.
    expect(body).toContain('[unhandled rejection]');
    expect(body).toContain('SKU-9');
  });
});
