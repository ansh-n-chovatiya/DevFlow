// @vitest-environment jsdom
/**
 * What the MAIN-world agent writes down about a request.
 *
 * Loaded for its side effects — it replaces `window.fetch` at import time — so
 * the stubs it captures have to exist before it is imported, and everything it
 * reports arrives as a `postMessage`, a tick later.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_MESSAGE_SOURCE, BODY_CAP, CONTROL_MESSAGE_SOURCE } from '../src/shared/constants.js';

interface AgentMessage {
  __flowsnap_source__: string;
  kind: string;
  url: string;
  requestBody: string | null;
  requestBodyTruncated?: boolean;
  requestBodyBytes?: number;
  responseBody: string | null;
  responseBodyTruncated?: boolean;
  responseBodyBytes?: number;
}

const seen: AgentMessage[] = [];
let respondWith: () => Response;

/**
 * The entry for one request, once it arrives.
 *
 * Matched by url and never by position: the agent reports a call only after the
 * response body has been read, deliberately, so entries land in whatever order
 * the reads finish rather than in the order the requests were made.
 */
async function entryFor(url: string): Promise<AgentMessage> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = seen.find((message) => message.url === url);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no network entry for ${url}`);
}

beforeAll(async () => {
  respondWith = () =>
    new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

  window.fetch = () => Promise.resolve(respondWith());

  window.addEventListener('message', (event: MessageEvent<AgentMessage>) => {
    if (event.data?.__flowsnap_source__ === AGENT_MESSAGE_SOURCE) seen.push(event.data);
  });

  await import('../src/injected/agent.js');
});

/**
 * `fetch(new Request(url, { method, body }))` is the standard interceptor
 * pattern, and every generated API client emits it. The agent read only `init`,
 * so those POSTs were recorded as `[Request body]` — an AI reading the flow
 * concludes the request sent nothing, and the payload that caused the bug being
 * investigated is the one thing missing from the recording.
 */
describe('a body carried by a Request rather than by init', () => {
  it('is recorded, not described', async () => {
    const url = 'https://api.example.com/pay';
    await window.fetch(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"amount":100}',
      }),
    );

    const call = await entryFor(url);
    expect(call.kind).toBe('network');
    expect(call.requestBody).toBe('{"amount":100}');
  });

  it('does not make the page wait for the read', async () => {
    // The read happens after `originalFetch` has been called and after the
    // response is handed back — the whole reason it is a `.then` and not an
    // `await`. If it ever moves back in front, an upload stream hangs the page.
    const url = 'https://api.example.com/slow-upload';
    let resolved = false;
    const pending = window
      .fetch(new Request(url, { method: 'POST', body: 'x' }))
      .then(() => {
        resolved = true;
      });

    // Nothing recorded yet: the read has not even started.
    expect(seen.some((message) => message.url === url)).toBe(false);
    await pending;
    expect(resolved).toBe(true);
    expect(await entryFor(url)).toBeTruthy();
  });

  it('still prefers init.body, exactly as fetch itself resolves it', async () => {
    const url = 'https://api.example.com/both';
    await window.fetch(new Request(url, { method: 'POST', body: 'from-request' }), {
      method: 'POST',
      body: 'from-init',
    });

    expect((await entryFor(url)).requestBody).toBe('from-init');
  });

  it('records nothing for a request that has no body', async () => {
    const url = 'https://api.example.com/orders';
    await window.fetch(new Request(url));

    expect((await entryFor(url)).requestBody).toBeNull();
  });
});

/**
 * The truncation marker used to be appended inside the body string, which made
 * a truncated JSON body unparseable. At export `compactBody` saw a leading `{`,
 * `JSON.parse` threw on the marker, and a 300KB JSON API response was written
 * out as `[non-JSON · 50.0KB · truncated]` plus 300 characters — mislabelled,
 * its size understated, and never handed to the schema inference that exists
 * for exactly that body.
 */
describe('a body too large to keep whole', () => {
  it('cuts the response cleanly and says so out of band', async () => {
    const rows = `[${'{"id":1,"name":"a"},'.repeat(BODY_CAP)}]`;
    respondWith = () =>
      new Response(rows, { status: 200, headers: { 'content-type': 'application/json' } });

    const url = 'https://api.example.com/rows';
    await window.fetch(url);
    const call = await entryFor(url);

    expect(call.responseBody).toHaveLength(BODY_CAP);
    expect(call.responseBody).toBe(rows.slice(0, BODY_CAP));
    expect(call.responseBody).not.toContain('truncated');
    expect(call.responseBodyTruncated).toBe(true);
    expect(call.responseBodyBytes).toBe(rows.length);
  });

  it('leaves a body under the cap untouched and unflagged', async () => {
    respondWith = () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

    const url = 'https://api.example.com/ok';
    await window.fetch(url);
    const call = await entryFor(url);

    expect(call.responseBody).toBe('{"ok":true}');
    expect(call.responseBodyTruncated).toBeUndefined();
    expect(call.responseBodyBytes).toBeUndefined();
  });

  it('flags an oversized request body the same way', async () => {
    const url = 'https://api.example.com/upload';
    const payload = 'x'.repeat(BODY_CAP + 500);
    await window.fetch(url, { method: 'POST', body: payload });

    const call = await entryFor(url);
    expect(call.requestBody).toHaveLength(BODY_CAP);
    expect(call.requestBodyTruncated).toBe(true);
    expect(call.requestBodyBytes).toBe(payload.length);
  });
});

/**
 * Bodies switched off — `network.captureBodies`, the "single biggest privacy
 * and size lever".
 *
 * The setting is pushed into the MAIN world on the control channel, because the
 * agent has no `chrome.storage` at all. Two things have to be true of it and
 * only the first is obvious:
 *
 *   - the bodies are not recorded, and
 *   - the *absence* is stated. Nothing may make a recording silently worse.
 *     A `null` request body reads as *this POST sent nothing*, which is a claim
 *     about the page rather than about the recorder — and it is the claim a
 *     reader debugging a failed request acts on first.
 */
describe('when the user has switched body capture off', () => {
  /** Deliver a control message the way the content script does. */
  async function push(captureBodies: boolean): Promise<void> {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          __flowsnap_control__: CONTROL_MESSAGE_SOURCE,
          recording: true,
          config: { captureBodies },
        },
        origin: window.location.origin,
        source: window,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  afterEach(async () => {
    // Back on, for whatever runs next. The agent's config is module state and
    // outlives the test that changed it.
    await push(true);
  });

  it('says so instead of recording an empty body', async () => {
    await push(false);
    respondWith = () =>
      new Response('{"total":42}', { status: 200, headers: { 'content-type': 'application/json' } });

    const url = 'https://api.example.com/no-bodies';
    await window.fetch(url, { method: 'POST', body: '{"amount":100}' });
    const call = await entryFor(url);

    // The call itself is still recorded: method, URL and status are not bodies,
    // and they are most of what a flow is for.
    expect(call.kind).toBe('network');
    expect(call.requestBody).toContain('not captured');
    expect(call.responseBody).toContain('not captured');
    // Never mistakable for the data itself.
    expect(call.requestBody).not.toContain('100');
    expect(call.responseBody).not.toContain('42');
  });

  it('leaves a request that genuinely had no body reading as one', async () => {
    await push(false);

    const url = 'https://api.example.com/no-bodies-get';
    await window.fetch(url);

    // `null` means "there was nothing"; the marker means "there was something
    // and it was not kept". Collapsing the two would make the switch a way to
    // rewrite every GET in the flow as a POST that sent nothing.
    expect((await entryFor(url)).requestBody).toBeNull();
  });

  it('goes back to recording bodies when it is switched on again', async () => {
    await push(false);
    await push(true);
    respondWith = () => new Response('{"ok":true}', { status: 200 });

    const url = 'https://api.example.com/back-on';
    await window.fetch(url, { method: 'POST', body: '{"amount":100}' });
    const call = await entryFor(url);

    // Read per call, never hoisted: a config copied into a module constant at
    // import time would leave this switch stuck wherever it was first set.
    expect(call.requestBody).toBe('{"amount":100}');
  });
});
