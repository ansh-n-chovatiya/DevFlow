// @vitest-environment jsdom
/**
 * The one place DevFlow changes what somebody else's application sends.
 *
 * `core/trace` decides *whether* a request may carry a header and is tested on
 * its own; this is about the half that can only be wrong here — that the
 * decision is actually applied to the request that goes out, that it is applied
 * to the right object, and above all that it is **not** applied in the cases
 * the rule refuses. A unit test of the rule passes just as happily against an
 * agent that ignores it.
 *
 * The agent is loaded for its side effects: it replaces `window.fetch` and
 * `window.XMLHttpRequest` at import time, so the stubs it captures have to
 * exist first. That is also what makes this test worth more than reading the
 * source — the assertions below are made against the headers the *stub*
 * received, which is the closest thing to the wire that exists without a
 * browser.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONTROL_MESSAGE_SOURCE } from '../src/shared/constants.js';

/** Every request the patched `fetch` handed on, as headers the stub saw. */
const sent: { url: string; headers: Headers }[] = [];

/**
 * A stand-in for the platform's `XMLHttpRequest`, installed before the agent so
 * that the agent wraps *this*.
 *
 * jsdom's own would attempt a real request, and the assertions here are about
 * the headers set on the object before `send` — which is exactly what a stub
 * can see and a real one would have to be intercepted to reveal. `axios` still
 * uses XHR in the browser by default, so this path is not a legacy corner.
 */
class FakeXHR {
  static readonly DONE = 4;
  url = '';
  readonly headers = new Map<string, string>();
  readonly status = 200;
  readonly responseText = '{}';

  open(_method: string, url: string): void {
    this.url = String(url);
    this.headers.clear();
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  send(): void {
    xhrSent.push({ url: this.url, headers: new Map(this.headers) });
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  getAllResponseHeaders(): string {
    return '';
  }
}

const xhrSent: { url: string; headers: Map<string, string> }[] = [];

const PAGE_ORIGIN = 'http://localhost:3000';
const OTHER_ORIGIN = 'http://localhost:8000';

beforeAll(async () => {
  // Before the import, for the same reason the `fetch` stub is: the agent binds
  // whatever is there at load and wraps it.
  window.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    // Exactly how the platform resolves it: `init.headers` wins over a
    // `Request`'s own. Getting this backwards here would hide the bug where the
    // agent writes the header somewhere `fetch` never looks.
    const headers =
      init?.headers !== undefined
        ? new Headers(init.headers)
        : input instanceof Request
          ? new Headers(input.headers)
          : new Headers();

    const url =
      typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);

    sent.push({ url, headers });
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  await import('../src/injected/agent.js');
});

/**
 * Drives the agent the way the content script does — the only supported way in.
 *
 * Dispatched rather than posted, and both fields matter: the agent refuses any
 * control message whose `source` is not this window or whose `origin` is not
 * this page's, and jsdom's own `postMessage` supplies neither. This is the same
 * shape `tests/agent-network.test.ts` uses, for the same reason.
 */
function control(message: Record<string, unknown>): Promise<void> {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { __devflow_control__: CONTROL_MESSAGE_SOURCE, ...message },
      origin: window.location.origin,
      source: window,
    }),
  );
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const tracing = (over: Record<string, unknown> = {}) =>
  control({
    recording: true,
    config: {
      trace: { devflow: true, traceparent: true, allowedOrigins: [] },
      ...over,
    },
  });

const headersFor = (url: string): Headers => {
  const found = sent.find((request) => request.url === url);
  if (!found) throw new Error(`nothing was sent to ${url}`);
  return found.headers;
};

beforeEach(() => {
  sent.length = 0;
  xhrSent.length = 0;
});

const xhrHeadersFor = (url: string): Map<string, string> => {
  const found = xhrSent.find((request) => request.url === url);
  if (!found) throw new Error(`nothing was sent to ${url}`);
  return found.headers;
};

