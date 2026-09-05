/**
 * A bundle fetch that never answers has to end.
 *
 * `fetchText` reads the *page's* script URLs, so the host on the other end is
 * whatever the page chose to load from. `fetch` has no timeout of its own: a
 * server that completes the TCP handshake and then says nothing left the
 * resolve pass waiting forever — no error, no `skipped`, no user-visible end
 * state at all, and in the service worker a request Chrome keeps the worker
 * alive for. That is the one failure mode in this file with no upper bound, so
 * it is the one that gets a test with a clock.
 *
 * Fake timers throughout, because the assertion is about *when* it gives up and
 * a real ten-second wait in the suite would be the same bug wearing a hat.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchText } from '../src/chrome/fetch.js';
import { RESOURCE_TIMEOUT_MS } from '../src/shared/constants.js';

const URL_UNDER_TEST = 'https://cdn.example.com/app.4f2c.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

/** A promise that only ever settles when the caller's signal aborts it. */
function stallUntilAborted<T>(signal: AbortSignal | null | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DOMException('The user aborted a request.', 'AbortError'));
    });
  });
}

describe('a host that accepts the connection and never answers', () => {
  it('gives up after the budget rather than waiting forever', async () => {
    vi.useFakeTimers();
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      stallUntilAborted<Response>(init?.signal)) as unknown as typeof fetch;

    const pending = fetchText(URL_UNDER_TEST, 1024);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    // Still waiting a millisecond short of the budget: the guard is a timeout,
    // not a refusal to fetch.
    await vi.advanceTimersByTimeAsync(RESOURCE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The code every other fetch failure already uses. A code of its own would
    // be a second thing for every call site to handle to reach the same
    // conclusion — the detail is what tells a timeout from a 404.
    expect(result.error.code).toBe('RESOURCE_UNFETCHABLE');
    expect(result.error.detail).toContain(`${RESOURCE_TIMEOUT_MS}`);
  });

  it('covers the body too, not just the headers', async () => {
    vi.useFakeTimers();
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        // Headers arrive at once and then the bundle stops halfway through,
        // which hangs exactly as completely as never answering at all.
        text: () => stallUntilAborted<string>(init?.signal),
      })) as unknown as typeof fetch;

    const pending = fetchText(URL_UNDER_TEST, 1024);
    await vi.advanceTimersByTimeAsync(RESOURCE_TIMEOUT_MS + 1);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RESOURCE_UNFETCHABLE');
  });
});

describe('the guard leaves nothing behind', () => {
  it('clears the timer once the bundle has been read', async () => {
    vi.useFakeTimers();
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve('export const a = 1;'),
      })) as unknown as typeof fetch;

    const result = await fetchText(URL_UNDER_TEST, 1024);

    expect(result.ok).toBe(true);
    // A timer still armed here would fire at an `AbortController` nobody is
    // listening to, and in the worker it would be a pending task per bundle.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer on the early return for an oversized bundle', async () => {
    vi.useFakeTimers();
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'content-length' ? '99999' : null) },
        text: () => Promise.resolve(''),
      })) as unknown as typeof fetch;

    const result = await fetchText(URL_UNDER_TEST, 1024);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RESOURCE_TOO_LARGE');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('arms no timer at all for a scheme it refuses outright', async () => {
    vi.useFakeTimers();
    globalThis.fetch = () => {
      throw new Error('a refused scheme must never reach the network');
    };

    const result = await fetchText('file:///etc/passwd', 1024);

    expect(result.ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