describe('with tracing switched off, which is how it ships', () => {
  /*
   * The default, asserted first and against a request that is safe in every
   * other way — same origin, no body, nothing already traced. If this ever goes
   * green by accident, every user's traffic changes on upgrade.
   */
  it('adds nothing to a same-origin request', async () => {
    await control({
      recording: true,
      config: { trace: { devflow: false, traceparent: false, allowedOrigins: [] } },
    });
    await window.fetch(`${PAGE_ORIGIN}/api/off`);

    const headers = headersFor(`${PAGE_ORIGIN}/api/off`);
    expect(headers.get('X-DevFlow-Trace-Id')).toBeNull();
    expect(headers.get('traceparent')).toBeNull();
  });
});

describe('while a flow is being recorded', () => {
  it('adds both headers to a same-origin request', async () => {
    await tracing();
    await window.fetch(`${PAGE_ORIGIN}/api/cart`);

    const headers = headersFor(`${PAGE_ORIGIN}/api/cart`);
    const id = headers.get('X-DevFlow-Trace-Id');
    expect(id).toMatch(/^[0-9a-f]{32}$/);

    // The same id in both, which is the whole point of sending both: the
    // greppable one and the one an OpenTelemetry backend already understands
    // have to name one operation, or the two halves cannot be joined.
    const traceparent = headers.get('traceparent') ?? '';
    const [version, tracedId, spanId, flags] = traceparent.split('-');
    expect(version).toBe('00');
    expect(tracedId).toBe(id);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(flags).toBe('01');
  });

  /*
   * A fresh id per request. A trace id shared between two requests tells the
   * backend's tracing system that two unrelated operations were one — a false
   * statement written into somebody else's data, not merely a DevFlow bug.
   */
  it('mints a new id for every request', async () => {
    await tracing();
    await window.fetch(`${PAGE_ORIGIN}/api/one`);
    await window.fetch(`${PAGE_ORIGIN}/api/two`);

    const first = headersFor(`${PAGE_ORIGIN}/api/one`).get('X-DevFlow-Trace-Id');
    const second = headersFor(`${PAGE_ORIGIN}/api/two`).get('X-DevFlow-Trace-Id');
    expect(first).not.toBe(second);
  });

  /*
   * The rule the whole work stream exists for. A cross-origin request given a
   * non-safelisted header becomes non-simple, so the browser preflights it —
   * and a backend that does not allow the header fails the request outright.
   * That is the recorded application broken by DevFlow being installed.
   */
  it('adds nothing to a cross-origin request the user has not named', async () => {
    await tracing();
    await window.fetch(`${OTHER_ORIGIN}/api/cart`);

    const headers = headersFor(`${OTHER_ORIGIN}/api/cart`);
    expect(headers.get('X-DevFlow-Trace-Id')).toBeNull();
    expect(headers.get('traceparent')).toBeNull();
  });

  it('adds them to a cross-origin request once its origin is allowed', async () => {
    await tracing({ trace: { devflow: true, traceparent: false, allowedOrigins: [OTHER_ORIGIN] } });
    await window.fetch(`${OTHER_ORIGIN}/api/allowed`);

    expect(headersFor(`${OTHER_ORIGIN}/api/allowed`).get('X-DevFlow-Trace-Id')).toMatch(
      /^[0-9a-f]{32}$/,
    );
  });

  /*
   * A page that already sends `traceparent` has its own tracing, and replacing
   * it would reparent that request's spans under an id their backend has never
   * seen — corrupting a production trace tree rather than merely failing to add
   * to it.
   */
  it('leaves a request the page has already traced completely alone', async () => {
    await tracing();
    const theirs = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    await window.fetch(`${PAGE_ORIGIN}/api/theirs`, { headers: { traceparent: theirs } });

    const headers = headersFor(`${PAGE_ORIGIN}/api/theirs`);
    expect(headers.get('traceparent')).toBe(theirs);
    expect(headers.get('X-DevFlow-Trace-Id')).toBeNull();
  });

  /*
   * `init.headers` is what `fetch` reads when both are present, so a header put
   * on a rebuilt `Request` in this case would be written somewhere the platform
   * never looks — present in the recording and absent from the wire, which is
   * the worst of the available failures.
   */
  it('puts the header where fetch will actually read it when init carries headers', async () => {
    await tracing();
    await window.fetch(new Request(`${PAGE_ORIGIN}/api/both`), {
      headers: { 'content-type': 'application/json' },
    });

    const headers = headersFor(`${PAGE_ORIGIN}/api/both`);
    expect(headers.get('X-DevFlow-Trace-Id')).toMatch(/^[0-9a-f]{32}$/);
    // The page's own header survived the merge.
    expect(headers.get('content-type')).toBe('application/json');
  });

  /*
   * Measured, not assumed: `new Request(req, { headers })` marks the *original*
   * as `bodyUsed`. So a Request carrying a body is left exactly as the page
   * built it and simply goes untraced — losing a trace id is a far smaller
   * wrong than disturbing a request that was about to be sent.
   */
  it('leaves a Request that carries a body untouched', async () => {
    await tracing();
    const request = new Request(`${PAGE_ORIGIN}/api/upload`, { method: 'POST', body: 'payload' });
    await window.fetch(request);

    expect(headersFor(`${PAGE_ORIGIN}/api/upload`).get('X-DevFlow-Trace-Id')).toBeNull();
    // And the body the page built is still readable, which is the thing the
    // refusal is protecting.
    expect(request.bodyUsed).toBe(false);
  });

  it('still traces the ordinary POST, where the body is in init', async () => {
    await tracing();
    await window.fetch(`${PAGE_ORIGIN}/api/post`, { method: 'POST', body: '{"a":1}' });

    expect(headersFor(`${PAGE_ORIGIN}/api/post`).get('X-DevFlow-Trace-Id')).toMatch(
      /^[0-9a-f]{32}$/,
    );
  });
});

/**
 * A recording that shows a request without the header it actually carried is a
 * recording that disagrees with the wire — and the two transports must not
 * disagree with each other either, since a reader comparing two recordings
 * should not have to know which one made them.
 *
 * The XHR path gets this for nothing: it adds the header through the patched
 * `setRequestHeader`, which is the same function that records one. The fetch
 * path had to be told, because its header snapshot is taken before the
 * injection decision is made.
 */
describe('what the recording says the request carried', () => {
  interface Emitted {
    __devflow_source__: string;
    kind: string;
    url: string;
    traceId?: string;
    requestHeaders: Record<string, string>;
  }

  const emitted: Emitted[] = [];
  window.addEventListener('message', (event: MessageEvent<Emitted>) => {
    if (event.data?.kind === 'network') emitted.push(event.data);
  });

  const entryFor = async (url: string): Promise<Emitted> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = emitted.find((message) => message.url === url);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no network entry for ${url}`);
  };

  it('records the header it added, on the fetch path', async () => {
    await tracing();
    await window.fetch(`${PAGE_ORIGIN}/api/recorded`);

    const entry = await entryFor(`${PAGE_ORIGIN}/api/recorded`);
    expect(entry.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.requestHeaders['X-DevFlow-Trace-Id']).toBe(entry.traceId);
  });

  it('records no trace id at all on a request it did not touch', async () => {
    await tracing();
    await window.fetch(`${OTHER_ORIGIN}/api/untouched`);

    const entry = await entryFor(`${OTHER_ORIGIN}/api/untouched`);
    // Absent, not null or empty: "not traced" and "traced with nothing" are
    // different, and only the first ever happens.
    expect(entry.traceId).toBeUndefined();
    expect(entry.requestHeaders['X-DevFlow-Trace-Id']).toBeUndefined();
  });
});

describe('once the recording stops', () => {
  /*
   * The scoping that turns "DevFlow is installed" into "DevFlow is recording".
   * The patches stay on `window.fetch` for the life of the document — they are
   * installed at `document_start` on every page — so this is the only thing
   * standing between an enabled switch and every request the user ever makes
   * being modified.
   */
  it('goes back to changing nothing', async () => {
    await tracing();
    await control({ recording: false });
    await window.fetch(`${PAGE_ORIGIN}/api/after`);

    const headers = headersFor(`${PAGE_ORIGIN}/api/after`);
    expect(headers.get('X-DevFlow-Trace-Id')).toBeNull();
    expect(headers.get('traceparent')).toBeNull();
  });
});

/**
 * The XHR half, which is not a legacy corner: `axios` uses `XMLHttpRequest` in
 * the browser to this day, so an app that traces nothing over `fetch` may be
 * making every one of its calls through here.
 *
 * The mechanism is different enough to be worth its own tests rather than a
 * shared fixture — there is no request object to rebuild and no body to
 * disturb, so `setRequestHeader` does the whole job and the `canRebuild`
 * question never arises. What is the *same* is the rule, which is the point:
 * both paths ask one pure function.
 */
describe('the XMLHttpRequest path', () => {
  const openSendTo = (url: string, headers: Record<string, string> = {}): void => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.send();
  };

  it('adds nothing while tracing is off', async () => {
    // Stated rather than left to the order tests happen to run in: `applyConfig`
    // deliberately leaves a field alone when the message omits it, so `{}` means
    // "unchanged", not "off".
    await control({
      recording: true,
      config: { trace: { devflow: false, traceparent: false, allowedOrigins: [] } },
    });
    openSendTo(`${PAGE_ORIGIN}/xhr/off`);

    expect(xhrHeadersFor(`${PAGE_ORIGIN}/xhr/off`).get('x-devflow-trace-id')).toBeUndefined();
  });

  it('adds both headers to a same-origin request while recording', async () => {
    await tracing();
    openSendTo(`${PAGE_ORIGIN}/xhr/cart`);

    const headers = xhrHeadersFor(`${PAGE_ORIGIN}/xhr/cart`);
    expect(headers.get('x-devflow-trace-id')).toMatch(/^[0-9a-f]{32}$/);
    expect(headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('adds nothing to a cross-origin request the user has not named', async () => {
    await tracing();
    openSendTo(`${OTHER_ORIGIN}/xhr/cart`);

    expect(xhrHeadersFor(`${OTHER_ORIGIN}/xhr/cart`).get('x-devflow-trace-id')).toBeUndefined();
  });

  it('leaves a request the page has already traced alone', async () => {
    await tracing();
    const theirs = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    openSendTo(`${PAGE_ORIGIN}/xhr/theirs`, { traceparent: theirs });

    const headers = xhrHeadersFor(`${PAGE_ORIGIN}/xhr/theirs`);
    expect(headers.get('traceparent')).toBe(theirs);
    expect(headers.get('x-devflow-trace-id')).toBeUndefined();
  });

  /*
   * An XHR instance is reused — `open`/`send` again on the same object is how
   * most long-poll and retry loops are written, and the agent already carries a
   * comment about a bug that shape caused before. A second request through one
   * instance is a second operation, so it must not inherit the first's id: a
   * trace id shared by two requests tells the backend they were one.
   */
  it('mints a fresh id when one instance is reopened', async () => {
    await tracing();

    const xhr = new XMLHttpRequest();
    xhr.open('GET', `${PAGE_ORIGIN}/xhr/first`);
    xhr.send();
    xhr.open('GET', `${PAGE_ORIGIN}/xhr/second`);
    xhr.send();

    const first = xhrHeadersFor(`${PAGE_ORIGIN}/xhr/first`).get('x-devflow-trace-id');
    const second = xhrHeadersFor(`${PAGE_ORIGIN}/xhr/second`).get('x-devflow-trace-id');
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });
});
